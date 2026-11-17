import { parseAbi, parseEventLogs, type AbiEvent, type Address, type Log } from "viem";
import { iDataFeeSplitterAbi, iDataProviderRegistryAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { blockTimes } from "./orry-indexer.js";
import { logLine } from "./log.js";

/**
 * Lane L2 indexer: one cursor (`data`) over the provider registry, `DataFeeSplitter`, the configured stock tokens, the
 * stock issuer registry and the Pons V2 factory, filtered by the events the datasets need (transfers are never read),
 * at the confirmation depth; plus the block of each settled x402 payment (from its receipt) for dataset 2 (DA-1).
 */

const STATE_ID = "data";
const lower = (a: unknown) => String(a).toLowerCase();

const stockEvents = parseAbi([
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  "event OraclePaused()",
  "event OracleUnpaused()",
  "event Paused()",
  "event Unpaused()",
]);
const issuerEvents = parseAbi(["event Blocked(address indexed account)", "event Unblocked(address indexed account)", "event Paused()", "event Unpaused()"]);
const ponsEvents = parseAbi([
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
]);
const erc20Transfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

type Source = "registry" | "splitter" | "stock" | "issuer" | "pons";

const eventsOf = (abi: readonly unknown[]): AbiEvent[] => (abi as AbiEvent[]).filter((x) => x.type === "event");

/** Addresses to read and the source each belongs to. */
function sources(cfg: Config): Map<string, Source> {
  const d = cfg.data!;
  const m = new Map<string, Source>();
  if (d.registry) m.set(lower(d.registry), "registry");
  if (d.splitter) m.set(lower(d.splitter), "splitter");
  for (const s of d.stocks) m.set(lower(s.token), "stock");
  if (d.issuerRegistry) m.set(lower(d.issuerRegistry), "issuer");
  if (d.ponsFactory) m.set(lower(d.ponsFactory), "pons");
  return m;
}

const ABI_BY_SOURCE: Record<Source, AbiEvent[]> = {
  registry: eventsOf(iDataProviderRegistryAbi),
  splitter: eventsOf(iDataFeeSplitterAbi),
  stock: eventsOf(stockEvents),
  issuer: eventsOf(issuerEvents),
  pons: eventsOf(ponsEvents),
};

/** Every event signature any source can emit, deduplicated by name and inputs (`Paused()` belongs to two sources). */
function topicEvents(m: Map<string, Source>): AbiEvent[] {
  const seen = new Map<string, AbiEvent>();
  for (const src of new Set(m.values())) for (const e of ABI_BY_SOURCE[src]) seen.set(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`, e);
  return [...seen.values()];
}

const jsonArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v]));

export async function indexDataOnce(cfg: Config, chain: Chain, sql: Sql, range = 10_000n): Promise<{ last: bigint; head: bigint; logs: number }> {
  const d = cfg.data!;
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : d.startBlock;
  const head = await chain.public.getBlockNumber();
  const safe = head > BigInt(cfg.confirmations) ? head - BigInt(cfg.confirmations) : 0n;
  if (from > safe) return { last: from - 1n, head, logs: 0 };
  const to = from + range - 1n < safe ? from + range - 1n : safe;
  const map = sources(cfg);
  const logs = map.size ? ((await chain.public.getLogs({ address: [...map.keys()] as Address[], events: topicEvents(map), fromBlock: from, toBlock: to, strict: false })) as Log[]) : [];
  const sorted = [...logs].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex! - y.logIndex! : x.blockNumber! < y.blockNumber! ? -1 : 1));
  const times = await blockTimes(chain, sorted);
  await sql.begin(async (tx) => {
    for (const log of sorted) {
      const source = map.get(lower(log.address));
      if (!source) continue;
      const [decoded] = parseEventLogs({ abi: ABI_BY_SOURCE[source], logs: [log], strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
      if (!decoded) continue;
      const args = jsonArgs(decoded.args ?? {});
      const time = times.get(log.blockNumber!)!;
      const ins = await tx`insert into data_events (block_number, log_index, tx_hash, address, source, event, args, block_time)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${lower(log.address)}, ${source}, ${decoded.eventName}, ${tx.json(args as never)}, ${time})
        on conflict do nothing returning log_index`;
      if (ins.length !== 1 || source !== "registry") continue;
      if (decoded.eventName === "Listed") {
        await tx`insert into data_providers (provider, splitter, endpoint, name, description, price_usdg, listed_block, listed_tx, listed_at, updated_at)
          values (${String(args.provider)}, ${String(args.splitter)}, ${String(decoded.args.endpoint)}, ${String(decoded.args.name)}, ${String(decoded.args.description)},
            ${String(args.priceUsdg)}, ${log.blockNumber!.toString()}, ${log.transactionHash!}, ${time}, ${time})
          on conflict (provider) do update set splitter = excluded.splitter, endpoint = excluded.endpoint, name = excluded.name, description = excluded.description,
            price_usdg = excluded.price_usdg, listed_block = excluded.listed_block, listed_tx = excluded.listed_tx, listed_at = excluded.listed_at, updated_at = excluded.updated_at`;
      } else if (decoded.eventName === "Updated") {
        await tx`update data_providers set endpoint = ${String(decoded.args.endpoint)}, name = ${String(decoded.args.name)}, description = ${String(decoded.args.description)},
          price_usdg = ${String(args.priceUsdg)}, updated_at = ${time} where provider = ${String(args.provider)}`;
      } else if (decoded.eventName === "Unlisted") {
        await tx`delete from data_providers where provider = ${String(args.provider)}`;
      }
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head, logs: sorted.length };
}

/** Names the block and log of settled x402 payments that have none yet (dataset 2, DA-1). */
export async function resolvePaymentBlocks(chain: Chain, sql: Sql, max = 50): Promise<number> {
  const rows = await sql<{ tx_hash: string; asset: string; payer: string; pay_to: string; amount: string }[]>`
    select p.tx_hash, p.asset, p.payer, p.pay_to, p.amount::text as amount from facilitator_payments p
    where p.status = 'settled' and p.tx_hash is not null and not exists (select 1 from data_payment_blocks b where b.tx_hash = p.tx_hash)
    order by p.updated_at limit ${max}`;
  let done = 0;
  for (const r of rows) {
    const receipt = await chain.public.getTransactionReceipt({ hash: r.tx_hash as `0x${string}` }).catch(() => null);
    if (!receipt) continue;
    const t = parseEventLogs({ abi: erc20Transfer, eventName: "Transfer", logs: receipt.logs }).find(
      (l) => lower(l.address) === r.asset && lower(l.args.from) === r.payer && lower(l.args.to) === r.pay_to && l.args.value === BigInt(r.amount),
    );
    if (!t) continue; // a settlement whose receipt shows no such transfer is never served (DA-1)
    await sql`insert into data_payment_blocks (tx_hash, block_number, log_index) values (${r.tx_hash}, ${receipt.blockNumber.toString()}, ${t.logIndex})
      on conflict do nothing`;
    done++;
  }
  return done;
}

export async function dataLag(sql: Sql): Promise<{ last: bigint; head: bigint } | null> {
  const [row] = await sql<{ last_block: string; head_block: string }[]>`select last_block::text, head_block::text from indexer_state where id = ${STATE_ID}`;
  return row ? { last: BigInt(row.last_block), head: BigInt(row.head_block) } : null;
}

export async function runDataIndexer(cfg: Config, chain: Chain, sql: Sql, signal?: AbortSignal, log: (m: string) => void = () => {}): Promise<void> {
  let lastError = 0;
  while (!signal?.aborted) {
    try {
      const r = await indexDataOnce(cfg, chain, sql);
      await resolvePaymentBlocks(chain, sql);
      if (r.head - r.last > BigInt(cfg.confirmations) + 1n) continue;
    } catch (e) {
      if (Date.now() - lastError > 60_000) log(`data indexer step failed: ${logLine(e)}`);
      lastError = Date.now();
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

