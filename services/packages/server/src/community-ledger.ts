import { keccak256, toHex, type Address } from "viem";
import { maskAddress } from "@orrery/shared";
import type { Config } from "./config.js";
import type { CommunityConfig } from "./community-config.js";
import type { Sql } from "./db.js";

/**
 * Protocol fees paid, per account, in USD (USDG base units): the input of the "most active" ranking (R-34) and of the
 * cashback and referral accruals (utilities 7 and 8). Sources, each from indexed chain data:
 * - `checks`: settled x402 check-pack payments in USDG (`payments`);
 * - `checks-orry`: check packs paid in ORRY (`CreditsPaid`, packs x pack price);
 * - `verification-orry`: verifications paid in ORRY (`VerificationBurned`, the verification USD price);
 * - `verification`: verifications paid in USDG (`OrreryAttestor.VerificationPaid`, indexed by the community indexer);
 * - `markets`: USDG fees of filled market orders (`OrderFilled.usdgFee`);
 * - `facilitator`: USDG settlement fees merchants paid through their splitters (`Forwarded.fee`);
 * - `chat`, `names`, `boost`, `passes`, `templates`: L1 payments at their USD prices (the burned share for templates).
 * Not counted: market fees paid in ORRY (no USD value is recorded at payment) and chat tips (gifts to authors).
 */
export interface FeeRow {
  ref: string;
  account: string;
  source: string;
  usd: bigint;
  at: Date;
  usdg: boolean; // paid in USDG (cashback base, utility 7)
}

export const USDG_SOURCES = new Set(["checks", "verification", "markets", "facilitator"]);

export async function feeRows(sql: Sql, cfg: Config, from: Date, to: Date, account?: string): Promise<FeeRow[]> {
  const acct = account?.toLowerCase() ?? null;
  const usdg = cfg.addresses.usdg.toLowerCase();
  const rows = await sql<{ ref: string; account: string; source: string; usd: string; at: Date }[]>`
    select * from (
      select tx_hash || ':' || log_index as ref, account, source, usd, block_time as at from community_fees
        where block_time >= ${from} and block_time < ${to}
      union all
      select 'pay:' || lower(payer) || ':' || nonce, lower(payer), 'checks', amount, updated_at from payments
        where status = 'settled' and updated_at >= ${from} and updated_at < ${to}
      union all
      select tx_hash || ':' || log_index, lower(args->>'buyer'), 'checks-orry', (args->>'packs')::numeric * ${cfg.packPrice.toString()}::numeric, block_time
        from orry_events where event = 'CreditsPaid' and block_time >= ${from} and block_time < ${to}
      union all
      select tx_hash || ':' || log_index, lower(args->>'payer'), 'verification-orry', ${(cfg.orry?.verificationUsd ?? 0n).toString()}::numeric, block_time
        from orry_events where event = 'VerificationBurned' and block_time >= ${from} and block_time < ${to}
      union all
      select tx_hash || ':' || log_index, lower(args->>'account'), 'markets', (args->>'usdgFee')::numeric, block_time
        from market_events where event = 'OrderFilled' and block_time >= ${from} and block_time < ${to}
      union all
      select e.tx_hash || ':' || e.log_index, m.merchant, 'facilitator', (e.args->>'fee')::numeric, e.block_time
        from facilitator_events e join merchants m on m.splitter = e.address
        where e.event = 'Forwarded' and lower(e.args->>'token') = ${usdg} and e.block_time >= ${from} and e.block_time < ${to}
    ) f
    where usd > 0 and (${acct}::text is null or account = ${acct})
    order by at, ref`;
  return rows.map((r) => ({ ref: r.ref, account: r.account, source: r.source, usd: BigInt(r.usd), at: r.at, usdg: USDG_SOURCES.has(r.source) }));
}

/** The rule text an admin commits to (`rulesHash`) when creating a "most active" event over [from, to). */
export function mostActiveRules(from: Date, to: Date): string {
  return JSON.stringify({
    rule: "most-active",
    metric: "protocol fees paid in USD (USDG base units)",
    from: from.toISOString(),
    to: to.toISOString(),
    sources: ["checks", "checks-orry", "verification", "verification-orry", "markets", "facilitator", "chat", "names", "boost", "passes", "templates"],
    oneprize: "at most one prize per address",
  });
}

export interface RankedRow {
  account: string;
  feesUsd: bigint;
  bySource: Record<string, bigint>;
}

export function rankByFees(rows: FeeRow[], limit: number): RankedRow[] {
  const by = new Map<string, RankedRow>();
  for (const r of rows) {
    const e = by.get(r.account) ?? { account: r.account, feesUsd: 0n, bySource: {} };
    e.feesUsd += r.usd;
    e.bySource[r.source] = (e.bySource[r.source] ?? 0n) + r.usd;
    by.set(r.account, e);
  }
  return [...by.values()]
    .sort((a, b) => (a.feesUsd === b.feesUsd ? (a.account < b.account ? -1 : 1) : a.feesUsd > b.feesUsd ? -1 : 1))
    .slice(0, limit);
}

export async function mostActive(sql: Sql, cfg: Config, from: Date, to: Date, limit = 50) {
  const ranked = rankByFees(await feeRows(sql, cfg, from, to), limit);
  const rules = mostActiveRules(from, to);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    rules,
    rulesHash: keccak256(toHex(rules)),
    rows: ranked.map((r, i) => ({
      rank: i + 1,
      address: maskAddress(r.account),
      feesUsd: r.feesUsd.toString(),
      bySource: Object.fromEntries(Object.entries(r.bySource).map(([k, v]) => [k, v.toString()])),
    })),
  };
}

// ------------------------------------------------------------------ accruals (utilities 7 and 8, R-53 to R-56)

export interface Link {
  referrer: string;
  linkedAt: Date;
}

export interface Accrual {
  account: Address;
  kind: 1 | 2;
  referee: Address;
  feePaidAt: bigint;
  feeUsd: bigint;
  rewardUsd: bigint;
  ref: `0x${string}`;
}

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const DAY = 86_400_000;

/**
 * Accrual records for fees not yet recorded on chain. Cashback: `cashbackBps` of each USDG fee to its payer. Referral:
 * `referralBps` of each fee a linked referee paid within `referralDays` of the link, to the referrer, times 2 when the
 * referee is a merchant and 1.25 when the referrer's stake reaches `stakerMinUsd`, never above 50% of the fee; the
 * referrer's month total is trimmed to `monthlyCapUsd` (the contract refuses more, RF-3). `capUsed(referrer)` is what
 * the sink already counts for the current month. Pure: the caller supplies the chain reads.
 */
export function buildAccruals(
  c: Pick<CommunityConfig, "cashbackBps" | "referralBps" | "referralDays" | "merchantWeightBps" | "stakerWeightBps" | "monthlyCapUsd">,
  rows: FeeRow[],
  links: Map<string, Link>,
  merchants: Set<string>,
  stakers: Set<string>,
  seen: Set<string>,
  capUsed: Map<string, bigint>,
): Accrual[] {
  const out: Accrual[] = [];
  const used = new Map(capUsed);
  for (const r of rows) {
    const ref = keccak256(toHex(r.ref));
    const feePaidAt = BigInt(Math.floor(r.at.getTime() / 1000));
    if (r.usdg && c.cashbackBps > 0) {
      const reward = (r.usd * BigInt(c.cashbackBps)) / 10_000n;
      if (reward > 0n && !seen.has(`${ref}:1:${r.account}`)) {
        out.push({ account: r.account as Address, kind: 1, referee: ZERO, feePaidAt, feeUsd: r.usd, rewardUsd: reward, ref });
      }
    }
    const link = links.get(r.account);
    if (!link || c.referralBps === 0) continue;
    if (r.at.getTime() < link.linkedAt.getTime() || r.at.getTime() >= link.linkedAt.getTime() + c.referralDays * DAY) continue;
    if (seen.has(`${ref}:2:${link.referrer}`)) continue;
    let reward = (r.usd * BigInt(c.referralBps)) / 10_000n;
    if (merchants.has(r.account)) reward = (reward * BigInt(c.merchantWeightBps)) / 10_000n;
    if (stakers.has(link.referrer)) reward = (reward * BigInt(c.stakerWeightBps)) / 10_000n;
    const ceiling = r.usd / 2n;
    if (reward > ceiling) reward = ceiling;
    const u = used.get(link.referrer) ?? 0n;
    if (u + reward > c.monthlyCapUsd) reward = c.monthlyCapUsd > u ? c.monthlyCapUsd - u : 0n;
    if (reward === 0n) continue;
    used.set(link.referrer, u + reward);
    out.push({ account: link.referrer as Address, kind: 2, referee: r.account as Address, feePaidAt, feeUsd: r.usd, rewardUsd: reward, ref });
  }
  return out;
}

/** Referral tier by referred volume over the referral window (plan guess, `tiersUsd`). */
export function tierOf(volumeUsd: bigint, tiersUsd: bigint[]): string | null {
  const names = ["Bronze", "Silver", "Ambassador"];
  let t: string | null = null;
  tiersUsd.forEach((min, i) => {
    if (volumeUsd >= min) t = names[i] ?? `Tier ${i + 1}`;
  });
  return t;
}

/** R-54: the referee discount applies until this time, or null when not linked. For the pricing paths to read. */
export async function refereeDiscountUntil(sql: Sql, c: CommunityConfig, address: string): Promise<Date | null> {
  const [r] = await sql<{ linked_at: Date }[]>`select linked_at from community_referrals where referee = ${address.toLowerCase()}`;
  return r ? new Date(r.linked_at.getTime() + c.referralDays * DAY) : null;
}
