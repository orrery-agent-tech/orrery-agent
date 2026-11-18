import type postgres from "postgres";
import { decodeEventLog, type Abi, type Address, type Hex, type Log } from "viem";
import { erc20MetaAbi, iMarketFactoryAbi, iSealedBatchMarketAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { toJson } from "./check.js";
import { blockTimes } from "./orry-indexer.js";

/**
 * Wave R1 markets indexer (`docs/ORRY-R1-SPEC.md` section 5, workspace rule 7). Per range of at most 10,000 confirmed
 * blocks: one `eth_getLogs` for the factory, then one for every market it has created (a market created inside the range
 * is read in the same step). Indexes to `head - confirmations`; events, derived tables and the cursor change in one
 * database transaction.
 */

const STATE_ID = "markets";
const MARKET_ABI = iSealedBatchMarketAbi as Abi; // includes Burned (ISealedBatchMarket extends IOrryBurnEvents)
type Tx = postgres.TransactionSql<{}>;
type Args = Record<string, unknown>;

const lower = (a: unknown) => String(a).toLowerCase();
const str = (v: unknown) => String(v);

interface NewMarket {
  market: Address;
  asset: Address;
  priceFeed: Address;
  usdg: Address;
  symbol: string;
  name: string;
  decimals: number;
  revealEnd0: bigint;
  period: bigint;
  commitSeconds: number;
  revealSeconds: number;
  feeBps: number;
  minNotional: bigint;
  commitFeeUsd: bigint;
  maxStaleness: number;
  maxOrders: number;
  expirySeconds: bigint;
  remainderPoolId: Hex;
  remainderListed: boolean;
  maxDeviationBps: number;
  orryFeeDiscountBps: number;
  feeTiers: Address;
}

/** The constructor values a market exposes (it has no setters), read once when the factory creates it. */
async function readMarket(chain: Chain, market: Address, asset: Address, remainderPoolId: Hex): Promise<NewMarket> {
  const m = (functionName: string, args: unknown[] = []) =>
    chain.public.readContract({ address: market, abi: iSealedBatchMarketAbi, functionName, args } as never) as Promise<unknown>;
  const t = (functionName: "symbol" | "name" | "decimals") => chain.public.readContract({ address: asset, abi: erc20MetaAbi, functionName });
  const [priceFeed, usdg, end0, end1, commitSeconds, revealSeconds, feeBps, minNotional, commitFeeUsd, maxStaleness, maxOrders, expiry, pool, maxDev, symbol, name, decimals, orryDiscount, feeTiers] =
    await Promise.all([
      m("priceFeed"), m("usdg"), m("revealEnd", [0n]), m("revealEnd", [1n]), m("commitSeconds"), m("revealSeconds"), m("feeBps"),
      m("minNotionalUsdg"), m("commitFeeUsd"), m("maxStaleness"), m("MAX_ORDERS"), m("EXPIRY"), m("remainderPool"), m("maxDeviationBps"),
      t("symbol"), t("name"), t("decimals"), m("orryFeeDiscountBps"), m("feeTiers"),
    ]);
  return {
    market,
    asset,
    priceFeed: priceFeed as Address,
    usdg: usdg as Address,
    symbol: symbol as string,
    name: name as string,
    decimals: Number(decimals),
    revealEnd0: BigInt(end0 as bigint),
    period: BigInt(end1 as bigint) - BigInt(end0 as bigint),
    commitSeconds: Number(commitSeconds),
    revealSeconds: Number(revealSeconds),
    feeBps: Number(feeBps),
    minNotional: BigInt(minNotional as bigint),
    commitFeeUsd: BigInt(commitFeeUsd as bigint),
    maxStaleness: Number(maxStaleness),
    maxOrders: Number(maxOrders),
    expirySeconds: BigInt(expiry as bigint),
    remainderPoolId,
    remainderListed: (pool as readonly [unknown, boolean])[1],
    maxDeviationBps: Number(maxDev),
    orryFeeDiscountBps: Number(orryDiscount),
    feeTiers: feeTiers as Address,
  };
}

async function upsertBatch(tx: Tx, market: string, batch: string) {
  await tx`insert into market_batches (market, batch) values (${market}, ${batch}) on conflict do nothing`;
}

/** The pool leg of a cleared batch (R1b) is only in `result(batch)`, read at the clearing block. */
type ViaPool = Map<string, { asset: bigint; usdg: bigint }>;

async function apply(tx: Tx, event: string, a: Args, log: Log, time: Date, viaPool: ViaPool): Promise<void> {
  const market = lower(log.address);
  const batch = a.batch === undefined ? null : str(a.batch);
  switch (event) {
    case "Committed":
      await upsertBatch(tx, market, batch!);
      await tx`insert into market_orders (market, batch, account, commitment, commit_tx, commit_block, committed_at, commit_fee)
        values (${market}, ${batch}, ${lower(a.account)}, ${lower(a.commitment)}, ${log.transactionHash!}, ${log.blockNumber!.toString()},
          ${time}, ${str(a.orryBurned)})`;
      await tx`update market_batches set commits = commits + 1, commit_fees = commit_fees + ${str(a.orryBurned)}::numeric
        where market = ${market} and batch = ${batch}`;
      return;
    case "Revealed": {
      const o = a.order as { sellAsset: boolean; amountIn: unknown; limitPrice: unknown; mode: unknown; payFeeInOrry: boolean };
      const r = await tx`update market_orders set revealed = true, sell_asset = ${o.sellAsset}, amount_in = ${str(o.amountIn)},
          limit_price = ${str(o.limitPrice)}, mode = ${Number(o.mode)}, pay_fee_in_orry = ${o.payFeeInOrry}, reveal_tx = ${log.transactionHash!}
        where market = ${market} and batch = ${batch} and account = ${lower(a.account)} and not revealed returning 1`;
      if (r.length !== 1) throw new Error(`Revealed without a commitment: ${market} batch ${batch} ${lower(a.account)}`);
      await tx`update market_batches set reveals = reveals + 1 where market = ${market} and batch = ${batch}`;
      return;
    }
    case "OrderDropped":
      await tx`update market_orders set outcome = 'dropped' where market = ${market} and batch = ${batch} and account = ${lower(a.account)}`;
      await tx`update market_batches set dropped = dropped + 1 where market = ${market} and batch = ${batch}`;
      return;
    case "OrderFilled": {
      const used = str(a.inputUsed);
      await tx`update market_orders set outcome = 'filled', input_used = ${used}, output = ${str(a.output)}, usdg_fee = ${str(a.usdgFee)},
          orry_fee = ${str(a.orryFee)}, fill_tx = ${log.transactionHash!}
        where market = ${market} and batch = ${batch} and account = ${lower(a.account)}`;
      await tx`update market_batches set usdg_fees = usdg_fees + ${str(a.usdgFee)}::numeric, orry_fees = orry_fees + ${str(a.orryFee)}::numeric,
          filled = filled + ${BigInt(used) > 0n ? 1 : 0} where market = ${market} and batch = ${batch}`;
      return;
    }
    case "BatchCleared": {
      await upsertBatch(tx, market, batch!);
      const pool = viaPool.get(`${market}:${batch}`) ?? { asset: 0n, usdg: 0n };
      await tx`update market_batches set cleared = true, price = ${str(a.price)}, round_id = ${str(a.roundId)}, asset_filled = ${str(a.assetFilled)},
          usdg_filled = ${str(a.usdgFilled)}, asset_via_pool = ${pool.asset.toString()}, usdg_via_pool = ${pool.usdg.toString()},
          cleared_tx = ${log.transactionHash!}, cleared_block = ${log.blockNumber!.toString()}, cleared_time = ${time}
        where market = ${market} and batch = ${batch}`;
      return;
    }
    case "BatchExpired":
      await upsertBatch(tx, market, batch!);
      await tx`update market_batches set expired = true where market = ${market} and batch = ${batch}`;
      return;
    default:
      // Burned (sources 5 and 6) is read from market_events by the burns route.
      return;
  }
}

function decode(abi: Abi, log: Log): { event: string; args: Args } {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics });
    return { event: d.eventName ?? "unknown", args: toJson(d.args) as Args };
  } catch {
    return { event: "unknown", args: { topics: log.topics.join(","), data: log.data } };
  }
}

/** One step: index up to `range` confirmed blocks. */
export async function indexMarketsOnce(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  opts: { range?: bigint } = {},
): Promise<{ last: bigint; head: bigint; lag: bigint; logs: number }> {
  const mc = cfg.markets;
  if (!mc) throw new Error("ORRERY_MARKET_FACTORY is not configured");
  const range = opts.range ?? 10_000n;
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : mc.startBlock;
  const head = await chain.public.getBlockNumber();
  const depth = BigInt(cfg.confirmations);
  const safe = head > depth ? head - depth : 0n;
  if (from > safe) {
    await sql`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${(from - 1n).toString()}, ${head.toString()})
      on conflict (id) do update set head_block = excluded.head_block, updated_at = now()`;
    return { last: from - 1n, head, lag: head - (from - 1n), logs: 0 };
  }
  const to = from + range - 1n < safe ? from + range - 1n : safe;

  const factoryLogs = (await chain.public.getLogs({ address: mc.factory, fromBlock: from, toBlock: to })) as Log[];
  const created: NewMarket[] = [];
  for (const log of factoryLogs) {
    const d = decode(iMarketFactoryAbi as Abi, log);
    if (d.event === "MarketCreated") created.push(await readMarket(chain, d.args.market as Address, d.args.asset as Address, d.args.remainderPoolId as Hex));
  }
  const known = (await sql<{ market: string }[]>`select market from markets`).map((r) => r.market as Address);
  const addresses = [...known, ...created.map((c) => c.market)];
  const marketLogs = addresses.length ? ((await chain.public.getLogs({ address: addresses, fromBlock: from, toBlock: to })) as Log[]) : [];
  const all = [...factoryLogs, ...marketLogs].sort((x, y) =>
    x.blockNumber! === y.blockNumber! ? x.logIndex! - y.logIndex! : x.blockNumber! < y.blockNumber! ? -1 : 1,
  );
  const times = await blockTimes(chain, all);
  const viaPool: ViaPool = new Map();
  for (const log of marketLogs) {
    const d = decode(MARKET_ABI, log);
    if (d.event !== "BatchCleared") continue;
    const r = (await chain.public.readContract({
      address: log.address,
      abi: iSealedBatchMarketAbi,
      functionName: "result",
      args: [BigInt(str(d.args.batch))],
      blockNumber: log.blockNumber!,
    })) as { assetViaPool: bigint; usdgViaPool: bigint };
    viaPool.set(`${lower(log.address)}:${str(d.args.batch)}`, { asset: r.assetViaPool, usdg: r.usdgViaPool });
  }
  const createdBy = new Map(created.map((c) => [c.market.toLowerCase(), c]));
  const factory = mc.factory.toLowerCase();

  await sql.begin(async (tx) => {
    for (const log of all) {
      const fromFactory = log.address.toLowerCase() === factory;
      const { event, args } = decode(fromFactory ? (iMarketFactoryAbi as Abi) : MARKET_ABI, log);
      const time = times.get(log.blockNumber!)!;
      const ins = await tx`insert into market_events (block_number, log_index, tx_hash, address, event, args, block_time)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${log.address.toLowerCase()}, ${event},
          ${tx.json(args as never)}, ${time}) on conflict do nothing returning log_index`;
      if (ins.length !== 1) continue; // a re-index never applies an event twice
      if (fromFactory) {
        const c = event === "MarketCreated" ? createdBy.get(lower(args.market)) : undefined;
        if (c) {
          await tx`insert into markets (market, asset, price_feed, usdg, symbol, name, decimals, reveal_end0, period, commit_seconds, reveal_seconds,
              fee_bps, min_notional, commit_fee_usd, max_staleness, max_orders, expiry_seconds, created_block, created_tx, remainder_pool_id,
              remainder_listed, max_deviation_bps, orry_fee_discount_bps, fee_tiers)
            values (${lower(c.market)}, ${lower(c.asset)}, ${lower(c.priceFeed)}, ${lower(c.usdg)}, ${c.symbol}, ${c.name}, ${c.decimals},
              ${c.revealEnd0.toString()}, ${c.period.toString()}, ${c.commitSeconds}, ${c.revealSeconds}, ${c.feeBps}, ${c.minNotional.toString()},
              ${c.commitFeeUsd.toString()}, ${c.maxStaleness}, ${c.maxOrders}, ${c.expirySeconds.toString()}, ${log.blockNumber!.toString()},
              ${log.transactionHash!}, ${lower(c.remainderPoolId)}, ${c.remainderListed}, ${c.maxDeviationBps}, ${c.orryFeeDiscountBps}, ${lower(c.feeTiers)})
            on conflict (market) do nothing`;
        }
        continue;
      }
      await apply(tx, event, args, log, time, viaPool);
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head, lag: head - to, logs: all.length };
}

export async function marketsLag(sql: Sql): Promise<{ last: bigint; head: bigint; lag: bigint } | null> {
  const [s] = await sql<{ last_block: string; head_block: string }[]>`select last_block, head_block from indexer_state where id = ${STATE_ID}`;
  if (!s) return null;
  return { last: BigInt(s.last_block), head: BigInt(s.head_block), lag: BigInt(s.head_block) - BigInt(s.last_block) };
}

export async function runMarketsIndexer(cfg: Config, chain: Chain, sql: Sql, signal?: AbortSignal, log: (m: string) => void = () => {}): Promise<void> {
  while (!signal?.aborted) {
    try {
      const r = await indexMarketsOnce(cfg, chain, sql);
      if (r.lag <= BigInt(cfg.confirmations)) await new Promise((res) => setTimeout(res, 1_000));
    } catch (e) {
      log(`markets indexer step failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }
}

