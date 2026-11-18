import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { encodeAbiParameters, getAbiItem, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  MARKET_FEATURES,
  type OrryFeature,
  ORDER_MODES,
  aggregatorV3Abi,
  iFeeTiersAbi,
  iOrryPriceOracleAbi,
  iSealedBatchMarketAbi,
  maskAddress,
  type BatchResult,
  type BatchStatus,
  type BatchView,
  type BatchesResponse,
  type FeeTierTable,
  type FeeTiersResponse,
  type MarketPhase,
  type MarketResponse,
  type MarketSummary,
  type MarketsResponse,
  type OrderFill,
  type OrderMode,
  type OrderTerms,
  type RelayRevealResponse,
  type RelayStatus,
  type RevealedOrder,
  type RevealedStatus,
  type StockPrice,
  type WalletOrder,
  type WalletOrderStatus,
  type WalletOrdersResponse,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { ttlCache, type OrryRouteDeps } from "./orry-api.js";
import { releasesFor } from "./releases.js";

/**
 * `/v1/markets/` routes (`docs/ORRY-R1-SPEC.md` section 5; shapes in `@orrery/shared` markets.ts). Open while any of
 * the release switch features stocks, swap, darkpool is open; otherwise every route answers the 404 of an unknown route.
 * Batch and order views are measured at the indexer's height: their statuses use that block's time, so an order never
 * reads "missed" while its reveal is still on its way to the confirmation depth. Countdowns use the chain's latest time.
 */

const READ_FAILED = "Chain read failed. Retry in a few seconds.";

const commitmentInputs = getAbiItem({ abi: iSealedBatchMarketAbi, name: "commitmentFor" }).inputs;
/** keccak256(abi.encode(batch, account, order, salt)), as the market's `commitmentFor` (same as the SDK's). */
export function orderCommitmentOf(
  batch: bigint,
  account: Address,
  order: { sellAsset: boolean; amountIn: bigint; limitPrice: bigint; mode: OrderMode; payFeeInOrry: boolean },
  salt: Hex,
): Hex {
  return keccak256(encodeAbiParameters(commitmentInputs, [batch, account, { ...order, mode: ORDER_MODES.indexOf(order.mode) } as never, salt]));
}

interface MarketRow {
  market: string;
  asset: string;
  price_feed: string;
  usdg: string;
  symbol: string;
  name: string;
  decimals: number;
  reveal_end0: string;
  period: string;
  commit_seconds: number;
  reveal_seconds: number;
  fee_bps: number;
  min_notional: string;
  commit_fee_usd: string;
  max_staleness: number;
  max_orders: number;
  expiry_seconds: string;
  created_block: string;
  remainder_pool_id: string;
  remainder_listed: boolean;
  max_deviation_bps: number;
  orry_fee_discount_bps: number;
  fee_tiers: string;
}

interface BatchRow {
  batch: string;
  commits: number;
  reveals: number;
  commit_fees: string;
  cleared: boolean;
  price: string | null;
  round_id: string | null;
  asset_filled: string | null;
  usdg_filled: string | null;
  usdg_fees: string;
  orry_fees: string;
  asset_via_pool: string;
  usdg_via_pool: string;
  filled: number;
  dropped: number;
  cleared_tx: string | null;
  cleared_block: string | null;
  cleared_at: string | null;
  expired: boolean;
}

interface OrderRow {
  market: string;
  batch: string;
  account: string;
  commitment: string;
  commit_tx: string;
  committed_at: string;
  commit_fee: string;
  revealed: boolean;
  sell_asset: boolean | null;
  amount_in: string | null;
  limit_price: string | null;
  mode: number | null;
  pay_fee_in_orry: boolean | null;
  reveal_tx: string | null;
  outcome: "filled" | "dropped" | null;
  input_used: string | null;
  output: string | null;
  usdg_fee: string | null;
  orry_fee: string | null;
  fill_tx: string | null;
}

/** Batch n's windows, from the market's own revealEnd(0) and revealEnd(1). */
function windows(m: MarketRow, batch: bigint) {
  const revealEndsAt = BigInt(m.reveal_end0) + batch * BigInt(m.period);
  return {
    commitEndsAt: Number(revealEndsAt - BigInt(m.reveal_seconds)),
    revealEndsAt: Number(revealEndsAt),
    expiresAt: Number(revealEndsAt + BigInt(m.expiry_seconds)),
  };
}

export function phaseAt(m: MarketRow, now: number): MarketPhase {
  const end0 = BigInt(m.reveal_end0);
  const period = BigInt(m.period);
  const t = BigInt(now);
  const batch = t < end0 ? 0n : (t - end0) / period + 1n;
  const w = windows(m, batch);
  const inCommit = now < w.commitEndsAt;
  return { batch: batch.toString(), inCommit, endsAt: inCommit ? w.commitEndsAt : w.revealEndsAt };
}

function batchStatus(m: MarketRow, b: Pick<BatchRow, "cleared" | "expired">, batch: bigint, at: number): BatchStatus {
  const w = windows(m, batch);
  if (b.cleared) return "cleared";
  if (b.expired || at >= w.expiresAt) return "expired";
  if (at < w.commitEndsAt) return "commit";
  if (at < w.revealEndsAt) return "reveal";
  return "clearing";
}

const terms = (o: OrderRow): OrderTerms => ({
  sellAsset: o.sell_asset!,
  amountIn: o.amount_in!,
  limitPrice: o.limit_price!,
  mode: ORDER_MODES[o.mode!] ?? "limit",
  payFeeInOrry: o.pay_fee_in_orry!,
});

const fillOf = (o: OrderRow): OrderFill | null =>
  o.outcome === "filled"
    ? { inputUsed: o.input_used!, output: o.output!, usdgFee: o.usdg_fee!, orryFee: o.orry_fee!, tx: o.fill_tx as Hex }
    : null;

function revealedStatus(o: OrderRow, status: BatchStatus): RevealedStatus {
  if (o.outcome === "dropped") return "dropped";
  if (o.outcome === "filled") return BigInt(o.input_used!) > 0n ? "filled" : "unfilled";
  if (status === "cleared") return "unfilled";
  if (status === "expired") return "expired";
  return "revealed";
}

export function registerMarketRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: OrryRouteDeps): void {
  const mc = cfg.markets;
  const cache = ttlCache(mc?.cacheMs ?? 10_000);
  const clock = ttlCache(1_000); // block times: countdowns stay within a second
  // The runtime release switch (releases.ts), as on the ORRY routes: the market routes open once any of stocks, swap
  // or darkpool is open by the server clock; while all are held they answer the 404 of an unknown route.
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  const anyOpen = async (features: readonly string[]) => {
    for (const f of features) if (await releases.isOpen(f as OrryFeature)) return true;
    return false;
  };
  const open = async () => Boolean(mc) && (await anyOpen(MARKET_FEATURES));
  const gate = async (req: FastifyRequest, reply: FastifyReply) => {
    let ok: boolean;
    try {
      ok = await open();
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
    if (!ok) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
  };
  async function guarded<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  }

  /** Latest block time (countdowns, price freshness). */
  const chainTime = () => clock("time:latest", async () => Number((await chain.public.getBlock()).timestamp));
  /** Time of the block the market tables are complete through; null before the first indexer step. A block's time never
   * changes, so it is cached by number and the cursor itself is read fresh. */
  const blockTime = new Map<bigint, number>();
  async function indexedTime(): Promise<number | null> {
    const [s] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = 'markets'`;
    if (!s || BigInt(s.last_block) < 0n) return null;
    const n = BigInt(s.last_block);
    let ts = blockTime.get(n);
    if (ts === undefined) {
      ts = Number((await chain.public.getBlock({ blockNumber: n })).timestamp);
      if (blockTime.size > 64) blockTime.clear();
      blockTime.set(n, ts);
    }
    return ts;
  }

  const feedDecimals = new Map<string, number>();
  type Round = { roundId: bigint; answer: bigint; updatedAt: bigint };
  async function latestRounds(feeds: Address[]): Promise<(Round | null)[]> {
    const need = [...new Set(feeds.map((f) => f.toLowerCase()))].filter((f) => !feedDecimals.has(f)) as Address[];
    const contracts = [
      ...feeds.map((f) => ({ address: f, abi: aggregatorV3Abi, functionName: "latestRoundData" as const })),
      ...need.map((f) => ({ address: f, abi: aggregatorV3Abi, functionName: "decimals" as const })),
    ];
    // Multicall3 where the chain has it (4663): the whole list in one eth_call; otherwise one call per feed.
    const res: { status: "success" | "failure"; result?: unknown }[] = mc!.multicall
      ? ((await chain.public.multicall({ contracts, allowFailure: true, multicallAddress: mc!.multicall })) as never)
      : await Promise.all(
          contracts.map((c) =>
            chain.public.readContract(c as never).then((result) => ({ status: "success" as const, result }), () => ({ status: "failure" as const })),
          ),
        );
    need.forEach((f, i) => {
      const r = res[feeds.length + i];
      if (r?.status === "success") feedDecimals.set(f.toLowerCase(), Number(r.result));
    });
    return feeds.map((_, i) => {
      const r = res[i];
      if (r?.status !== "success") return null;
      const [roundId, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
      return { roundId, answer, updatedAt };
    });
  }

  function priceOf(m: MarketRow, r: Round | null, now: number): StockPrice {
    const decimals = feedDecimals.get(m.price_feed) ?? 8;
    if (!r || r.answer <= 0n) return { feed: getAddress(m.price_feed), answer: null, decimals, roundId: r ? r.roundId.toString() : null, updatedAt: r ? Number(r.updatedAt) : null, fresh: false };
    return {
      feed: getAddress(m.price_feed),
      answer: r.answer.toString(),
      decimals,
      roundId: r.roundId.toString(),
      updatedAt: Number(r.updatedAt),
      fresh: now - Number(r.updatedAt) <= m.max_staleness,
    };
  }

  function summary(m: MarketRow, r: Round | null, now: number): MarketSummary {
    return {
      market: getAddress(m.market),
      asset: { address: getAddress(m.asset), symbol: m.symbol, name: m.name, decimals: m.decimals },
      usdg: getAddress(m.usdg),
      price: priceOf(m, r, now),
      params: {
        commitSeconds: m.commit_seconds,
        revealSeconds: m.reveal_seconds,
        feeBps: m.fee_bps,
        minNotionalUsdg: m.min_notional,
        commitFeeUsd: m.commit_fee_usd,
        maxStaleness: m.max_staleness,
        maxOrders: m.max_orders,
        expirySeconds: Number(m.expiry_seconds),
        maxDeviationBps: m.max_deviation_bps,
        orryFeeDiscountBps: m.orry_fee_discount_bps,
      },
      phase: phaseAt(m, now),
      remainderPool: { poolId: m.remainder_pool_id as Hex, listed: m.remainder_listed },
      feeTiers: getAddress(m.fee_tiers),
      createdBlock: Number(m.created_block),
    };
  }

  const allMarkets = () =>
    sql<MarketRow[]>`select market, asset, price_feed, usdg, symbol, name, decimals, reveal_end0::text, period::text, commit_seconds,
      reveal_seconds, fee_bps, min_notional::text, commit_fee_usd::text, max_staleness, max_orders, expiry_seconds::text, created_block::text,
      remainder_pool_id, remainder_listed, max_deviation_bps, orry_fee_discount_bps, fee_tiers
      from markets order by created_block desc, market asc`;
  async function marketRow(raw: string): Promise<MarketRow | undefined> {
    if (!isAddress(raw)) return undefined;
    return (await allMarkets()).find((m) => m.market === raw.toLowerCase());
  }

  function batchView(m: MarketRow, b: BatchRow, at: number, orders: OrderRow[] | null): BatchView {
    const n = BigInt(b.batch);
    const w = windows(m, n);
    const status = batchStatus(m, b, n, at);
    const result: BatchResult | null = b.cleared
      ? {
          price: b.price!,
          roundId: b.round_id!,
          assetFilled: b.asset_filled!,
          usdgFilled: b.usdg_filled!,
          assetViaPool: b.asset_via_pool,
          usdgViaPool: b.usdg_via_pool,
          usdgFees: b.usdg_fees,
          orryFeesBurned: b.orry_fees,
          ordersFilled: b.filled,
          ordersDropped: b.dropped,
          ordersUnfilled: b.reveals - b.filled - b.dropped,
          tx: b.cleared_tx as Hex,
          block: Number(b.cleared_block),
          time: Number(b.cleared_at),
        }
      : null;
    return {
      market: getAddress(m.market),
      batch: b.batch,
      ...w,
      status,
      commits: b.commits,
      reveals: b.reveals,
      commitFeesBurned: b.commit_fees,
      result,
      orders:
        orders && at >= w.revealEndsAt
          ? orders
              .filter((o) => o.revealed)
              .map((o): RevealedOrder => ({ ...terms(o), account: maskAddress(o.account), status: revealedStatus(o, status), fill: fillOf(o) }))
          : null,
    };
  }

  const batchColumns = () => sql`batch::text, commits, reveals, commit_fees::text, cleared, price::text, round_id::text, asset_filled::text,
    usdg_filled::text, usdg_fees::text, orry_fees::text, asset_via_pool::text, usdg_via_pool::text, filled, dropped, cleared_tx, cleared_block::text,
    extract(epoch from cleared_time)::bigint::text as cleared_at, expired`;
  const orderColumns = () => sql`market, batch::text, account, commitment, commit_tx, extract(epoch from committed_at)::bigint::text as committed_at,
    commit_fee::text, revealed, sell_asset, amount_in::text, limit_price::text, mode, pay_fee_in_orry, reveal_tx, outcome, input_used::text,
    output::text, usdg_fee::text, orry_fee::text, fill_tx`;

  // ---------------------------------------------------------------- markets and prices
  app.get("/v1/markets", { preHandler: gate }, async (_req, reply) =>
    guarded(reply, () =>
      cache("markets", async (): Promise<MarketsResponse> => {
        const [rows, now] = await Promise.all([allMarkets(), chainTime()]);
        const rounds = rows.length ? await latestRounds(rows.map((m) => getAddress(m.price_feed))) : [];
        return { markets: rows.map((m, i) => summary(m, rounds[i] ?? null, now)), chainTime: now, updatedAt: new Date().toISOString() };
      }),
    ),
  );

  app.get<{ Params: { market: string } }>("/v1/markets/:market", { preHandler: gate }, async (req, reply) => {
    const m = await marketRow(req.params.market).catch(() => undefined);
    if (!m) return reply.code(404).send({ error: "No market exists at this address." });
    return guarded(reply, () =>
      cache(`market:${m.market}`, async (): Promise<MarketResponse> => {
        const now = await chainTime();
        const [r] = await latestRounds([getAddress(m.price_feed)]);
        return { ...summary(m, r ?? null, now), chainTime: now, updatedAt: new Date().toISOString() };
      }),
    );
  });

  // ---------------------------------------------------------------- fee tiers (L2, thresholds in USD)
  app.get<{ Querystring: { account?: string } }>("/v1/markets/fee-tiers", { preHandler: gate }, async (req, reply) => {
    const raw = req.query.account;
    if (raw !== undefined && !isAddress(raw)) return reply.code(400).send({ error: "account expects a 0x address." });
    const account = raw === undefined ? null : getAddress(raw);
    return guarded(reply, () =>
      cache(`tiers:${account?.toLowerCase() ?? ""}`, async (): Promise<FeeTiersResponse> => {
        const addresses = [...new Set((await allMarkets()).map((m) => m.fee_tiers))].map((a) => getAddress(a));
        const tables = await Promise.all(
          addresses.map(async (address): Promise<FeeTierTable> => {
            const t = <T>(functionName: string, args: unknown[] = []) =>
              chain.public.readContract({ address, abi: iFeeTiersAbi, functionName, args } as never) as Promise<T>;
            const [orryPrice, count] = await Promise.all([t<Address>("orryPrice"), t<bigint>("tierCount")]);
            const [active, tiers, mine] = await Promise.all([
              chain.public.readContract({ address: orryPrice, abi: iOrryPriceOracleAbi, functionName: "ready" }),
              Promise.all(Array.from({ length: Number(count) }, (_, i) => t<readonly [bigint, number]>("tier", [BigInt(i)]))),
              account ? Promise.all([t<bigint>("stakeUsd", [account]), t<number>("discountBps", [account])]) : Promise.resolve(null),
            ]);
            return {
              address,
              orryPrice: getAddress(orryPrice),
              active,
              tiers: tiers.map(([minStakeUsd, discountBps]) => ({ minStakeUsd: minStakeUsd.toString(), discountBps: Number(discountBps) })),
              account: account && mine ? { address: account, stakeUsd: mine[0].toString(), discountBps: Number(mine[1]) } : null,
            };
          }),
        );
        return { tables, usdDecimals: 6, updatedAt: new Date().toISOString() };
      }),
    );
  });

  // ---------------------------------------------------------------- batches
  app.get<{ Params: { market: string }; Querystring: { limit?: string; before?: string } }>(
    "/v1/markets/:market/batches",
    { preHandler: gate },
    async (req, reply) => {
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return reply.code(400).send({ error: "limit must be between 1 and 100." });
      const before = req.query.before;
      if (before !== undefined && !/^\d{1,30}$/.test(before)) return reply.code(400).send({ error: "before expects a batch number." });
      const m = await marketRow(req.params.market).catch(() => undefined);
      if (!m) return reply.code(404).send({ error: "No market exists at this address." });
      return guarded(reply, () =>
        cache(`batches:${m.market}:${limit}:${before ?? ""}`, async (): Promise<BatchesResponse> => {
          const at = (await indexedTime()) ?? 0;
          const rows = await sql<BatchRow[]>`select ${batchColumns()} from market_batches where market = ${m.market}
            ${before !== undefined ? sql`and batch < ${before}::numeric` : sql``} order by market_batches.batch desc limit ${limit}`;
          return { market: getAddress(m.market), batches: rows.map((b) => batchView(m, b, at, null)), updatedAt: new Date().toISOString() };
        }),
      );
    },
  );

  app.get<{ Params: { market: string; batch: string } }>("/v1/markets/:market/batches/:batch", { preHandler: gate }, async (req, reply) => {
    if (!/^\d{1,30}$/.test(req.params.batch)) return reply.code(400).send({ error: "batch must be a whole number." });
    const m = await marketRow(req.params.market).catch(() => undefined);
    if (!m) return reply.code(404).send({ error: "No market exists at this address." });
    const batch = req.params.batch.replace(/^0+(?=\d)/, "");
    return guarded(reply, () =>
      cache(`batch:${m.market}:${batch}`, async (): Promise<BatchView> => {
        const at = (await indexedTime()) ?? 0;
        const [[b], orders] = await Promise.all([
          sql<BatchRow[]>`select ${batchColumns()} from market_batches where market = ${m.market} and batch = ${batch}::numeric`,
          sql<OrderRow[]>`select ${orderColumns()} from market_orders where market = ${m.market} and batch = ${batch}::numeric
            order by market_orders.account`,
        ]);
        const empty: BatchRow = {
          batch, commits: 0, reveals: 0, commit_fees: "0", cleared: false, price: null, round_id: null, asset_filled: null, usdg_filled: null,
          usdg_fees: "0", orry_fees: "0", asset_via_pool: "0", usdg_via_pool: "0", filled: 0, dropped: 0, cleared_tx: null, cleared_block: null,
          cleared_at: null, expired: false,
        };
        return batchView(m, b ?? empty, at, orders);
      }),
    );
  });

  // ---------------------------------------------------------------- per-wallet history
  app.get<{ Params: { address: string }; Querystring: { limit?: string; before?: string } }>(
    "/v1/markets/accounts/:address/orders",
    { preHandler: gate },
    async (req, reply) => {
      if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Expected a 0x address." });
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: "limit must be between 1 and 200." });
      const before = req.query.before;
      if (before !== undefined && !/^\d{1,20}$/.test(before)) return reply.code(400).send({ error: "before expects a block number." });
      const address = getAddress(req.params.address);
      return guarded(reply, () =>
        cache(`orders:${address.toLowerCase()}:${limit}:${before ?? ""}`, async (): Promise<WalletOrdersResponse> => {
          const at = (await indexedTime()) ?? 0;
          const [rows, markets] = await Promise.all([
            sql<(OrderRow & { cleared: boolean; expired: boolean })[]>`select ${orderColumns()}, b.cleared, b.expired
              from market_orders join market_batches b using (market, batch)
              where account = ${address.toLowerCase()} ${before !== undefined ? sql`and commit_block < ${before}::bigint` : sql``}
              order by market_orders.commit_block desc, market_orders.market asc limit ${limit}`,
            allMarkets(),
          ]);
          const byAddr = new Map(markets.map((m) => [m.market, m]));
          const orders = rows.map((o): WalletOrder => {
            const m = byAddr.get(o.market)!;
            const n = BigInt(o.batch);
            const w = windows(m, n);
            const b = { cleared: o.cleared, expired: o.expired };
            const status: WalletOrderStatus = o.revealed ? revealedStatus(o, batchStatus(m, b, n, at)) : at < w.revealEndsAt ? "committed" : "missed";
            return {
              market: getAddress(o.market),
              asset: getAddress(m.asset),
              symbol: m.symbol,
              batch: o.batch,
              status,
              commitment: o.commitment as Hex,
              commitTx: o.commit_tx as Hex,
              committedAt: Number(o.committed_at),
              commitFeeBurned: o.commit_fee,
              revealEndsAt: w.revealEndsAt,
              order: o.revealed ? terms(o) : null,
              revealTx: (o.reveal_tx as Hex | null) ?? null,
              fill: fillOf(o),
            };
          });
          return { address, orders, updatedAt: new Date().toISOString() };
        }),
      );
    },
  );

  // ---------------------------------------------------------------- opt-in reveal relay
  // Open with swap or darkpool. The API only checks and queues; the relay process (bin/market-relay.ts) holds the key
  // and sends revealFor in the reveal window. A queued salt is never returned by any route.
  const relayOpen = async () => Boolean(mc) && (await anyOpen(["swap", "darkpool"]));
  const allowRelay = deps.makeLimiter(30);
  const relayGate = async (req: FastifyRequest, reply: FastifyReply) => {
    let ok: boolean;
    try {
      ok = await relayOpen();
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
    if (!ok) return reply.callNotFound();
    if (!allowRelay(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
  };
  const uint = z.string().regex(/^\d{1,78}$/, "expects digits only");
  const relayBody = z
    .object({
      market: z.string().refine((v) => isAddress(v), "expects a 0x address"),
      batch: z.string().regex(/^\d{1,30}$/),
      account: z.string().refine((v) => isAddress(v), "expects a 0x address"),
      order: z
        .object({ sellAsset: z.boolean(), amountIn: uint, limitPrice: uint, mode: z.enum(["limit", "swap"]), payFeeInOrry: z.boolean() })
        .strict(),
      salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .strict();

  async function relayView(m: MarketRow, batch: string, account: string): Promise<RelayRevealResponse | null> {
    const [r] = await sql<{ status: RelayStatus; tx: string | null; reason: string | null }[]>`select status, tx, reason from market_relay
      where market = ${m.market} and batch = ${batch}::numeric and account = ${account.toLowerCase()}`;
    if (!r) return null;
    const w = windows(m, BigInt(batch));
    return {
      market: getAddress(m.market),
      batch,
      account: getAddress(account),
      status: r.status,
      revealsFrom: w.commitEndsAt,
      revealsBy: w.revealEndsAt,
      tx: (r.tx as Hex | null) ?? null,
      reason: r.reason,
    };
  }

  app.post("/v1/markets/relay/reveals", { preHandler: relayGate }, async (req, reply) => {
    const parsed = relayBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Required fields: market, batch, account, order, salt." });
    const body = parsed.data;
    const m = await marketRow(body.market).catch(() => undefined);
    if (!m) return reply.code(404).send({ error: "No market exists at this address." });
    const batch = body.batch.replace(/^0+(?=\d)/, "");
    const order = { ...body.order, amountIn: BigInt(body.order.amountIn), limitPrice: BigInt(body.order.limitPrice) };
    if (order.amountIn === 0n) return reply.code(400).send({ error: "Set an amount above 0 for the order." });
    const account = getAddress(body.account);
    try {
      const now = await chainTime();
      const w = windows(m, BigInt(batch));
      if (now >= w.revealEndsAt) return reply.code(409).send({ error: "The reveal period for this batch has ended." });
      const onChain = (await chain.public.readContract({
        address: getAddress(m.market),
        abi: iSealedBatchMarketAbi,
        functionName: "commitmentOf",
        args: [BigInt(batch), account],
      })) as Hex;
      const mine = orderCommitmentOf(BigInt(batch), account, order, body.salt as Hex);
      if (onChain.toLowerCase() !== mine.toLowerCase()) {
        return reply.code(400).send({ error: "Order and salt disagree with the commitment this account made in this batch." });
      }
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
    await sql`insert into market_relay (market, batch, account, sell_asset, amount_in, limit_price, mode, pay_fee_in_orry, salt)
      values (${m.market}, ${batch}, ${account.toLowerCase()}, ${order.sellAsset}, ${order.amountIn.toString()}, ${order.limitPrice.toString()},
        ${ORDER_MODES.indexOf(order.mode)}, ${order.payFeeInOrry}, ${body.salt.toLowerCase()}) on conflict do nothing`;
    return reply.code(202).send(await relayView(m, batch, account));
  });

  app.get<{ Params: { market: string; batch: string; account: string } }>(
    "/v1/markets/relay/reveals/:market/:batch/:account",
    { preHandler: relayGate },
    async (req, reply) => {
      if (!/^\d{1,30}$/.test(req.params.batch) || !isAddress(req.params.account)) return reply.code(400).send({ error: "Expected a whole batch number and a 0x account address." });
      const m = await marketRow(req.params.market).catch(() => undefined);
      if (!m) return reply.code(404).send({ error: "No market exists at this address." });
      const view = await relayView(m, req.params.batch.replace(/^0+(?=\d)/, ""), req.params.account);
      if (!view) return reply.code(404).send({ error: "No queued reveal exists for this order." });
      return view;
    },
  );
}
