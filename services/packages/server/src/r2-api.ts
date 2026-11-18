import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  aggregatorV3Abi,
  iLimitOrderBookAbi,
  iMarketFactoryAbi,
  iOrryPaymasterAbi,
  iOrreryShieldAbi,
  iSealedBatchMarketAbi,
  type LimitOrderStatus,
  type LimitOrderSubmitResponse,
  type LimitOrderView,
  type LimitOrdersResponse,
  type PaymasterResponse,
  type PaymasterView,
  type PredictMarketResponse,
  type PredictMarketView,
  type PredictMarketsResponse,
  type PredictStatus,
  type R2AccountResponse,
  type ReleaseFeature,
  type ShieldEventJson,
  type ShieldEventsResponse,
  type ShieldInfo,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { ttlCache, type OrryRouteDeps } from "./orry-api.js";
import { releasesFor } from "./releases.js";

/**
 * `/v1/r2/` routes (lane L3, `docs/updates/L3-R2-SPEC.md` section 7; shapes in `@orrery/shared` r2.ts). Each group opens
 * with its release (`predict`, `limit-orders`, `paymaster`) and its contract configured; otherwise it answers the 404 of
 * an unknown route. `GET /v1/r2/accounts/:address` (positions, stored orders, prepaid gas) is never held.
 */

const READ_FAILED = "Chain read failed. Retry in a few seconds.";
const ENTRY_POINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const MAX_EXPIRY_SECONDS = 30 * 86_400;

const OrderBody = z.object({
  owner: z.string().refine(isAddress, "owner expects a 0x address"),
  asset: z.string().refine(isAddress, "asset expects a 0x address"),
  sellAsset: z.boolean(),
  amountIn: z.string().regex(/^[1-9]\d{0,37}$/, "amountIn expects a positive whole number of base units"),
  limitPrice: z.string().regex(/^[1-9]\d{0,40}$/, "limitPrice expects a positive whole number"),
  tipBps: z.number().int().min(0).max(100),
  payFeeInOrry: z.boolean(),
  nonce: z.string().regex(/^\d{1,78}$/, "nonce expects a whole number"),
  expiry: z.number().int().positive(),
  signature: z.string().refine((s) => isHex(s) && s.length >= 132 && s.length <= 4098, "signature expects a hex string"),
});

interface PredictRow {
  market: string;
  feed: string;
  asset: string;
  strike: string;
  close_time: string;
  lock_time: string;
  created_at: string;
  status: "open" | "yes" | "no" | "refund";
  yes_pool: string;
  no_pool: string;
  stakers: number;
  settle_price: string | null;
  fee_bps: number;
  min_stake: string;
  description: string | null;
  decimals: number | null;
}

interface OrderRow {
  order_hash: string;
  owner: string;
  asset: string;
  sell_asset: boolean;
  amount_in: string;
  limit_price: string;
  tip_bps: number;
  pay_fee_in_orry: boolean;
  nonce: string;
  expiry: string;
  status: "open" | "filled" | "cancelled";
  amount_out: string | null;
  usdg_fee: string | null;
  orry_fee: string | null;
  tip: string | null;
  fill_tx: string | null;
  created_at: Date;
  symbol: string | null;
}

export function registerR2Routes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: OrryRouteDeps): void {
  const r2 = cfg.r2;
  const cache = ttlCache(r2?.cacheMs ?? 10_000);
  const clock = ttlCache(1_000);
  const allowOrder = deps.makeLimiter(r2?.orderRatePerMinute ?? 20);
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  const configured = (f: ReleaseFeature) =>
    !!r2 &&
    (f === "predict" ? !!r2.predictFactory : f === "limit-orders" ? !!r2.limitBook : f === "paymaster" ? r2.paymasters.length > 0 : f === "shield" ? !!r2.shield : false);
  const gate = (feature: ReleaseFeature, limit: (ip: string) => boolean = deps.allowPublic) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!configured(feature)) return reply.callNotFound();
    let open: boolean;
    try {
      open = await releases.isOpen(feature);
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
    if (!open) return reply.callNotFound();
    if (!limit(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
  };
  async function guarded<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  }
  const chainTime = () => clock("time", async () => Number((await chain.public.getBlock()).timestamp));

  // ---------------------------------------------------------------- predict
  const predictRows = (where?: string) =>
    sql<PredictRow[]>`select m.market, m.feed, m.asset, m.strike::text, m.close_time::text, m.lock_time::text,
        extract(epoch from m.created_time)::bigint::text as created_at, m.status, m.yes_pool::text, m.no_pool::text, m.stakers,
        m.settle_price::text, m.fee_bps, m.min_stake::text, f.description, f.decimals
      from predict_markets m left join predict_feeds f on f.feed = m.feed
      ${where ? sql`where m.market = ${where}` : sql``}
      order by m.close_time asc limit 500`;

  async function latest(feed: string): Promise<{ answer: string; updatedAt: number } | null> {
    return cache(`feed:${feed}`, async () => {
      try {
        const [, answer, , updatedAt] = await chain.public.readContract({ address: getAddress(feed), abi: aggregatorV3Abi, functionName: "latestRoundData" });
        return { answer: answer.toString(), updatedAt: Number(updatedAt) };
      } catch {
        return null;
      }
    });
  }

  const statusOf = (r: PredictRow, now: number): PredictStatus => {
    if (r.status !== "open") return r.status;
    if (now >= Number(r.close_time)) return "closed";
    return now >= Number(r.lock_time) ? "locked" : "open";
  };

  async function view(r: PredictRow, now: number): Promise<PredictMarketView> {
    return {
      market: r.market,
      feed: r.feed,
      asset: /^0x0{40}$/.test(r.asset) ? null : r.asset,
      label: r.description ?? "Price feed",
      strike: r.strike,
      decimals: r.decimals ?? 8,
      closeTime: Number(r.close_time),
      lockTime: Number(r.lock_time),
      createdAt: Number(r.created_at),
      status: statusOf(r, now),
      yesPool: r.yes_pool,
      noPool: r.no_pool,
      stakers: r.stakers,
      settlePrice: r.settle_price,
      feeBps: r.fee_bps,
      minStake: r.min_stake,
      latest: await latest(r.feed),
    };
  }

  app.get("/v1/r2/predict", { preHandler: gate("predict") }, async (_req, reply) =>
    guarded(reply, () =>
      cache("predict", async (): Promise<PredictMarketsResponse> => {
        const [rows, now] = await Promise.all([predictRows(), chainTime()]);
        return { markets: await Promise.all(rows.map((r) => view(r, now))), chainTime: now, updatedAt: new Date().toISOString() };
      }),
    ),
  );

  app.get<{ Params: { market: string } }>("/v1/r2/predict/:market", { preHandler: gate("predict") }, async (req, reply) => {
    if (!isAddress(req.params.market)) return reply.code(400).send({ error: "market expects a 0x address." });
    const key = req.params.market.toLowerCase();
    return guarded(reply, async () => {
      const [rows, now] = await Promise.all([predictRows(key), chainTime()]);
      const r = rows[0];
      if (!r) return reply.code(404).send({ error: "No market exists at this address." });
      const body: PredictMarketResponse = { ...(await view(r, now)), chainTime: now, updatedAt: new Date().toISOString() };
      return body;
    });
  });

  // ---------------------------------------------------------------- limit orders
  const bookParams = () =>
    cache("book", async () => {
      const book = r2!.limitBook!;
      const [feeBps, maxDeviationBps, factory] = await Promise.all([
        chain.public.readContract({ address: book, abi: iLimitOrderBookAbi, functionName: "feeBps" }),
        chain.public.readContract({ address: book, abi: iLimitOrderBookAbi, functionName: "maxDeviationBps" }),
        chain.public.readContract({ address: book, abi: iLimitOrderBookAbi, functionName: "marketFactory" }),
      ]);
      return { feeBps: Number(feeBps), maxDeviationBps: Number(maxDeviationBps), factory: factory as Address };
    });

  const orderStatus = (r: OrderRow, now: number): LimitOrderStatus =>
    r.status === "open" && Number(r.expiry) < now ? "expired" : r.status;

  const orderView = (r: OrderRow, now: number): LimitOrderView => ({
    hash: r.order_hash,
    owner: r.owner,
    asset: r.asset,
    symbol: r.symbol ?? "",
    sellAsset: r.sell_asset,
    amountIn: r.amount_in,
    limitPrice: r.limit_price,
    tipBps: r.tip_bps,
    payFeeInOrry: r.pay_fee_in_orry,
    nonce: r.nonce,
    expiry: Number(r.expiry),
    status: orderStatus(r, now),
    createdAt: r.created_at.toISOString(),
    fill:
      r.status === "filled" && r.fill_tx
        ? { amountOut: r.amount_out ?? "0", usdgFee: r.usdg_fee ?? "0", orryFee: r.orry_fee ?? "0", tip: r.tip ?? "0", tx: r.fill_tx }
        : null,
  });

  const ordersOf = (owner: string) =>
    sql<OrderRow[]>`select o.order_hash, o.owner, o.asset, o.sell_asset, o.amount_in::text, o.limit_price::text, o.tip_bps, o.pay_fee_in_orry,
        o.nonce::text, o.expiry::text, o.status, o.amount_out::text, o.usdg_fee::text, o.orry_fee::text, o.tip::text, o.fill_tx, o.created_at,
        (select symbol from markets where asset = o.asset limit 1) as symbol
      from limit_orders o where o.owner = ${owner} order by o.created_at desc limit 200`;

  app.get<{ Querystring: { owner?: string } }>("/v1/r2/limit-orders", { preHandler: gate("limit-orders") }, async (req, reply) => {
    const owner = req.query.owner;
    if (owner !== undefined && !isAddress(owner)) return reply.code(400).send({ error: "owner expects a 0x address." });
    return guarded(reply, async () => {
      const [p, now, rows] = await Promise.all([bookParams(), chainTime(), owner ? ordersOf(owner.toLowerCase()) : Promise.resolve([] as OrderRow[])]);
      const body: LimitOrdersResponse = {
        orders: rows.map((r) => orderView(r, now)),
        book: r2!.limitBook!,
        feeBps: p.feeBps,
        maxDeviationBps: p.maxDeviationBps,
        updatedAt: new Date().toISOString(),
      };
      return body;
    });
  });

  app.post("/v1/r2/limit-orders", { preHandler: gate("limit-orders", allowOrder), bodyLimit: 16_384 }, async (req, reply) => {
    const parsed = OrderBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "The order fields are malformed." });
    const o = parsed.data;
    const book = r2!.limitBook!;
    const order = {
      owner: getAddress(o.owner),
      asset: getAddress(o.asset),
      sellAsset: o.sellAsset,
      amountIn: BigInt(o.amountIn),
      limitPrice: BigInt(o.limitPrice),
      tipBps: o.tipBps,
      payFeeInOrry: o.payFeeInOrry,
      nonce: BigInt(o.nonce),
      expiry: BigInt(o.expiry),
    };
    if (order.amountIn > (1n << 128n) - 1n) return reply.code(400).send({ error: "amountIn exceeds the 128 bit maximum." });
    try {
      const now = await chainTime();
      if (o.expiry <= now) return reply.code(400).send({ error: "This order's expiry is already in the past." });
      if (o.expiry > now + MAX_EXPIRY_SECONDS) return reply.code(400).send({ error: "Set an expiry no more than 30 days ahead." });
      const p = await bookParams();
      const market = await chain.public.readContract({ address: p.factory, abi: iMarketFactoryAbi, functionName: "marketOf", args: [order.asset] });
      if (/^0x0{40}$/i.test(market)) return reply.code(400).send({ error: "Limit orders are not offered for this asset." });
      const [, listed] = await chain.public.readContract({ address: market, abi: iSealedBatchMarketAbi, functionName: "remainderPool" });
      if (!listed) return reply.code(400).send({ error: "Limit orders are not offered for this asset." });
      const [hash, used] = await Promise.all([
        chain.public.readContract({ address: book, abi: iLimitOrderBookAbi, functionName: "hashOrder", args: [order] }),
        chain.public.readContract({ address: book, abi: iLimitOrderBookAbi, functionName: "nonceUsed", args: [order.owner, order.nonce] }),
      ]);
      if (used) return reply.code(409).send({ error: "This nonce has been spent. Sign the order with a fresh one." });
      // EOAs by recovery, smart accounts through ERC-1271 (viem's verifyHash)
      const valid = await chain.public.verifyHash({ address: order.owner, hash: hash as Hex, signature: o.signature as Hex }).catch(() => false);
      if (!valid) return reply.code(400).send({ error: "Signature and order fields disagree." });
      const owner = order.owner.toLowerCase();
      const [open] = await sql<{ n: number }[]>`select count(*)::int as n from limit_orders where owner = ${owner} and status = 'open' and expiry > ${now}`;
      if ((open?.n ?? 0) >= r2!.maxOpenOrdersPerOwner) return reply.code(429).send({ error: "This wallet holds the most open orders allowed. Cancel one to place another." });
      const ins = await sql`insert into limit_orders (order_hash, book, owner, asset, sell_asset, amount_in, limit_price, tip_bps, pay_fee_in_orry,
          nonce, expiry, signature)
        values (${(hash as string).toLowerCase()}, ${book.toLowerCase()}, ${owner}, ${order.asset.toLowerCase()}, ${order.sellAsset},
          ${o.amountIn}, ${o.limitPrice}, ${o.tipBps}, ${o.payFeeInOrry}, ${o.nonce}, ${o.expiry}, ${o.signature.toLowerCase()})
        on conflict do nothing returning 1`;
      if (ins.length !== 1) return reply.code(409).send({ error: "This order is already on record." });
      const body: LimitOrderSubmitResponse = { hash: (hash as string).toLowerCase(), status: "open" };
      return reply.code(201).send(body);
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  });

  // ---------------------------------------------------------------- paymaster
  async function paymasterView(pm: Address): Promise<PaymasterView> {
    const [entryPoint, params, rate] = await Promise.all([
      chain.public.readContract({ address: pm, abi: iOrryPaymasterAbi, functionName: "entryPoint" }),
      chain.public.readContract({ address: pm, abi: iOrryPaymasterAbi, functionName: "params" }),
      chain.public.readContract({ address: pm, abi: iOrryPaymasterAbi, functionName: "cachedRate" }),
    ]);
    const [r, at] = rate as readonly [bigint, bigint | number];
    const p = params as { premiumBps: number; maxCostWei: bigint; maxRateAge: number };
    return {
      paymaster: pm.toLowerCase(),
      entryPoint: String(entryPoint).toLowerCase(),
      version: String(entryPoint).toLowerCase() === ENTRY_POINT_V07 ? "0.7" : "0.8",
      premiumBps: Number(p.premiumBps),
      maxCostWei: p.maxCostWei.toString(),
      rate: r === 0n ? null : r.toString(),
      rateAt: Number(at) === 0 ? null : Number(at),
      maxRateAge: Number(p.maxRateAge),
    };
  }

  app.get("/v1/r2/paymaster", { preHandler: gate("paymaster") }, async (_req, reply) =>
    guarded(reply, () =>
      cache("paymaster", async (): Promise<PaymasterResponse> => ({
        paymasters: await Promise.all(r2!.paymasters.map(paymasterView)),
        updatedAt: new Date().toISOString(),
      })),
    ),
  );

  // ---------------------------------------------------------------- shield
  app.get("/v1/r2/shield", { preHandler: gate("shield") }, async (_req, reply) =>
    guarded(reply, () =>
      cache("shield", async (): Promise<ShieldInfo> => {
        const pool = r2!.shield!;
        const read = (functionName: string) =>
          chain.public.readContract({ address: pool, abi: iOrreryShieldAbi, functionName } as never) as Promise<unknown>;
        const [asset, depositFeeBps, withdrawFeeBps, leaves] = await Promise.all([read("asset"), read("depositFeeBps"), read("withdrawFeeBps"), read("nextLeafIndex")]);
        const [d] = await sql<{ n: number }[]>`select count(*)::int as n from r2_events where address = ${pool.toLowerCase()} and event = 'Deposited'`;
        return {
          pool: pool.toLowerCase(),
          asset: String(asset).toLowerCase(),
          depositFeeBps: Number(depositFeeBps),
          withdrawFeeBps: Number(withdrawFeeBps),
          leaves: Number(leaves),
          deposits: d?.n ?? 0,
          updatedAt: new Date().toISOString(),
        };
      }),
    ),
  );

  // Never held: a wallet rebuilds its notes from these, in chain order, to find and withdraw them.
  const SHIELD_PAGE = 500;
  app.get<{ Querystring: { after?: string } }>("/v1/r2/shield/events", async (req, reply) => {
    if (!r2?.shield) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
    const after = req.query.after ?? "0:-1";
    const m = /^(\d{1,20}):(-?\d{1,9})$/.exec(after);
    if (!m) return reply.code(400).send({ error: "after expects <block>:<log index>, taken from the previous page." });
    const [block, index] = [m[1]!, Number(m[2])];
    return guarded(reply, async () => {
      const rows = await sql<{ block_number: string; log_index: number; event: string; args: Record<string, unknown> }[]>`
        select block_number::text, log_index, event, args from r2_events
        where address = ${r2.shield!.toLowerCase()} and event in ('Deposited', 'NewCommitment', 'NewNullifier')
          and (block_number, log_index) > (${block}::bigint, ${index})
        order by block_number, log_index limit ${SHIELD_PAGE}`;
      const events: ShieldEventJson[] = rows.map((r) => {
        const a = r.args;
        if (r.event === "Deposited")
          return { type: "Deposited", depositor: String(a.depositor).toLowerCase(), amount: String(a.amount), fee: String(a.fee), secretCommit: String(a.secretCommit),
            commitment: String(a.commitment), leafIndex: Number(a.leafIndex), encryptedNote: String(a.encryptedNote) };
        if (r.event === "NewCommitment")
          return { type: "NewCommitment", commitment: String(a.commitment), leafIndex: Number(a.leafIndex), encryptedNote: String(a.encryptedNote) };
        return { type: "NewNullifier", nullifier: String(a.nullifier) };
      });
      const last = rows.at(-1);
      const body: ShieldEventsResponse = {
        events,
        cursor: last ? `${last.block_number}:${last.log_index}` : req.query.after ?? null,
        done: rows.length < SHIELD_PAGE,
      };
      return body;
    });
  });

  // ---------------------------------------------------------------- account (never held)
  app.get<{ Params: { address: string } }>("/v1/r2/accounts/:address", async (req, reply) => {
    if (!r2) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
    if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Expected a 0x address." });
    const address = req.params.address.toLowerCase();
    return guarded(reply, async () => {
      const [positions, orders, ops, now] = await Promise.all([
        sql<{ market: string; yes: string; no: string; claimed: boolean; payout: string | null }[]>`select market, yes::text, no::text, claimed, payout::text
          from predict_positions where account = ${address} order by market`,
        r2.limitBook ? ordersOf(address) : Promise.resolve([] as OrderRow[]),
        sql<{ paymaster: string; ops: number; charged: string }[]>`select paymaster, ops, charged::text from paymaster_accounts where account = ${address}`,
        chainTime(),
      ]);
      const gas = await Promise.all(
        r2.paymasters.map(async (pm) => {
          const balance = await chain.public.readContract({ address: pm, abi: iOrryPaymasterAbi, functionName: "balanceOf", args: [getAddress(address)] });
          const row = ops.find((o) => o.paymaster === pm.toLowerCase());
          return { paymaster: pm.toLowerCase(), balance: (balance as bigint).toString(), ops: row?.ops ?? 0, charged: row?.charged ?? "0" };
        }),
      );
      const body: R2AccountResponse = {
        address,
        predict: positions.map((p) => ({ market: p.market, yes: p.yes, no: p.no, claimed: p.claimed, payout: p.payout })),
        limitOrders: orders.map((r) => orderView(r, now)),
        gas,
        updatedAt: new Date().toISOString(),
      };
      return body;
    });
  });
}
