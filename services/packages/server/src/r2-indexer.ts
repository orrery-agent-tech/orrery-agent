import type postgres from "postgres";
import { decodeEventLog, parseAbi, type Abi, type Address, type Log } from "viem";
import {
  iLimitOrderBookAbi,
  iPredictionMarketAbi,
  iPredictionMarketFactoryAbi,
  iOrryPaymasterAbi,
  iOrreryShieldAbi,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import type { R2Config } from "./r2-config.js";
import { toJson } from "./check.js";
import { blockTimes } from "./orry-indexer.js";

/**
 * Lane L3 indexer (`docs/updates/L3-R2-SPEC.md` section 7, workspace rule 7). Per range of at most 10,000 confirmed
 * blocks: one `eth_getLogs` for the prediction factory (to learn the markets made in the range), then one for every other
 * R2 address (the markets, the limit order book, the paymasters). Events, derived tables and the cursor change in one
 * database transaction; a re-index never applies an event twice.
 */

const STATE_ID = "r2";
type Tx = postgres.TransactionSql<{}>;
type Args = Record<string, unknown>;
const lower = (a: unknown) => String(a).toLowerCase();
const str = (v: unknown) => String(v);
const STATUS = ["open", "yes", "no", "refund"] as const;
const feedAbi = parseAbi(["function description() view returns (string)", "function decimals() view returns (uint8)"]);
const symbolAbi = parseAbi(["function symbol() view returns (string)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

function decode(abi: Abi, log: Log): { event: string; args: Args } {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics });
    return { event: d.eventName ?? "unknown", args: toJson(d.args) as Args };
  } catch {
    return { event: "unknown", args: { topics: log.topics.join(","), data: log.data } };
  }
}

/**
 * A feed bound to a stock token is named after the token's own ticker ("NVDA / USD"): the stock feeds' descriptions on
 * 4663 differ ("RHNVDA / USD", "Robinhood AAPL / USD", "Robinhood DELL-USD"). A feed with no token keeps its description.
 */
async function readFeed(chain: Chain, feed: Address, asset: Address): Promise<{ description: string; decimals: number }> {
  const decimals = Number(await chain.public.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }));
  if (asset.toLowerCase() !== ZERO) {
    const symbol = await chain.public.readContract({ address: asset, abi: symbolAbi, functionName: "symbol" }).catch(() => "");
    if (symbol) return { description: `${symbol} / USD`, decimals };
  }
  const description = await chain.public.readContract({ address: feed, abi: feedAbi, functionName: "description" }).catch(() => "Price feed");
  return { description: String(description), decimals };
}

async function marketParams(chain: Chain, market: Address): Promise<{ feeBps: number; minStake: bigint }> {
  const m = (functionName: "feeBps" | "minStake") => chain.public.readContract({ address: market, abi: iPredictionMarketAbi, functionName });
  const [feeBps, minStake] = await Promise.all([m("feeBps"), m("minStake")]);
  return { feeBps: Number(feeBps), minStake: BigInt(minStake as bigint) };
}

async function applyMarket(tx: Tx, event: string, a: Args, log: Log): Promise<void> {
  const market = lower(log.address);
  switch (event) {
    case "Staked": {
      const account = lower(a.account);
      const ins = await tx`insert into predict_positions (market, account) values (${market}, ${account}) on conflict do nothing returning 1`;
      const amount = str(a.amount);
      if (a.yes) {
        await tx`update predict_positions set yes = yes + ${amount}::numeric where market = ${market} and account = ${account}`;
        await tx`update predict_markets set yes_pool = yes_pool + ${amount}::numeric, stakers = stakers + ${ins.length} where market = ${market}`;
      } else {
        await tx`update predict_positions set no = no + ${amount}::numeric where market = ${market} and account = ${account}`;
        await tx`update predict_markets set no_pool = no_pool + ${amount}::numeric, stakers = stakers + ${ins.length} where market = ${market}`;
      }
      return;
    }
    case "Settled":
      await tx`update predict_markets set status = ${STATUS[Number(a.status)] ?? "open"}, settle_price = ${str(a.price)},
          settle_round = ${str(a.roundId)}, settled_tx = ${log.transactionHash!} where market = ${market}`;
      return;
    case "Claimed":
      await tx`update predict_positions set claimed = true, payout = ${str(a.payout)}, usdg_fee = ${str(a.usdgFee)},
          orry_fee = ${str(a.orryFee)}, claim_tx = ${log.transactionHash!}
        where market = ${market} and account = ${lower(a.account)}`;
      await tx`update predict_markets set paid_out = paid_out + ${str(a.payout)}::numeric, usdg_fees = usdg_fees + ${str(a.usdgFee)}::numeric,
          orry_fees = orry_fees + ${str(a.orryFee)}::numeric where market = ${market}`;
      return;
    case "Swept":
      await tx`update predict_markets set swept = swept + ${str(a.amount)}::numeric where market = ${market}`;
      return;
    default:
      return; // Burned (source 31) is read from r2_events by the burns route
  }
}

async function applyBook(tx: Tx, event: string, a: Args, log: Log): Promise<void> {
  const book = lower(log.address);
  if (event === "OrderFilled") {
    await tx`insert into limit_nonces (book, owner, nonce, outcome, tx) values (${book}, ${lower(a.owner)}, ${str(a.nonce)}, 'filled', ${log.transactionHash!})
      on conflict do nothing`;
    await tx`update limit_orders set status = 'filled', amount_out = ${str(a.amountOut)}, usdg_fee = ${str(a.usdgFee)}, orry_fee = ${str(a.orryFee)},
        tip = ${str(a.tip)}, keeper = ${lower(a.keeper)}, fill_tx = ${log.transactionHash!}
      where order_hash = ${lower(a.orderHash)}`;
  } else if (event === "NonceCancelled") {
    await tx`insert into limit_nonces (book, owner, nonce, outcome, tx) values (${book}, ${lower(a.owner)}, ${str(a.nonce)}, 'cancelled', ${log.transactionHash!})
      on conflict do nothing`;
    await tx`update limit_orders set status = 'cancelled' where book = ${book} and owner = ${lower(a.owner)} and nonce = ${str(a.nonce)} and status = 'open'`;
  }
}

async function applyPaymaster(tx: Tx, event: string, a: Args, log: Log, time: Date): Promise<void> {
  const pm = lower(log.address);
  const row = async (account: string) =>
    tx`insert into paymaster_accounts (paymaster, account) values (${pm}, ${account}) on conflict do nothing`;
  if (event === "Deposited") {
    await row(lower(a.account));
    await tx`update paymaster_accounts set deposited = deposited + ${str(a.amount)}::numeric where paymaster = ${pm} and account = ${lower(a.account)}`;
  } else if (event === "Withdrawn") {
    await row(lower(a.account));
    await tx`update paymaster_accounts set withdrawn = withdrawn + ${str(a.amount)}::numeric where paymaster = ${pm} and account = ${lower(a.account)}`;
  } else if (event === "Charged") {
    await row(lower(a.account));
    await tx`update paymaster_accounts set charged = charged + ${str(a.charged)}::numeric, ops = ops + 1
      where paymaster = ${pm} and account = ${lower(a.account)}`;
    await tx`insert into paymaster_ops (paymaster, tx_hash, log_index, account, gas_cost, charged, premium, block_time)
      values (${pm}, ${log.transactionHash!}, ${log.logIndex!}, ${lower(a.account)}, ${str(a.actualGasCost)}, ${str(a.charged)}, ${str(a.premium)}, ${time})
      on conflict do nothing`;
  }
}

/** One step: index up to `range` confirmed blocks. */
export async function indexR2Once(
  r2: R2Config,
  chain: Chain,
  sql: Sql,
  confirmations: number,
  opts: { range?: bigint } = {},
): Promise<{ last: bigint; head: bigint; lag: bigint; logs: number }> {
  const range = opts.range ?? 10_000n;
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : r2.startBlock;
  const head = await chain.public.getBlockNumber();
  const depth = BigInt(confirmations);
  const safe = head > depth ? head - depth : 0n;
  if (from > safe) {
    await sql`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${(from - 1n).toString()}, ${head.toString()})
      on conflict (id) do update set head_block = excluded.head_block, updated_at = now()`;
    return { last: from - 1n, head, lag: head - (from - 1n), logs: 0 };
  }
  const to = from + range - 1n < safe ? from + range - 1n : safe;
  const factory = r2.predictFactory?.toLowerCase() ?? null;
  const book = r2.limitBook?.toLowerCase() ?? null;
  const paymasters = new Set(r2.paymasters.map((p) => p.toLowerCase()));
  const shield = r2.shield?.toLowerCase() ?? null;

  const factoryLogs = r2.predictFactory
    ? ((await chain.public.getLogs({ address: r2.predictFactory, fromBlock: from, toBlock: to })) as Log[])
    : [];
  const created: Address[] = [];
  const listed: { feed: Address; asset: Address }[] = [];
  for (const log of factoryLogs) {
    const d = decode(iPredictionMarketFactoryAbi as Abi, log);
    if (d.event === "MarketCreated") created.push(d.args.market as Address);
    if (d.event === "FeedListed") listed.push({ feed: d.args.feed as Address, asset: d.args.asset as Address });
  }
  const known = (await sql<{ market: string }[]>`select market from predict_markets`).map((r) => r.market as Address);
  const markets = new Set([...known, ...created].map((m) => m.toLowerCase()));
  const others = [...markets, ...(book ? [book] : []), ...paymasters, ...(shield ? [shield] : [])] as Address[];
  const otherLogs = others.length ? ((await chain.public.getLogs({ address: others, fromBlock: from, toBlock: to })) as Log[]) : [];
  const all = [...factoryLogs, ...otherLogs].sort((x, y) =>
    x.blockNumber! === y.blockNumber! ? x.logIndex! - y.logIndex! : x.blockNumber! < y.blockNumber! ? -1 : 1,
  );
  const times = await blockTimes(chain, all);
  const feeds = new Map<string, { description: string; decimals: number }>();
  for (const f of listed) feeds.set(f.feed.toLowerCase(), await readFeed(chain, f.feed, f.asset));
  const params = new Map<string, { feeBps: number; minStake: bigint }>();
  for (const m of created) params.set(m.toLowerCase(), await marketParams(chain, m));

  const abiOf = (address: string): Abi =>
    address === factory
      ? (iPredictionMarketFactoryAbi as Abi)
      : address === book
        ? (iLimitOrderBookAbi as Abi)
        : paymasters.has(address)
          ? (iOrryPaymasterAbi as Abi)
          : address === shield
            ? (iOrreryShieldAbi as Abi)
            : (iPredictionMarketAbi as Abi);

  await sql.begin(async (tx) => {
    for (const log of all) {
      const address = log.address.toLowerCase();
      const { event, args } = decode(abiOf(address), log);
      const time = times.get(log.blockNumber!)!;
      const ins = await tx`insert into r2_events (block_number, log_index, tx_hash, address, event, args, block_time)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${address}, ${event},
          ${tx.json(args as never)}, ${time}) on conflict do nothing returning log_index`;
      if (ins.length !== 1) continue;
      if (address === factory) {
        if (event === "FeedListed") {
          const f = feeds.get(lower(args.feed))!;
          await tx`insert into predict_feeds (feed, asset, description, decimals, listed_block)
            values (${lower(args.feed)}, ${lower(args.asset)}, ${f.description}, ${f.decimals}, ${log.blockNumber!.toString()}) on conflict do nothing`;
        } else if (event === "MarketCreated") {
          const p = params.get(lower(args.market))!;
          await tx`insert into predict_markets (market, feed, asset, strike, close_time, lock_time, created_time, creator, creation_burn, fee_bps,
              min_stake, created_block, created_tx)
            values (${lower(args.market)}, ${lower(args.feed)}, ${lower(args.asset)}, ${str(args.strike)}, ${str(args.closeTime)}, ${str(args.lockTime)},
              ${time}, ${lower(args.creator)}, ${str(args.orryBurned)}, ${p.feeBps}, ${p.minStake.toString()}, ${log.blockNumber!.toString()},
              ${log.transactionHash!}) on conflict do nothing`;
        }
      } else if (address === book) {
        await applyBook(tx, event, args, log);
      } else if (paymasters.has(address)) {
        await applyPaymaster(tx, event, args, log, time);
      } else if (address === shield) {
        // the shield's events are read straight from r2_events, in chain order (GET /v1/r2/shield/events)
      } else {
        await applyMarket(tx, event, args, log);
      }
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head, lag: head - to, logs: all.length };
}

export async function runR2Indexer(
  r2: R2Config,
  chain: Chain,
  sql: Sql,
  confirmations: number,
  signal?: AbortSignal,
  log: (m: string) => void = () => {},
): Promise<void> {
  while (!signal?.aborted) {
    try {
      const r = await indexR2Once(r2, chain, sql, confirmations);
      if (r.lag <= BigInt(confirmations)) await new Promise((res) => setTimeout(res, 1_000));
    } catch (e) {
      log(`r2 indexer step failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }
}
