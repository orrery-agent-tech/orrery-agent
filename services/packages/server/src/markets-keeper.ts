import type { Address, Hex } from "viem";
import { aggregatorV3Abi, iMarketFactoryAbi, iSealedBatchMarketAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import { revertName, sendSimulated } from "./keeper.js";

/**
 * Market keeper (`docs/ORRY-R1-SPEC.md` section 5): `clear(batch, roundHint)` at the first block after each batch's
 * reveal window, for every batch with at least one revealed order. `roundHint` is the feed's latest round at or before
 * `revealEnd` (`roundHintFor`). Each clear is simulated first and sent only when the simulation passes. Chain reads
 * only (factory, markets, feeds), so it needs no database. Gas from its own key role (`ORRERY_MARKET_KEEPER_KEY`).
 */

export interface ClearStep {
  market: Address;
  batch: string;
  status: "sent" | "skipped" | "failed";
  /** Revert name from the simulation (for example `StalePrice`, `WrongPhase`), or why nothing was tried. */
  reason?: string;
  roundHint?: string;
  txHash?: Hex;
}

const AGGREGATOR_ROUND_BITS = 64n;
const ROUND_MASK = (1n << AGGREGATOR_ROUND_BITS) - 1n;

/**
 * The feed's newest round with `updatedAt <= revealEnd`, walking back within the proxy's phase (round ids are
 * `phase << 64 | aggregatorRound`). Null when the walk leaves the phase, a round cannot be read, or `maxSteps` runs out:
 * the batch then cannot clear and expires.
 */
export async function roundHintFor(chain: Chain, feed: Address, revealEnd: bigint, maxSteps = 50): Promise<bigint | null> {
  const [latest, , , updatedAt] = await chain.public.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
  if (updatedAt <= revealEnd) return latest;
  const phase = latest >> AGGREGATOR_ROUND_BITS;
  let round = latest & ROUND_MASK;
  for (let i = 0; i < maxSteps && round > 1n; i++) {
    round -= 1n;
    const id = (phase << AGGREGATOR_ROUND_BITS) | round;
    let at: bigint;
    try {
      [, , , at] = await chain.public.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "getRoundData", args: [id] });
    } catch {
      return null;
    }
    if (at === 0n) return null;
    if (at <= revealEnd) return id;
  }
  return null;
}

interface MarketInfo {
  market: Address;
  feed: Address;
  end0: bigint;
  period: bigint;
  expiry: bigint;
  /** Batches below this were looked at and need nothing more. */
  next: bigint;
  /** Batches to try again: true when only the block time was early (`WrongPhase`). */
  retry: Map<bigint, boolean>;
}

/** Revert names after which trying the same batch again cannot succeed. */
const FINAL = new Set(["StalePrice", "BadRound", "AlreadyCleared", "Expired"]);

export class MarketKeeper {
  private markets = new Map<string, MarketInfo>();

  constructor(
    private readonly cfg: Config,
    private readonly chain: Chain,
    private readonly key: Hex,
  ) {
    if (!cfg.markets) throw new Error("ORRERY_MARKET_FACTORY is not configured");
  }

  private read<T>(address: Address, functionName: string, args: unknown[] = []): Promise<T> {
    return this.chain.public.readContract({ address, abi: iSealedBatchMarketAbi, functionName, args } as never) as Promise<T>;
  }

  /** Adds markets the factory created since the last call; a new market is looked at from `keeperLookback` batches back. */
  async refreshMarkets(now: bigint): Promise<number> {
    const factory = this.cfg.markets!.factory;
    const count = await this.chain.public.readContract({ address: factory, abi: iMarketFactoryAbi, functionName: "marketCount" });
    for (let i = BigInt(this.markets.size); i < count; i++) {
      const market = await this.chain.public.readContract({ address: factory, abi: iMarketFactoryAbi, functionName: "marketAt", args: [i] });
      const [feed, end0, end1, expiry] = await Promise.all([
        this.read<Address>(market, "priceFeed"),
        this.read<bigint>(market, "revealEnd", [0n]),
        this.read<bigint>(market, "revealEnd", [1n]),
        this.read<bigint>(market, "EXPIRY"),
      ]);
      const period = end1 - end0;
      const ended = now < end0 ? -1n : (now - end0) / period;
      const back = ended + 1n - BigInt(this.cfg.markets!.keeperLookback);
      this.markets.set(market.toLowerCase(), { market, feed, end0, period, expiry, next: back > 0n ? back : 0n, retry: new Map() });
    }
    return this.markets.size;
  }

  /** Seconds until the next reveal window ends (0 when a batch waits for a later block). */
  secondsUntilNext(now: bigint): bigint {
    let best: bigint | null = null;
    for (const m of this.markets.values()) {
      if ([...m.retry.values()].some((early) => early)) return 0n;
      const ended = now < m.end0 ? -1n : (now - m.end0) / m.period;
      const nextEnd = m.end0 + (ended + 1n) * m.period;
      const wait = nextEnd - now;
      if (best === null || wait < best) best = wait;
    }
    return best ?? 60n;
  }

  /** One pass over every market: each batch whose reveal window has ended by the latest block, once. */
  async passOnce(opts: { dryRun?: boolean } = {}): Promise<{ now: bigint; steps: ClearStep[] }> {
    const now = (await this.chain.public.getBlock()).timestamp;
    await this.refreshMarkets(now);
    const steps: ClearStep[] = [];
    for (const m of this.markets.values()) {
      if (now < m.end0) continue;
      const ended = (now - m.end0) / m.period; // revealEnd(ended) <= now
      const todo = new Set<bigint>(m.retry.keys());
      for (let n = m.next; n <= ended; n++) todo.add(n);
      m.next = ended + 1n;
      for (const n of [...todo].sort((a, b) => (a < b ? -1 : 1))) {
        m.retry.delete(n);
        const step = await this.tryClear(m, n, now, opts.dryRun ?? false);
        if (step) steps.push(step);
      }
    }
    return { now, steps };
  }

  private async tryClear(m: MarketInfo, n: bigint, now: bigint, dryRun: boolean): Promise<ClearStep | null> {
    const revealEnd = m.end0 + n * m.period;
    if (now >= revealEnd + m.expiry) return null;
    const base = { market: m.market, batch: n.toString() };
    let count: bigint;
    let cleared: boolean;
    try {
      [count, { cleared }] = await Promise.all([
        this.read<bigint>(m.market, "orderCount", [n]),
        this.read<{ cleared: boolean }>(m.market, "result", [n]),
      ]);
    } catch (e) {
      m.retry.set(n, false);
      return { ...base, status: "failed", reason: revertName(e) };
    }
    if (count === 0n || cleared) return null; // nothing revealed, or someone cleared it already
    const hint = await roundHintFor(this.chain, m.feed, revealEnd).catch(() => null);
    if (hint === null) return { ...base, status: "skipped", reason: "no feed round at or before the reveal end" };
    const wallet = this.chain.wallet(this.key);
    let request;
    try {
      ({ request } = await this.chain.public.simulateContract({
        address: m.market,
        abi: iSealedBatchMarketAbi,
        functionName: "clear",
        args: [n, hint],
        account: wallet.account,
      }));
    } catch (e) {
      const reason = revertName(e);
      if (!FINAL.has(reason)) m.retry.set(n, reason === "WrongPhase");
      return { ...base, status: "skipped", reason, roundHint: hint.toString() };
    }
    if (dryRun) return { ...base, status: "skipped", reason: "dry run", roundHint: hint.toString() };
    try {
      const txHash = await sendSimulated(this.chain, this.key, request as never);
      const receipt = await this.chain.public.waitForTransactionReceipt({ hash: txHash, timeout: this.cfg.receiptTimeoutMs });
      if (receipt.status !== "success") m.retry.set(n, false);
      return { ...base, status: receipt.status === "success" ? "sent" : "failed", reason: receipt.status === "success" ? undefined : "reverted on chain", roundHint: hint.toString(), txHash };
    } catch (e) {
      m.retry.set(n, false);
      return { ...base, status: "failed", reason: revertName(e), roundHint: hint.toString() };
    }
  }
}
