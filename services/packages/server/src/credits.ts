import { createHash, randomBytes } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import type { Chain } from "./chain.js";
import type { Config, Pricing } from "./config.js";
import type { Sql } from "./db.js";

/** Credits and API keys (14 §3): one active key per payer address, atomic credit use, SIWE-style key rotation. */

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export async function issueKeyIfNone(sql: Sql, address: Address): Promise<string | null> {
  const a = address.toLowerCase();
  const [existing] = await sql`select 1 from api_keys where address = ${a} and active`;
  if (existing) return null;
  const key = `or_${randomBytes(32).toString("hex")}`;
  try {
    await sql`insert into api_keys (key_hash, address) values (${hashKey(key)}, ${a})`;
  } catch {
    return null; // a parallel purchase issued it first
  }
  return key;
}

export async function addressForKey(sql: Sql, key: string | undefined): Promise<Address | null> {
  if (!key) return null;
  const [row] = await sql<{ address: string }[]>`select address from api_keys where key_hash = ${hashKey(key)} and active`;
  return row ? getAddress(row.address) : null;
}

export async function creditsOf(sql: Sql, address: Address): Promise<bigint> {
  const [row] = await sql<{ credits: string }[]>`select credits from credit_accounts where address = ${address.toLowerCase()}`;
  return BigInt(row?.credits ?? 0);
}

// ------------------------------------------------------------------ check pricing (R-58)

/** First day of the UTC month and the UTC day of `d`, as `YYYY-MM-DD`. */
export const utcMonth = (d: Date) => `${d.toISOString().slice(0, 7)}-01`;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Credits the next check costs, given the checks already made this month and whether a plan is active. */
export function checkCost(p: Pricing, checksThisMonth: number, planActive: boolean): number {
  return planActive || checksThisMonth >= p.volumeChecks ? p.volumeCreditsPerCheck : p.creditsPerCheck;
}

export interface CheckAccount {
  credits: bigint;
  planUntil: Date | null;
  planActive: boolean;
  /** This UTC month. */
  checks: number;
  freeChecks: number;
  freeChecksLeft: number;
  /** Credits the next paid check costs. */
  checkCost: number;
}

/** `extraFree`: included checks a month on top of the plan's, from the stake quota (utility 1). */
export async function checkAccount(p: Pricing, sql: Sql, address: Address, now = new Date(), extraFree = 0): Promise<CheckAccount> {
  const [row] = await sql<{ credits: string; plan_until: Date | null; checks: string | null; free_checks: string | null }[]>`
    select c.credits, c.plan_until, u.checks, u.free_checks from credit_accounts c
    left join check_usage u on u.address = c.address and u.month = ${utcMonth(now)}
    where c.address = ${address.toLowerCase()}`;
  const planUntil = row?.plan_until ?? null;
  const planActive = !!planUntil && planUntil.getTime() > now.getTime();
  const checks = Number(row?.checks ?? 0);
  const freeChecks = Number(row?.free_checks ?? 0);
  return {
    credits: BigInt(row?.credits ?? 0),
    planUntil,
    planActive,
    checks,
    freeChecks,
    freeChecksLeft: Math.max(0, p.freeChecksPerMonth + extraFree - freeChecks),
    checkCost: checkCost(p, checks, planActive),
  };
}

/** True when the next check can be paid: free checks left this month, or enough credits. */
export const canCheck = (a: CheckAccount) => a.freeChecksLeft > 0 || a.credits >= BigInt(a.checkCost);

/**
 * Atomic: takes one check from the free allowance (within the global daily cap), else its cost in credits. Never lets
 * credits go below zero; the usage row lock serialises one address's checks so the month count and the tier agree.
 */
export async function spendCheck(
  p: Pricing,
  sql: Sql,
  address: Address,
  now = new Date(),
  extraFree = 0,
): Promise<{ ok: true; free: boolean; credits: number } | { ok: false }> {
  const a = address.toLowerCase();
  const month = utcMonth(now);
  const day = utcDay(now);
  return sql.begin(async (tx) => {
    await tx`insert into check_usage (address, month) values (${a}, ${month}) on conflict do nothing`;
    const [u] = await tx<{ checks: string; free_checks: string }[]>`select checks, free_checks from check_usage
      where address = ${a} and month = ${month} for update`;
    const checks = Number(u!.checks);
    await tx`insert into check_days (day) values (${day}) on conflict do nothing`;
    if (Number(u!.free_checks) < p.freeChecksPerMonth + extraFree) {
      const freeToday = await tx`update check_days set free_checks = free_checks + 1
        where day = ${day} and free_checks < ${p.freeChecksPerDay} returning day`;
      if (freeToday.length === 1) {
        await tx`update check_usage set checks = checks + 1, free_checks = free_checks + 1 where address = ${a} and month = ${month}`;
        await tx`insert into check_usage_daily (address, day, checks, free_checks) values (${a}, ${day}, 1, 1)
          on conflict (address, day) do update set checks = check_usage_daily.checks + 1, free_checks = check_usage_daily.free_checks + 1`;
        return { ok: true as const, free: true, credits: 0 };
      }
    }
    const [acct] = await tx<{ plan_until: Date | null }[]>`select plan_until from credit_accounts where address = ${a}`;
    const planActive = !!acct?.plan_until && acct.plan_until.getTime() > now.getTime();
    const cost = checkCost(p, checks, planActive);
    const spent = await tx`update credit_accounts set credits = credits - ${cost} where address = ${a} and credits >= ${cost} returning credits`;
    if (spent.length !== 1) return { ok: false as const };
    await tx`update check_usage set checks = checks + 1 where address = ${a} and month = ${month}`;
    await tx`update check_days set paid_checks = paid_checks + 1 where day = ${day}`;
    await tx`insert into check_usage_daily (address, day, checks, credits_spent) values (${a}, ${day}, 1, ${cost})
      on conflict (address, day) do update set checks = check_usage_daily.checks + 1, credits_spent = check_usage_daily.credits_spent + ${cost}`;
    return { ok: true as const, free: false, credits: cost };
  });
}

/** Atomic: spends one credit or returns false. Never goes below zero. */
export async function spendCredit(sql: Sql, address: Address): Promise<boolean> {
  const rows = await sql`update credit_accounts set credits = credits - 1 where address = ${address.toLowerCase()} and credits > 0 returning credits`;
  return rows.length === 1;
}

export function rotationMessage(cfg: Config, address: Address, nonce: string, expiresAt: Date): string {
  const host = new URL(cfg.publicUrl).host;
  return [
    `Replace the Orrery API key for this address at ${host}.`,
    `Address: ${getAddress(address)}`,
    `Chain ID: ${cfg.chainId}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}

export async function newRotationNonce(cfg: Config, sql: Sql, address: Address): Promise<{ nonce: string; message: string }> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  await sql`insert into key_nonces (nonce, address, expires_at) values (${nonce}, ${address.toLowerCase()}, ${expiresAt})`;
  return { nonce, message: rotationMessage(cfg, address, nonce, expiresAt) };
}

/** Verifies the signed message (EOA or ERC-1271), burns the nonce, revokes all keys, returns one new key. */
export async function rotateKey(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  address: Address,
  nonce: string,
  signature: Hex,
): Promise<string | null> {
  const [row] = await sql<{ expires_at: Date; used: boolean; address: string; purpose: string }[]>`select expires_at, used, address, purpose from key_nonces where nonce = ${nonce}`;
  if (!row || row.used || row.purpose !== "rotate" || row.address !== address.toLowerCase() || row.expires_at.getTime() < Date.now()) return null;
  const message = rotationMessage(cfg, address, nonce, row.expires_at);
  const ok = await chain.public.verifyMessage({ address, message, signature });
  if (!ok) return null;
  const used = await sql`update key_nonces set used = true where nonce = ${nonce} and not used returning nonce`;
  if (used.length !== 1) return null;
  const key = `or_${randomBytes(32).toString("hex")}`;
  await sql.begin(async (tx) => {
    await tx`insert into credit_accounts (address) values (${address.toLowerCase()}) on conflict do nothing`;
    await tx`update api_keys set active = false where address = ${address.toLowerCase()}`;
    await tx`insert into api_keys (key_hash, address) values (${hashKey(key)}, ${address.toLowerCase()})`;
  });
  return key;
}

// ---------------------------------------------------------------- dashboard read sessions

/** The sign-in message: it says what a session can do, so a wallet never signs more than it reads. */
export function sessionMessage(cfg: Config, address: Address, nonce: string, expiresAt: Date): string {
  const host = new URL(cfg.publicUrl).host;
  return [
    `Sign in to the Orrery dashboard at ${host}.`,
    "This session can view credits, purchases and usage only. Signing spends no credits, issues no key and moves no funds.",
    `Address: ${getAddress(address)}`,
    `Chain ID: ${cfg.chainId}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}

export async function newSessionNonce(cfg: Config, sql: Sql, address: Address): Promise<{ nonce: string; message: string }> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  await sql`insert into key_nonces (nonce, address, expires_at, purpose) values (${nonce}, ${address.toLowerCase()}, ${expiresAt}, 'session')`;
  return { nonce, message: sessionMessage(cfg, address, nonce, expiresAt) };
}

export const SESSION_HOURS = 24;

/** Verifies the signed sign-in message (EOA or ERC-1271), burns the nonce, returns a read token for 24 hours. */
export async function openSession(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  address: Address,
  nonce: string,
  signature: Hex,
): Promise<{ token: string; expiresAt: Date } | null> {
  const [row] = await sql<{ expires_at: Date; used: boolean; address: string; purpose: string }[]>`select expires_at, used, address, purpose from key_nonces where nonce = ${nonce}`;
  if (!row || row.used || row.purpose !== "session" || row.address !== address.toLowerCase() || row.expires_at.getTime() < Date.now()) return null;
  const ok = await chain.public.verifyMessage({ address, message: sessionMessage(cfg, address, nonce, row.expires_at), signature });
  if (!ok) return null;
  const used = await sql`update key_nonces set used = true where nonce = ${nonce} and not used returning nonce`;
  if (used.length !== 1) return null;
  const token = `rcs_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await sql`delete from account_sessions where expires_at < now()`;
  await sql`insert into account_sessions (token_hash, address, expires_at) values (${hashKey(token)}, ${address.toLowerCase()}, ${expiresAt})`;
  return { token, expiresAt };
}

/** The address behind a read session or an API key; null for anything else. A session never authorises a check. */
export async function addressForReader(sql: Sql, token: string | undefined): Promise<Address | null> {
  if (!token) return null;
  if (token.startsWith("rcs_")) {
    const [row] = await sql<{ address: string }[]>`select address from account_sessions where token_hash = ${hashKey(token)} and expires_at > now()`;
    return row ? getAddress(row.address) : null;
  }
  return addressForKey(sql, token);
}

export async function closeSession(sql: Sql, token: string | undefined): Promise<void> {
  if (token?.startsWith("rcs_")) await sql`delete from account_sessions where token_hash = ${hashKey(token)}`;
}
