import { decodeEventLog, parseAbi, type Abi, type Log } from "viem";
import { orreryAttestorAbi, orreryPolicyModuleAbi } from "@orrery/shared";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import { toJson } from "./check.js";
import { logLine } from "./log.js";

/**
 * Indexer (14 §6): address-filtered eth_getLogs in ranges of at most 10,000 blocks into Postgres. Health is lag against
 * the chain head, never "backfill finished".
 */

const registryEvents = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const ABI = [...orreryPolicyModuleAbi, ...orreryAttestorAbi, ...registryEvents] as Abi;
const STATE_ID = "main";

export interface IndexerOptions {
  startBlock: bigint;
  range?: bigint;
  includeRegistry?: boolean;
}

function decode(log: Log): { event: string; args: unknown } {
  try {
    const d = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
    return { event: d.eventName ?? "unknown", args: toJson(d.args) };
  } catch {
    return { event: "unknown", args: { topics: log.topics, data: log.data } };
  }
}

/** One step: index up to `range` blocks. Returns the new cursor and the lag in blocks. */
export async function indexOnce(cfg: Config, chain: Chain, sql: Sql, opts: IndexerOptions): Promise<{ last: bigint; head: bigint; lag: bigint; logs: number }> {
  const range = opts.range ?? 10_000n;
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : opts.startBlock;
  const head = await chain.public.getBlockNumber();
  if (from > head) {
    await sql`update indexer_state set head_block = ${head.toString()}, updated_at = now() where id = ${STATE_ID}`;
    return { last: from - 1n, head, lag: 0n, logs: 0 };
  }
  const to = from + range - 1n < head ? from + range - 1n : head;
  const addresses = [cfg.addresses.module, cfg.addresses.attestor];
  if (opts.includeRegistry ?? true) addresses.push(cfg.addresses.registry);
  const logs = await chain.public.getLogs({ address: addresses, fromBlock: from, toBlock: to });
  await sql.begin(async (tx) => {
    for (const log of logs) {
      const { event, args } = decode(log);
      await tx`insert into chain_events (block_number, log_index, tx_hash, address, event, args)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${log.address.toLowerCase()}, ${event}, ${tx.json(args as never)})
        on conflict do nothing`;
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head, lag: head - to, logs: logs.length };
}

export async function lag(sql: Sql): Promise<{ last: bigint; head: bigint; lag: bigint; updatedAt: Date } | null> {
  const [s] = await sql<{ last_block: string; head_block: string; updated_at: Date }[]>`select last_block, head_block, updated_at from indexer_state where id = ${STATE_ID}`;
  if (!s) return null;
  return { last: BigInt(s.last_block), head: BigInt(s.head_block), lag: BigInt(s.head_block) - BigInt(s.last_block), updatedAt: s.updated_at };
}

const heads = new WeakMap<Chain, { at: number; head: bigint }>();

/**
 * The live chain head, read at most every `maxAgeMs`. Health and alerts measure lag against it: the head an indexer
 * stores freezes together with its cursor when it stops, so lag against the stored head stays near zero.
 */
export async function chainHead(chain: Chain, maxAgeMs = 3_000, now: () => number = Date.now): Promise<bigint> {
  const t = now();
  const c = heads.get(chain);
  if (c && t - c.at < maxAgeMs) return c.head;
  const head = await chain.public.getBlockNumber();
  heads.set(chain, { at: t, head });
  return head;
}

/** Blocks a cursor trails the live head by; null without a cursor or a head. */
export const lagBehind = (cursor: { last: bigint } | null, head: bigint | null): bigint | null =>
  cursor && head !== null ? (head > cursor.last ? head - cursor.last : 0n) : null;

/** Indexer health (14 §6): both cursors within `maxLag` of the live head; the ORRY one stays `confirmations` behind by design. */
export function indexerHealth(input: {
  head: bigint | null;
  main: { last: bigint } | null;
  orry: { last: bigint } | null;
  orryOn: boolean;
  maxLag: bigint;
  confirmations: number;
}): { ok: boolean; okMain: boolean; okOrry: boolean; mainLag: bigint | null; orryLag: bigint | null } {
  const mainLag = lagBehind(input.main, input.head);
  const orryLag = lagBehind(input.orry, input.head);
  const okMain = mainLag !== null && mainLag <= input.maxLag;
  const okOrry = !input.orryOn || (orryLag !== null && orryLag <= input.maxLag + BigInt(input.confirmations));
  return { ok: okMain && okOrry, okMain, okOrry, mainLag, orryLag };
}

/** Logs a failing step once a minute at most (the RPC error with its URL removed), and keeps going. */
export async function runIndexer(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  opts: IndexerOptions,
  signal?: AbortSignal,
  log: (line: string) => void = (l) => console.error(l),
): Promise<void> {
  let loggedAt = 0;
  while (!signal?.aborted) {
    try {
      const r = await indexOnce(cfg, chain, sql, opts);
      if (r.lag === 0n) await new Promise((res) => setTimeout(res, 2_000));
    } catch (e) {
      if (Date.now() - loggedAt >= 60_000) {
        log(`indexer step failed: ${logLine(e)}`);
        loggedAt = Date.now();
      }
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }
}
