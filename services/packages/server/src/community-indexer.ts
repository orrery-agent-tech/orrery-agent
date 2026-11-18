import type postgres from "postgres";
import { decodeEventLog, parseAbi, type Abi, type Address, type Log } from "viem";
import {
  cashbackRewardsAbi,
  orryAchievementsAbi,
  orryBoostAbi,
  orryChatAbi,
  orryNamesAbi,
  orryPassesAbi,
  referralRegistryAbi,
  rewardPoolAbi,
  templateMarketAbi,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { CommunityConfig } from "./community-config.js";
import type { Sql } from "./db.js";
import { blockTimes } from "./orry-indexer.js";

/**
 * Lane L1 indexer: the L1 contracts' events (and OrreryAttestor `VerificationPaid`, a protocol fee for R-34) at the
 * confirmation depth into the `community_*` tables. One cursor (`indexer_state.id = 'community'`); every log is stored
 * once in `community_events` and applied only when that insert is new, so a replayed range changes nothing.
 */

const STATE_ID = "community";
const attestorAbi = parseAbi(["event VerificationPaid(uint256 indexed agentId, address indexed payer, address indexed owner, uint128 fee)"]);
const lower = (a: string) => a.toLowerCase();

type Source = "pool" | "achievements" | "chat" | "names" | "boost" | "passes" | "templates" | "referrals" | "cashback" | "attestor";

const ABIS: Record<Source, Abi> = {
  pool: rewardPoolAbi as Abi,
  achievements: orryAchievementsAbi as Abi,
  chat: orryChatAbi as Abi,
  names: orryNamesAbi as Abi,
  boost: orryBoostAbi as Abi,
  passes: orryPassesAbi as Abi,
  templates: templateMarketAbi as Abi,
  referrals: referralRegistryAbi as Abi,
  cashback: cashbackRewardsAbi as Abi,
  attestor: attestorAbi as Abi,
};

export function communitySources(cfg: Config): Map<string, Source> {
  const c = cfg.community!;
  const out = new Map<string, Source>();
  const add = (a: Address | null, s: Source) => a && out.set(lower(a), s);
  add(c.pool, "pool");
  add(c.achievements, "achievements");
  add(c.chat, "chat");
  add(c.names, "names");
  add(c.boost, "boost");
  add(c.passes, "passes");
  add(c.templates, "templates");
  add(c.referrals, "referrals");
  add(c.cashback, "cashback");
  add(cfg.addresses.attestor, "attestor");
  return out;
}

/** USD prices the L1 contracts were deployed with (immutables), read once per process. */
export interface CommunityPrices {
  postFeeUsd: bigint;
  nameFeeUsd: bigint;
  boostUsd: Record<number, bigint>;
  passUsd: Record<number, bigint>;
  templateBurnBps: bigint;
}

let pricesCache: { key: string; prices: CommunityPrices } | null = null;

export async function communityPrices(c: CommunityConfig, chain: Chain): Promise<CommunityPrices> {
  const key = [c.chat, c.names, c.boost, c.passes, c.templates].join(",");
  if (pricesCache?.key === key) return pricesCache.prices;
  const read = async <T>(address: Address | null, abi: Abi, functionName: string, args: unknown[] = []): Promise<T | null> =>
    address ? ((await chain.public.readContract({ address, abi, functionName, args })) as T) : null;
  const [post, name, bPost, bAgent, bTemplate, day, week, burnBps] = await Promise.all([
    read<bigint>(c.chat, orryChatAbi as Abi, "postFeeUsd"),
    read<bigint>(c.names, orryNamesAbi as Abi, "nameFeeUsd"),
    read<bigint>(c.boost, orryBoostAbi as Abi, "usdPerDay", [1]),
    read<bigint>(c.boost, orryBoostAbi as Abi, "usdPerDay", [2]),
    read<bigint>(c.boost, orryBoostAbi as Abi, "usdPerDay", [3]),
    read<bigint>(c.passes, orryPassesAbi as Abi, "dayPassUsd"),
    read<bigint>(c.passes, orryPassesAbi as Abi, "weekPassUsd"),
    read<number>(c.templates, templateMarketAbi as Abi, "burnBps"),
  ]);
  const prices: CommunityPrices = {
    postFeeUsd: post ?? 0n,
    nameFeeUsd: name ?? 0n,
    boostUsd: { 1: bPost ?? 0n, 2: bAgent ?? 0n, 3: bTemplate ?? 0n },
    passUsd: { 1: day ?? 0n, 2: week ?? 0n },
    templateBurnBps: BigInt(burnBps ?? 0),
  };
  pricesCache = { key, prices };
  return prices;
}

type Tx = postgres.TransactionSql<{}>;
type Args = Record<string, unknown>;

const s = (v: unknown) => String(v);
const at = (secs: unknown) => new Date(Number(secs) * 1000);

async function fee(tx: Tx, log: Log, account: string, source: string, usd: bigint, orry: bigint, time: Date) {
  await tx`insert into community_fees (tx_hash, log_index, account, source, usd, orry, block_time)
    values (${log.transactionHash!}, ${log.logIndex!}, ${lower(account)}, ${source}, ${usd.toString()}, ${orry.toString()}, ${time})
    on conflict do nothing`;
}

async function apply(tx: Tx, source: Source, event: string, a: Args, log: Log, time: Date, prices: CommunityPrices) {
  switch (`${source}.${event}`) {
    // ---------------------------------------------------------------- Reward Pool events
    case "pool.EventCreated":
      await tx`insert into community_pool_events (id, asset, kind, amount, deadline, rules_hash, status, created_at)
        values (${Number(a.id)}, ${s(a.asset)}, ${Number(a.kind)}, ${s(a.amount)}, ${at(a.deadline)}, ${s(a.rulesHash)}, 'open', ${time})
        on conflict (id) do nothing`;
      break;
    case "pool.WinnersPublished": {
      const winners = (a.winners as string[]).map((w, i) => ({ address: lower(w), amount: s((a.amounts as unknown[])[i]), paid: false }));
      const sum = (a.amounts as bigint[]).reduce((x, y) => x + BigInt(y as never), 0n);
      await tx`update community_pool_events set status = 'published', winners = ${tx.json(winners as never)},
        payable_at = ${at(a.payableAt)}, amount = ${sum.toString()} where id = ${Number(a.id)}`;
      break;
    }
    case "pool.PrizePaid":
      await tx`update community_pool_events set winners = (
          select jsonb_agg(case when w->>'address' = ${lower(s(a.winner))} then jsonb_set(w, '{paid}', 'true') else w end)
          from jsonb_array_elements(winners) w)
        where id = ${Number(a.id)}`;
      break;
    case "pool.EventExpired":
      await tx`update community_pool_events set status = 'expired' where id = ${Number(a.id)}`;
      break;
    // ---------------------------------------------------------------- Achievement Board
    case "achievements.AchievementCreated":
      await tx`insert into community_achievements (id, asset, kind, verifier, reward_per_user, max_recipients, deadline, rules_hash, created_at)
        values (${Number(a.id)}, ${s(a.asset)}, ${Number(a.kind)}, ${s(a.verifier) === "0x0000000000000000000000000000000000000000" ? null : s(a.verifier)},
          ${s(a.rewardPerUser)}, ${Number(a.maxRecipients)}, ${at(a.deadline)}, ${s(a.rulesHash)}, ${time})
        on conflict (id) do nothing`;
      break;
    case "achievements.CompletersPublished": {
      const accounts = a.accounts as string[];
      const times = a.completedAt as unknown[];
      for (let i = 0; i < accounts.length; i++) {
        await tx`insert into community_listed (id, account, completed_at, listed_at)
          values (${Number(a.id)}, ${lower(accounts[i]!)}, ${at(times[i])}, ${time}) on conflict (id, account) do nothing`;
      }
      break;
    }
    case "achievements.CompleterUnlisted":
      await tx`delete from community_listed where id = ${Number(a.id)} and account = ${s(a.account)}`;
      break;
    case "achievements.AchievementClaimed":
      await tx`insert into community_achievement_claims (id, account, completed_at, rank, amount, block_time)
        values (${Number(a.id)}, ${s(a.account)}, ${at(a.completedAt)}, ${Number(a.rank)}, ${s(a.amount)}, ${time})
        on conflict (id, account) do nothing`;
      break;
    case "achievements.AchievementClosed":
      await tx`update community_achievements set closed = true where id = ${Number(a.id)}`;
      break;
    // ---------------------------------------------------------------- chat and names
    case "chat.RoomCreated":
      await tx`insert into community_rooms (id, name, min_stake_usd) values (${Number(a.room)}, ${s(a.name).slice(0, 64)}, ${s(a.minStakeUsd)})
        on conflict (id) do nothing`;
      break;
    case "chat.Posted":
      await tx`insert into community_messages (id, room, author, reply_to, text, fee, block_time, tx_hash)
        values (${s(a.id)}, ${Number(a.room)}, ${s(a.author)}, ${s(a.replyTo) === "0" ? null : s(a.replyTo)}, ${String(a.text)}, ${s(a.fee)}, ${time}, ${log.transactionHash!})
        on conflict (id) do nothing`;
      await fee(tx, log, s(a.author), "chat", prices.postFeeUsd, BigInt(s(a.fee)), time);
      break;
    case "chat.Tipped":
      await tx`update community_messages set tips = tips + ${s(a.amount)} where id = ${s(a.id)}`;
      break;
    case "chat.Reported":
      await tx`update community_messages set reports = greatest(reports, ${Number(a.reports)}) where id = ${s(a.id)}`;
      break;
    case "chat.Hidden":
      await tx`update community_messages set hidden = true where id = ${s(a.id)}`;
      break;
    case "names.NameSet":
      await tx`insert into community_names (address, name, updated_at) values (${s(a.account)}, ${String(a.name)}, ${time})
        on conflict (address) do update set name = excluded.name, updated_at = excluded.updated_at`;
      await fee(tx, log, s(a.account), "names", prices.nameFeeUsd, BigInt(s(a.fee)), time);
      break;
    // ---------------------------------------------------------------- burns: boost, passes, templates
    case "boost.Boosted":
      await tx`insert into community_boosts (kind, target, until) values (${Number(a.kind)}, ${s(a.target)}, ${at(a.until)})
        on conflict (kind, target) do update set until = greatest(community_boosts.until, excluded.until)`;
      await fee(tx, log, s(a.payer), "boost", (prices.boostUsd[Number(a.kind)] ?? 0n) * BigInt(s(a.days_)), BigInt(s(a.burned)), time);
      break;
    case "passes.PassBought":
      await tx`insert into community_passes (account, until) values (${s(a.account)}, ${at(a.until)})
        on conflict (account) do update set until = greatest(community_passes.until, excluded.until)`;
      await fee(tx, log, s(a.payer), "passes", (prices.passUsd[Number(a.kind)] ?? 0n) * BigInt(s(a.count)), BigInt(s(a.burned)), time);
      break;
    case "templates.TemplateListed":
      await tx`insert into community_templates (id, creator, price_usd, content_hash, uri, created_at)
        values (${Number(a.id)}, ${s(a.creator)}, ${s(a.priceUsd)}, ${s(a.contentHash)}, ${String(a.uri).slice(0, 512)}, ${time})
        on conflict (id) do nothing`;
      break;
    case "templates.TemplatePriced":
      await tx`update community_templates set price_usd = ${s(a.priceUsd)} where id = ${Number(a.id)}`;
      break;
    case "templates.TemplateListing":
      await tx`update community_templates set listed = ${Boolean(a.listed)} where id = ${Number(a.id)}`;
      break;
    case "templates.TemplateBought": {
      const [t] = await tx<{ price_usd: string }[]>`select price_usd from community_templates where id = ${Number(a.id)}`;
      await tx`insert into community_licences (id, buyer, paid, block_time) values (${Number(a.id)}, ${s(a.buyer)}, ${s(a.paid)}, ${time})
        on conflict (id, buyer) do nothing`;
      await tx`update community_templates set sales = sales + 1 where id = ${Number(a.id)}`;
      // the protocol's part of a sale is the burned share; the rest is the creator's income
      const usd = t ? (BigInt(t.price_usd) * prices.templateBurnBps) / 10_000n : 0n;
      await fee(tx, log, s(a.buyer), "templates", usd, BigInt(s(a.burned)), time);
      break;
    }
    // ---------------------------------------------------------------- referrals and the cashback sink
    case "referrals.Linked":
      await tx`insert into community_referrals (referee, referrer, linked_at) values (${s(a.referee)}, ${s(a.referrer)}, ${at(a.linkedAt)})
        on conflict (referee) do nothing`;
      break;
    case "cashback.Accrued":
      await tx`insert into community_accruals (ref, kind, account, referee, month, fee_usd, reward_usd, fee_paid_at, tx_hash)
        values (${s(a.ref)}, ${Number(a.kind)}, ${s(a.account)}, ${s(a.referee) === "0x0000000000000000000000000000000000000000" ? null : s(a.referee)},
          ${Number(a.month)}, ${s(a.feeUsd)}, ${s(a.rewardUsd)}, ${at(a.feePaidAt)}, ${log.transactionHash!})
        on conflict do nothing`;
      break;
    case "cashback.MonthVoided":
      await tx`delete from community_accruals where account = ${s(a.account)} and month = ${Number(a.month)}`;
      break;
    case "cashback.PeriodOpened":
      await tx`insert into community_periods (month, total_usd, reserve, opened_at) values (${Number(a.month)}, ${s(a.totalUsd)}, ${s(a.reserve)}, ${time})
        on conflict (month) do nothing`;
      break;
    case "cashback.RewardClaimed":
      await tx`insert into community_claims (account, month, usd, orry, block_time) values (${s(a.account)}, ${Number(a.month)}, ${s(a.usd)}, ${s(a.orry)}, ${time})
        on conflict do nothing`;
      break;
    case "cashback.PeriodClosed":
      await tx`update community_periods set closed = true where month = ${Number(a.month)}`;
      break;
    // ---------------------------------------------------------------- verification fees (R-34 input)
    case "attestor.VerificationPaid":
      await fee(tx, log, s(a.payer), "verification", BigInt(s(a.fee)), 0n, time);
      break;
    default:
      break;
  }
}

export async function indexCommunityOnce(cfg: Config, chain: Chain, sql: Sql, range = 10_000n): Promise<{ last: bigint; head: bigint }> {
  const c = cfg.community!;
  const sources = communitySources(cfg);
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : c.startBlock;
  const head = await chain.public.getBlockNumber();
  const safe = head > BigInt(cfg.confirmations) ? head - BigInt(cfg.confirmations) : 0n;
  if (from > safe) return { last: from - 1n, head };
  const to = from + range - 1n < safe ? from + range - 1n : safe;
  const logs = (await chain.public.getLogs({ address: [...sources.keys()] as Address[], fromBlock: from, toBlock: to })) as Log[];
  logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex! - y.logIndex! : x.blockNumber! < y.blockNumber! ? -1 : 1));
  const times = await blockTimes(chain, logs);
  const prices = await communityPrices(c, chain);
  await sql.begin(async (tx) => {
    for (const log of logs) {
      const source = sources.get(lower(log.address));
      if (!source) continue;
      let d: { eventName: string; args: Args };
      try {
        d = decodeEventLog({ abi: ABIS[source], data: log.data, topics: log.topics }) as never;
      } catch {
        continue; // an event this indexer does not read (Burned, admin role changes, other attestor events)
      }
      const args = Object.fromEntries(
        Object.entries(d.args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : typeof v === "string" ? (/^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v) : Array.isArray(v) ? v.map((x) => (typeof x === "bigint" ? x.toString() : typeof x === "string" ? x.toLowerCase() : x)) : v]),
      );
      const time = times.get(log.blockNumber!)!;
      const ins = await tx`insert into community_events (block_number, log_index, tx_hash, address, source, event, args, block_time)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${lower(log.address)}, ${source}, ${d.eventName}, ${tx.json(args as never)}, ${time})
        on conflict do nothing returning log_index`;
      if (ins.length !== 1) continue;
      await apply(tx, source, d.eventName, args, log, time, prices);
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head };
}

export async function communityLag(sql: Sql): Promise<{ last: bigint; head: bigint } | null> {
  const [r] = await sql<{ last_block: string; head_block: string }[]>`select last_block, head_block from indexer_state where id = ${STATE_ID}`;
  return r ? { last: BigInt(r.last_block), head: BigInt(r.head_block) } : null;
}

export async function runCommunityIndexer(cfg: Config, chain: Chain, sql: Sql, signal?: AbortSignal, log: (m: string) => void = () => {}): Promise<void> {
  while (!signal?.aborted) {
    try {
      const r = await indexCommunityOnce(cfg, chain, sql);
      if (r.head - r.last > BigInt(cfg.confirmations) + 1n) continue;
    } catch (e) {
      log(`community indexer step failed: ${String(e).slice(0, 300)}`);
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}
