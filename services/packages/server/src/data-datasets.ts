import { encodePacked, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { BURN_SOURCE_LABELS, DATA_CATALOG, aggregatorV3Abi, maskAddress, poolManagerAbi, poolStateSlot, type DataRecord, type DatasetId } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { DataStock } from "./data-config.js";
import type { Sql } from "./db.js";

/**
 * The seven official datasets of wave D1 (R-49; `docs/updates/L2-DATA-MCP-SPEC.md` 5). Sources are the chain (through
 * the RPC in `ORRERY_RPC_URL`) and Orrery's own Postgres tables; nothing here calls any other host (DA-4, tested).
 * Event records name `block`, `tx` and `logIndex` (DA-1); snapshots name the `block` they were read at (D-11).
 */

export interface DatasetQuery {
  view: string;
  limit: number;
  /** Cursor `block:logIndex` (events) or a row id (probes), from the previous page's `next`. */
  before: string | null;
  filters: Record<string, string>;
}

export interface DatasetResult {
  records: DataRecord[];
  asOfBlock: bigint;
  next: string | null;
}

export class DatasetUnavailable extends Error {}

export interface DatasetCtx {
  cfg: Config;
  chain: Chain;
  sql: Sql;
}

const lower = (a: string) => a.toLowerCase();
const unix = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : null);
const tokenAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

// ------------------------------------------------------------------ query parsing

/** Parses and bounds a request's query string (400 on anything unexpected). */
export function parseDatasetQuery(cfg: Config, id: DatasetId, raw: Record<string, unknown>): DatasetQuery | { error: string } {
  const info = DATA_CATALOG[id];
  const view = raw.view === undefined || raw.view === "" ? info.views[0]! : String(raw.view);
  if (!info.views.includes(view)) return { error: `view expects one of: ${info.views.join(", ")}.` };
  const limitRaw = raw.limit === undefined || raw.limit === "" ? 100 : Number(raw.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > cfg.data!.maxLimit) return { error: `limit must be between 1 and ${cfg.data!.maxLimit}.` };
  const before = raw.before === undefined || raw.before === "" ? null : String(raw.before);
  if (before !== null && !/^\d{1,20}(:\d{1,9})?$/.test(before)) return { error: "before expects the next value from the previous page." };
  const filters: Record<string, string> = {};
  for (const k of Object.keys(raw)) {
    if (k === "view" || k === "limit" || k === "before") continue;
    if (!info.filters.includes(k)) return { error: `Filter "${k}" is not supported here. Supported filters: ${info.filters.join(", ") || "none"}.` };
    const v = String(raw[k] ?? "").trim();
    if (!v) continue;
    if (k === "agentId" || k === "source") {
      if (!/^\d{1,78}$/.test(v)) return { error: `${k} expects a whole number.` };
    } else if (k === "merchant" || k === "payer" || k === "asset" || k === "token") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return { error: `${k} expects a 0x address.` };
    } else if (k === "symbol") {
      if (!/^[A-Za-z0-9.]{1,12}$/.test(v)) return { error: "symbol expects a stock ticker, e.g. TSLA." };
    } else if (k === "kind") {
      if (!/^[a-z-]{1,24}$/.test(v)) return { error: "kind must be one listed for this dataset." };
    }
    filters[k] = k === "symbol" ? v.toUpperCase() : /^0x/.test(v) ? v.toLowerCase() : v;
  }
  return { view, limit: limitRaw, before, filters };
}

const cursor = (before: string | null): [bigint, number] => {
  if (!before) return [9_223_372_036_854_775_807n, 0]; // the largest bigint: no page started yet
  const [b, l] = before.split(":");
  return [BigInt(b!), Number(l ?? 0)];
};

async function cursorOf(sql: Sql, id: string): Promise<bigint> {
  const [row] = await sql<{ last_block: string }[]>`select last_block::text as last_block from indexer_state where id = ${id}`;
  return BigInt(row?.last_block ?? 0);
}

/** Small read cache for chain snapshots, so repeated calls inside `cacheMs` cost one set of RPC reads. */
const snapshotCache = new Map<string, { at: number; value: DatasetResult }>();
async function cached(ctx: DatasetCtx, key: string, fn: () => Promise<DatasetResult>): Promise<DatasetResult> {
  const hit = snapshotCache.get(key);
  if (hit && Date.now() - hit.at < ctx.cfg.data!.cacheMs) return hit.value;
  const value = await fn();
  snapshotCache.set(key, { at: Date.now(), value });
  if (snapshotCache.size > 500) snapshotCache.delete(snapshotCache.keys().next().value as string);
  return value;
}

// ------------------------------------------------------------------ 1 agents

const AGENT_KINDS: Record<string, string> = {
  Registered: "registered",
  VerificationPaid: "verified",
  Attested: "attested",
  AttestationCleared: "attestation-cleared",
  SessionOpened: "policy",
  PolicySet: "policy",
  PolicyIncreased: "policy",
  PolicyDecreased: "policy",
  SessionPaused: "policy",
  SessionUnpaused: "policy",
  SessionRevoked: "policy",
  IncreaseProposed: "increase-queued",
  IncreaseCancelled: "increase-cancelled",
};

async function agents(ctx: DatasetCtx, q: DatasetQuery): Promise<DatasetResult> {
  const { sql } = ctx;
  const asOfBlock = await cursorOf(sql, "main");
  if (q.view === "probes") {
    const id = q.before ? BigInt(q.before.split(":")[0]!) : 9_223_372_036_854_775_807n;
    const rows = await sql<{ id: string; agent_id: string; probed_at: Date; endpoints_live: boolean; registration_valid: boolean; domain_verified: boolean; attest_tx: string | null }[]>`
      select id::text as id, agent_id::text as agent_id, probed_at, endpoints_live, registration_valid, domain_verified, attest_tx from data_probe_history
      where id < ${id.toString()} ${q.filters.agentId ? sql`and agent_id = ${q.filters.agentId}` : sql``}
      order by id desc limit ${q.limit}`;
    const records = rows.map((r) => ({
      agentId: r.agent_id,
      probedAt: unix(r.probed_at),
      endpointsLive: r.endpoints_live,
      registrationValid: r.registration_valid,
      domainVerified: r.domain_verified,
      attestTx: r.attest_tx,
      source: "orrery-prober",
    }));
    return { records, asOfBlock, next: rows.length === q.limit ? rows[rows.length - 1]!.id : null };
  }
  const events = Object.entries(AGENT_KINDS)
    .filter(([, kind]) => !q.filters.kind || kind === q.filters.kind)
    .map(([e]) => e);
  if (events.length === 0) return { records: [], asOfBlock, next: null };
  const [b, l] = cursor(q.before);
  const rows = await sql<{ block_number: string; log_index: number; tx_hash: string; address: string; event: string; args: Record<string, unknown> }[]>`
    select block_number::text as block_number, log_index, tx_hash, address, event, args from chain_events
    where event in ${sql(events)} and (block_number, log_index) < (${b.toString()}::bigint, ${l})
      ${q.filters.agentId ? sql`and args->>'agentId' = ${q.filters.agentId}` : sql``}
    order by block_number desc, log_index desc limit ${q.limit}`;
  const records = rows.map((r) => ({
    kind: AGENT_KINDS[r.event]!,
    event: r.event,
    agentId: r.args.agentId === undefined ? null : String(r.args.agentId),
    contract: r.address,
    args: canonicalArgs(r.args),
    block: r.block_number,
    tx: r.tx_hash,
    logIndex: r.log_index,
  }));
  return { records, asOfBlock, next: rows.length === q.limit ? `${rows[rows.length - 1]!.block_number}:${rows[rows.length - 1]!.log_index}` : null };
}

/** Event arguments as canonical record values: every number that is not a safe integer becomes a string. */
function canonicalArgs(v: unknown): DataRecord[string] {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : String(v);
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(canonicalArgs);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, canonicalArgs(x)]));
  return String(v);
}

// ------------------------------------------------------------------ 2 agent economy

async function agentEconomy(ctx: DatasetCtx, q: DatasetQuery): Promise<DatasetResult> {
  const { sql } = ctx;
  const [top] = await sql<{ b: string | null }[]>`select max(block_number)::text as b from data_payment_blocks`;
  const asOfBlock = BigInt(top?.b ?? 0);
  const f = q.filters;
  const where = sql`p.status = 'settled' ${f.payer ? sql`and p.payer = ${f.payer}` : sql``} ${f.asset ? sql`and p.asset = ${f.asset}` : sql``}
    ${f.merchant ? sql`and (m.merchant = ${f.merchant} or dp.provider = ${f.merchant} or p.pay_to = ${f.merchant})` : sql``}`;
  if (q.view === "payments") {
    const [b, l] = cursor(q.before);
    const rows = await sql<{ tx_hash: string; block_number: string; log_index: number; payer: string; pay_to: string; merchant: string | null; provider: string | null; asset: string; amount: string; method: string; created_at: Date }[]>`
      select p.tx_hash, pb.block_number::text as block_number, pb.log_index, p.payer, p.pay_to, m.merchant, dp.provider, p.asset, p.amount::text as amount, p.method, p.created_at
      from facilitator_payments p join data_payment_blocks pb on pb.tx_hash = p.tx_hash
      left join merchants m on m.splitter = p.pay_to left join data_providers dp on dp.splitter = p.pay_to
      where ${where} and (pb.block_number, pb.log_index) < (${b.toString()}::bigint, ${l})
      order by pb.block_number desc, pb.log_index desc limit ${q.limit}`;
    const records = rows.map((r) => ({
      payer: r.payer,
      payTo: r.pay_to,
      merchant: r.merchant,
      provider: r.provider,
      asset: r.asset,
      amount: r.amount,
      method: r.method,
      settledAt: unix(r.created_at),
      block: r.block_number,
      tx: r.tx_hash,
      logIndex: r.log_index,
    }));
    return { records, asOfBlock, next: rows.length === q.limit ? `${rows[rows.length - 1]!.block_number}:${rows[rows.length - 1]!.log_index}` : null };
  }
  if (q.view === "daily") {
    const rows = await sql<{ day: string; asset: string; n: string; amount: string; from_block: string; to_block: string }[]>`
      select to_char(date_trunc('day', p.created_at at time zone 'UTC'), 'YYYY-MM-DD') as day, p.asset, count(*)::text as n, sum(p.amount)::text as amount,
        min(pb.block_number)::text as from_block, max(pb.block_number)::text as to_block
      from facilitator_payments p join data_payment_blocks pb on pb.tx_hash = p.tx_hash
      left join merchants m on m.splitter = p.pay_to left join data_providers dp on dp.splitter = p.pay_to
      where ${where} and p.created_at > now() - interval '30 days'
      group by 1, 2 order by 1 desc, 2 limit ${q.limit}`;
    return { records: rows.map((r) => ({ day: r.day, asset: r.asset, payments: Number(r.n), amount: r.amount, fromBlock: r.from_block, toBlock: r.to_block })), asOfBlock, next: null };
  }
  const rows = await sql<{ pay_to: string; merchant: string | null; provider: string | null; name: string | null; asset: string; n: string; amount: string; from_block: string; to_block: string }[]>`
    select p.pay_to, max(m.merchant) as merchant, max(dp.provider) as provider, coalesce(max(m.name), max(dp.name)) as name, p.asset, count(*)::text as n,
      sum(p.amount)::text as amount, min(pb.block_number)::text as from_block, max(pb.block_number)::text as to_block
    from facilitator_payments p join data_payment_blocks pb on pb.tx_hash = p.tx_hash
    left join merchants m on m.splitter = p.pay_to left join data_providers dp on dp.splitter = p.pay_to
    where ${where} and p.created_at > now() - interval '30 days'
    group by p.pay_to, p.asset order by sum(p.amount) desc limit ${q.limit}`;
  const records = rows.map((r, i) => ({
    rank: i + 1,
    payTo: r.pay_to,
    merchant: r.merchant,
    provider: r.provider,
    name: r.name,
    asset: r.asset,
    payments: Number(r.n),
    amount: r.amount,
    fromBlock: r.from_block,
    toBlock: r.to_block,
  }));
  return { records, asOfBlock, next: null };
}

// ------------------------------------------------------------------ 3 stock corporate actions

const STOCK_KINDS: Record<string, string> = {
  UIMultiplierUpdated: "multiplier",
  OraclePaused: "oracle-paused",
  OracleUnpaused: "oracle-unpaused",
  Paused: "paused",
  Unpaused: "unpaused",
  Blocked: "blocked",
  Unblocked: "unblocked",
};

function stocksFor(cfg: Config, symbol?: string): DataStock[] {
  return cfg.data!.stocks.filter((s) => !symbol || s.symbol === symbol);
}

async function stockActions(ctx: DatasetCtx, q: DatasetQuery): Promise<DatasetResult> {
  const { cfg, chain, sql } = ctx;
  if (q.view === "events") {
    const asOfBlock = await cursorOf(sql, "data");
    const bySymbol = new Map(cfg.data!.stocks.map((s) => [lower(s.token), s.symbol]));
    const tokens = stocksFor(cfg, q.filters.symbol).map((s) => lower(s.token));
    const [b, l] = cursor(q.before);
    const rows = await sql<{ block_number: string; log_index: number; tx_hash: string; address: string; source: string; event: string; args: Record<string, unknown>; block_time: Date }[]>`
      select block_number::text as block_number, log_index, tx_hash, address, source, event, args, block_time from data_events
      where source in ('stock', 'issuer') and (block_number, log_index) < (${b.toString()}::bigint, ${l})
        ${q.filters.symbol ? sql`and source = 'stock' and address in ${sql(tokens.length ? tokens : ["0x"])}` : sql``}
      order by block_number desc, log_index desc limit ${q.limit}`;
    const records = rows.map((r) => ({
      kind: STOCK_KINDS[r.event] ?? r.event,
      event: r.event,
      scope: r.source === "issuer" ? "issuer" : "token",
      symbol: r.source === "stock" ? (bySymbol.get(r.address) ?? null) : null,
      contract: r.address,
      args: canonicalArgs(r.args),
      time: unix(r.block_time),
      block: r.block_number,
      tx: r.tx_hash,
      logIndex: r.log_index,
    }));
    return { records, asOfBlock, next: rows.length === q.limit ? `${rows[rows.length - 1]!.block_number}:${rows[rows.length - 1]!.log_index}` : null };
  }
  return cached(ctx, `stock-state:${q.filters.symbol ?? ""}`, async () => {
    const block = await chain.public.getBlock();
    const at = block.number!;
    const records: DataRecord[] = [];
    for (const s of stocksFor(cfg, q.filters.symbol)) {
      const read = <T>(address: Address, abi: readonly unknown[], functionName: string) =>
        chain.public.readContract({ address, abi: abi as never, functionName, blockNumber: at } as never) as Promise<T>;
      const [multiplier, effectiveAt, paused, oraclePaused, round] = await Promise.all([
        read<bigint>(s.token, tokenAbi, "uiMultiplier"),
        read<bigint>(s.token, tokenAbi, "effectiveAt"),
        read<boolean>(s.token, tokenAbi, "paused"),
        read<boolean>(s.token, tokenAbi, "oraclePaused"),
        read<readonly [bigint, bigint, bigint, bigint, bigint]>(s.feed, aggregatorV3Abi, "latestRoundData"),
      ]);
      const updatedAt = round[3];
      records.push({
        symbol: s.symbol,
        token: lower(s.token),
        feed: lower(s.feed),
        paused,
        oraclePaused,
        uiMultiplier: multiplier.toString(),
        multiplierEffectiveAt: effectiveAt.toString(),
        feedUpdatedAt: Number(updatedAt),
        feedState: feedState(cfg, block.timestamp, updatedAt, oraclePaused),
        block: at.toString(),
      });
    }
    return { records, asOfBlock: at, next: null };
  });
}

/** D-12: derived feed state only, never the answer. */
function feedState(cfg: Config, now: bigint, updatedAt: bigint, oraclePaused: boolean): string {
  if (updatedAt === 0n || now - updatedAt > BigInt(cfg.data!.feedStaleSeconds)) return "stale";
  return oraclePaused ? "paused" : "live";
}

// ------------------------------------------------------------------ 4 stock liquidity

const Q96 = 2n ** 96n;
/** sqrt(1.01) − 1, scaled by 1e12 (0.004987562112). */
const SQRT_1_01_MINUS_1_E12 = 4_987_562_112n;

async function stockLiquidity(ctx: DatasetCtx, q: DatasetQuery): Promise<DatasetResult> {
  const { cfg, chain } = ctx;
  const pm = cfg.data!.poolManager;
  return cached(ctx, `stock-liquidity:${q.filters.symbol ?? ""}`, async () => {
    const block = await chain.public.getBlock();
    const at = block.number!;
    const records: DataRecord[] = [];
    if (!pm) return { records, asOfBlock: at, next: null };
    const usdg = lower(cfg.addresses.usdg);
    for (const s of stocksFor(cfg, q.filters.symbol)) {
      if (!s.poolId) continue;
      const slot = poolStateSlot(s.poolId);
      const liqSlot = `0x${(BigInt(slot) + 3n).toString(16).padStart(64, "0")}` as Hex;
      const [slot0, liqWord, decimals, round, oraclePaused] = await Promise.all([
        chain.public.readContract({ address: pm, abi: poolManagerAbi, functionName: "extsload", args: [slot], blockNumber: at }),
        chain.public.readContract({ address: pm, abi: poolManagerAbi, functionName: "extsload", args: [liqSlot], blockNumber: at }),
        chain.public.readContract({ address: s.token, abi: tokenAbi, functionName: "decimals", blockNumber: at }),
        chain.public.readContract({ address: s.feed, abi: aggregatorV3Abi, functionName: "latestRoundData", blockNumber: at }),
        chain.public.readContract({ address: s.token, abi: tokenAbi, functionName: "oraclePaused", blockNumber: at }),
      ]);
      const sqrtP = BigInt(slot0 as Hex) & ((1n << 160n) - 1n);
      const tickRaw = Number((BigInt(slot0 as Hex) >> 160n) & 0xffffffn);
      const tick = tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw;
      const liquidity = BigInt(liqWord as Hex) & ((1n << 128n) - 1n);
      if (sqrtP === 0n) continue; // not initialised
      const stockIs0 = lower(s.token) < usdg;
      const scale = 10n ** BigInt(decimals as number);
      // USDG base units per one whole stock token
      const priceUsdg = stockIs0 ? (sqrtP * sqrtP * scale) / (Q96 * Q96) : (scale * Q96 * Q96) / (sqrtP * sqrtP);
      // USDG to move the price 1% in USDG's direction, in-range liquidity only (ticks crossed in the move are not counted)
      const depthUsdg = stockIs0 ? (liquidity * sqrtP * SQRT_1_01_MINUS_1_E12) / (Q96 * 1_000_000_000_000n) : (liquidity * Q96 * SQRT_1_01_MINUS_1_E12) / (sqrtP * 1_000_000_000_000n);
      const feedDecimals = BigInt(await chain.public.readContract({ address: s.feed, abi: aggregatorV3Abi, functionName: "decimals", blockNumber: at }));
      const answer = (round as readonly bigint[])[1]!;
      const feedUsd6 = answer > 0n ? (answer * 1_000_000n) / 10n ** feedDecimals : 0n;
      records.push({
        symbol: s.symbol,
        token: lower(s.token),
        poolId: s.poolId,
        priceUsdg: priceUsdg.toString(),
        liquidity: liquidity.toString(),
        tick,
        depthUsdg1Pct: depthUsdg.toString(),
        spreadToFeedBps: feedUsd6 > 0n ? Number(((priceUsdg - feedUsd6) * 10_000n) / feedUsd6) : null,
        feedState: feedState(cfg, block.timestamp, (round as readonly bigint[])[3]!, oraclePaused as boolean),
        block: at.toString(),
      });
    }
    return { records, asOfBlock: at, next: null };
  });
}

// ------------------------------------------------------------------ 5 Pons launches

async function ponsLaunches(ctx: DatasetCtx, q: DatasetQuery): Promise<DatasetResult> {
  const { cfg, chain, sql } = ctx;
  if (q.view === "events") {
    const asOfBlock = await cursorOf(sql, "data");
    const events = q.filters.kind === "launched" ? ["TokenLaunched"] : q.filters.kind === "graduated" ? ["PoolGraduated"] : ["TokenLaunched", "PoolGraduated"];
    const [b, l] = cursor(q.before);
    const rows = await sql<{ block_number: string; log_index: number; tx_hash: string; event: string; args: Record<string, unknown>; block_time: Date }[]>`
      select block_number::text as block_number, log_index, tx_hash, event, args, block_time from data_events
      where source = 'pons' and event in ${sql(events)} and (block_number, log_index) < (${b.toString()}::bigint, ${l})
        ${q.filters.token ? sql`and args->>'token' = ${q.filters.token}` : sql``}
      order by block_number desc, log_index desc limit ${q.limit}`;
    const records = rows.map((r) => ({
      kind: r.event === "TokenLaunched" ? "launched" : "graduated",
      token: String(r.args.token),
      args: canonicalArgs(r.args),
      time: unix(r.block_time),
      block: r.block_number,
      tx: r.tx_hash,
      logIndex: r.log_index,
    }));
    return { records, asOfBlock, next: rows.length === q.limit ? `${rows[rows.length - 1]!.block_number}:${rows[rows.length - 1]!.log_index}` : null };
  }
  // curves: the quote each recent, not yet graduated curve holds over its graduation threshold (derived, section 0)
  const limit = Math.min(q.limit, 50);
  return cached(ctx, `pons-curves:${limit}:${q.filters.token ?? ""}`, async () => {
    const at = (await chain.public.getBlock()).number!;
    const rows = await sql<{ args: Record<string, unknown>; block_number: string; tx_hash: string; log_index: number }[]>`
      select l.args, l.block_number::text as block_number, l.tx_hash, l.log_index from data_events l
      where l.source = 'pons' and l.event = 'TokenLaunched' ${q.filters.token ? sql`and l.args->>'token' = ${q.filters.token}` : sql``}
        and not exists (select 1 from data_events g where g.source = 'pons' and g.event = 'PoolGraduated' and g.args->>'token' = l.args->>'token')
      order by l.block_number desc, l.log_index desc limit ${limit}`;
    const records: DataRecord[] = [];
    for (const r of rows) {
      const curve = getAddress(String(r.args.curve));
      const pair = String(r.args.pairToken);
      const threshold = BigInt(String(r.args.graduationThreshold));
      const held = /^0x0{40}$/i.test(pair)
        ? await chain.public.getBalance({ address: curve, blockNumber: at })
        : await chain.public.readContract({ address: getAddress(pair), abi: tokenAbi, functionName: "balanceOf", args: [curve], blockNumber: at });
      const bps = threshold > 0n ? Number((held * 10_000n) / threshold) : 0;
      records.push({
        token: String(r.args.token),
        curve: lower(curve),
        pairToken: lower(pair),
        graduationThreshold: threshold.toString(),
        quoteHeld: held.toString(),
        progressBps: Math.min(bps, 10_000),
        launchBlock: r.block_number,
        launchTx: r.tx_hash,
        block: at.toString(),
      });
    }
    return { records, asOfBlock: at, next: null };
  });
}

// ------------------------------------------------------------------ 6 ORRY economy

async function orryEconomy(ctx: DatasetCtx, q: DatasetQuery): Promise<DatasetResult> {
  const { cfg, sql } = ctx;
  if (!cfg.orry) throw new DatasetUnavailable("ORRY economy data begins once the ORRY contracts open.");
  const orryCursor = await cursorOf(sql, "orry");
  // burns come from three indexers; each record is at or before its own indexer's cursor, so the highest one bounds all
  const asOfBlock = q.view === "burns" ? [orryCursor, await cursorOf(sql, "facilitator"), await cursorOf(sql, "data")].reduce((a, b) => (a > b ? a : b)) : orryCursor;
  const [b, l] = cursor(q.before);
  const page = <T extends { block_number: string; log_index: number }>(rows: T[]) => (rows.length === q.limit ? `${rows[rows.length - 1]!.block_number}:${rows[rows.length - 1]!.log_index}` : null);
  if (q.view === "burns") {
    const src = q.filters.source ? Number(q.filters.source) : null;
    const rows = await sql<{ block_number: string; log_index: number; tx_hash: string; address: string; source: string; amount: string; block_time: Date }[]>`
      select * from (
        select block_number::text as block_number, log_index, tx_hash, address, args->>'source' as source, args->>'amount' as amount, block_time from orry_events where event = 'Burned'
        union all
        select block_number::text, log_index, tx_hash, address, args->>'source', args->>'amount', block_time from facilitator_events where event = 'Burned'
        union all
        select block_number::text, log_index, tx_hash, address, args->>'source', args->>'amount', block_time from data_events where event = 'Burned'
      ) x where (block_number::bigint, log_index) < (${b.toString()}::bigint, ${l}) ${src !== null ? sql`and source = ${String(src)}` : sql``}
      order by block_number::bigint desc, log_index desc limit ${q.limit}`;
    const records = rows.map((r) => ({
      source: Number(r.source),
      label: BURN_SOURCE_LABELS[Number(r.source)] ?? null,
      amount: r.amount,
      contract: r.address,
      time: unix(r.block_time),
      block: r.block_number,
      tx: r.tx_hash,
      logIndex: r.log_index,
    }));
    return { records, asOfBlock, next: page(rows) };
  }
  if (q.view === "fees") {
    const rows = await sql<{ block_number: string; log_index: number; tx_hash: string; address: string; source: string; event: string; args: Record<string, unknown>; block_time: Date }[]>`
      select block_number::text as block_number, log_index, tx_hash, address, source, event, args, block_time from orry_events
      where event in ('ProtocolFeesCollected', 'Distributed', 'Synced', 'Harvested') and (block_number, log_index) < (${b.toString()}::bigint, ${l})
      order by block_number desc, log_index desc limit ${q.limit}`;
    const records = rows.map((r) => ({ event: r.event, contract: r.address, from: r.source, args: canonicalArgs(r.args), time: unix(r.block_time), block: r.block_number, tx: r.tx_hash, logIndex: r.log_index }));
    return { records, asOfBlock, next: page(rows) };
  }
  if (q.view === "stake") {
    const [s] = await sql<{ stakers: string; plain: string; leaving: string; agent: string }[]>`
      select count(*) filter (where plain_active + agent_active > 0)::text as stakers, coalesce(sum(plain_active), 0)::text as plain,
        coalesce(sum(plain_leaving), 0)::text as leaving, coalesce(sum(agent_active), 0)::text as agent from orry_stakers`;
    return { records: [{ stakers: Number(s!.stakers), plainActive: s!.plain, plainLeaving: s!.leaving, agentActive: s!.agent, block: asOfBlock.toString() }], asOfBlock, next: null };
  }
  if (q.view === "price") {
    const rows = await sql<{ sampled_at: Date; block_number: string; ratio_num: string | null; ratio_den: string | null }[]>`
      select sampled_at, block_number::text as block_number, ratio_num::text as ratio_num, ratio_den::text as ratio_den from orry_price_samples
      where ratio_num is not null order by sampled_at desc limit ${q.limit}`;
    const records = rows.map((r) => ({
      sampledAt: unix(r.sampled_at),
      // ORRY base units per 1 USD (USDG at 1 USD), from the hub price at that block
      orryPerUsd: ((1_000_000n * BigInt(r.ratio_num!)) / BigInt(r.ratio_den!)).toString(),
      block: r.block_number,
    }));
    return { records, asOfBlock, next: null };
  }
  const rows = await sql<{ address: string; stake: string }[]>`select address, (plain_active + agent_active)::text as stake from orry_stakers
    where plain_active + agent_active > 0 order by plain_active + agent_active desc, address asc limit ${Math.min(q.limit, 100)}`;
  return { records: rows.map((r, i) => ({ rank: i + 1, address: maskAddress(r.address), stake: r.stake, block: asOfBlock.toString() })), asOfBlock, next: null };
}

// ------------------------------------------------------------------ 7 chain health

const SAMPLE_BLOCKS = 1_000n;

async function chainHealth(ctx: DatasetCtx): Promise<DatasetResult> {
  const { chain, sql } = ctx;
  return cached(ctx, "chain-health", async () => {
    const head = await chain.public.getBlock();
    const n = head.number! > SAMPLE_BLOCKS ? SAMPLE_BLOCKS : head.number!;
    const old = await chain.public.getBlock({ blockNumber: head.number! - n });
    const gasPrice = await chain.public.getGasPrice();
    const rows = await sql<{ id: string; last_block: string; updated_at: Date }[]>`select id, last_block::text as last_block, updated_at from indexer_state order by id`;
    const msPerBlock = n > 0n ? Number(((head.timestamp - old.timestamp) * 1000n) / n) : null;
    return {
      records: [
        {
          block: head.number!.toString(),
          timestamp: Number(head.timestamp),
          msPerBlock,
          sampleBlocks: Number(n),
          blocksPerDay: msPerBlock ? Math.floor(86_400_000 / msPerBlock) : null,
          baseFeeWei: head.baseFeePerGas?.toString() ?? null,
          gasPriceWei: gasPrice.toString(),
          indexers: rows.map((r) => ({ id: r.id, last: r.last_block, behind: (head.number! - BigInt(r.last_block)).toString(), updatedAt: unix(r.updated_at) })),
        },
      ],
      asOfBlock: head.number!,
      next: null,
    };
  });
}

// ------------------------------------------------------------------ dispatch and counts

export async function runDataset(ctx: DatasetCtx, id: DatasetId, q: DatasetQuery): Promise<DatasetResult> {
  switch (id) {
    case "agents":
      return agents(ctx, q);
    case "agent-economy":
      return agentEconomy(ctx, q);
    case "stock-actions":
      return stockActions(ctx, q);
    case "stock-liquidity":
      return stockLiquidity(ctx, q);
    case "pons-launches":
      return ponsLaunches(ctx, q);
    case "orry-economy":
      return orryEconomy(ctx, q);
    case "chain-health":
      return chainHealth(ctx);
  }
}

/** Records each dataset holds now (event tables), for the catalogue; null for snapshots read on demand. */
export async function datasetCounts(ctx: DatasetCtx): Promise<Record<DatasetId, number | null>> {
  const { cfg, sql } = ctx;
  const one = async (q: Promise<{ n: string }[]>) => Number((await q)[0]?.n ?? 0);
  const [agentsN, probesN, payN, stockN, ponsN, burnsN] = await Promise.all([
    one(sql`select count(*)::text as n from chain_events where event in ${sql(Object.keys(AGENT_KINDS))}`),
    one(sql`select count(*)::text as n from data_probe_history`),
    one(sql`select count(*)::text as n from facilitator_payments p join data_payment_blocks pb on pb.tx_hash = p.tx_hash where p.status = 'settled'`),
    one(sql`select count(*)::text as n from data_events where source in ('stock', 'issuer')`),
    one(sql`select count(*)::text as n from data_events where source = 'pons'`),
    cfg.orry ? one(sql`select count(*)::text as n from orry_events where event = 'Burned'`) : Promise.resolve(null as unknown as number),
  ]);
  return {
    agents: agentsN + probesN,
    "agent-economy": payN,
    "stock-actions": stockN,
    "stock-liquidity": null,
    "pons-launches": ponsN,
    "orry-economy": cfg.orry ? burnsN : null,
    "chain-health": null,
  };
}

/** The poolId a v4 pool key hashes to (used by tests and the stock pool notes). */
export const poolIdOf = (currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex =>
  keccak256(encodePacked(["bytes32", "bytes32", "uint256", "int256", "bytes32"], [
    `0x${currency0.slice(2).padStart(64, "0")}` as Hex,
    `0x${currency1.slice(2).padStart(64, "0")}` as Hex,
    BigInt(fee),
    BigInt(tickSpacing),
    `0x${hooks.slice(2).padStart(64, "0")}` as Hex,
  ]));
