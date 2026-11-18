import type { Abi, Address, Hex } from "viem";
import {
  aggregatorV3Abi,
  iLimitOrderBookAbi,
  iPredictionMarketAbi,
  iPredictionMarketFactoryAbi,
  iOrryPaymasterAbi,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import type { R2Config } from "./r2-config.js";
import { revertName, sendSimulated } from "./keeper.js";

/**
 * Lane L3 keeper (`docs/updates/L3-R2-SPEC.md` section 7). One pass:
 * - prediction markets past their close: `settle(firstRound)` with the first feed round at or after the close, or
 *   `expire()` once the settle window is over;
 * - stored limit orders: `fill(order, signature)` for each one whose simulation passes (the tip pays the keeper);
 * - paymasters: `refreshRate()` when the cached rate is half its usable age, `flush()` when ORRY is pending.
 * Every transaction is simulated first and sent only when the simulation passes; a failure never stops the next job.
 */

export interface R2Step {
  job: "settle" | "expire" | "fill" | "refresh" | "flush";
  target: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
  txHash?: Hex;
}

const ROUND_BITS = 64n;
const ROUND_MASK = (1n << ROUND_BITS) - 1n;
const SETTLE_WINDOW = 7n * 86_400n;

/**
 * The first round of `feed` with `updatedAt >= close`, walking back from the latest within the proxy's phase. Null when
 * no round is at or after the close yet, or the walk leaves the phase or runs out of steps.
 */
export async function firstRoundAfter(chain: Chain, feed: Address, close: bigint, maxSteps = 200): Promise<bigint | null> {
  const [latest, , , updatedAt] = await chain.public.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
  if (updatedAt < close) return null;
  const phase = latest >> ROUND_BITS;
  let round = latest & ROUND_MASK;
  let found = latest;
  for (let i = 0; i < maxSteps && round > 1n; i++) {
    round -= 1n;
    const id = (phase << ROUND_BITS) | round;
    let at: bigint;
    try {
      [, , , at] = await chain.public.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "getRoundData", args: [id] });
    } catch {
      return null;
    }
    if (at < close) return found;
    found = id;
  }
  return null;
}

export class R2Keeper {
  private readonly finished = new Set<string>();
  private lastFlush = 0;

  constructor(
    private readonly r2: R2Config,
    private readonly chain: Chain,
    private readonly key: Hex,
    private readonly sql: Sql | null,
    private readonly opts: { flushEveryMs?: number; maxFillsPerPass?: number } = {},
  ) {}

  private async send(
    job: R2Step["job"],
    target: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    dryRun: boolean,
  ): Promise<R2Step> {
    const account = this.chain.wallet(this.key).account;
    try {
      await this.chain.public.simulateContract({ address: target, abi, functionName, args, account } as never);
    } catch (e) {
      return { job, target, status: "skipped", reason: revertName(e) };
    }
    if (dryRun) return { job, target, status: "skipped", reason: "dry run" };
    try {
      const txHash = await sendSimulated(this.chain, this.key, { address: target, abi, functionName, args });
      const r = await this.chain.public.waitForTransactionReceipt({ hash: txHash });
      return { job, target, status: r.status === "success" ? "sent" : "failed", txHash };
    } catch (e) {
      return { job, target, status: "failed", reason: revertName(e) };
    }
  }

  async passOnce(opts: { dryRun?: boolean } = {}): Promise<R2Step[]> {
    const dryRun = !!opts.dryRun;
    const steps: R2Step[] = [];
    const now = BigInt((await this.chain.public.getBlock()).timestamp);
    if (this.r2.predictFactory) steps.push(...(await this.predict(now, dryRun)));
    if (this.r2.limitBook && this.sql) steps.push(...(await this.fills(now, dryRun)));
    for (const pm of this.r2.paymasters) steps.push(...(await this.paymaster(pm, now, dryRun)));
    return steps;
  }

  private async predict(now: bigint, dryRun: boolean): Promise<R2Step[]> {
    const f = this.r2.predictFactory!;
    const out: R2Step[] = [];
    const count = await this.chain.public.readContract({ address: f, abi: iPredictionMarketFactoryAbi, functionName: "marketCount" });
    for (let i = 0n; i < count; i++) {
      const m = (await this.chain.public.readContract({ address: f, abi: iPredictionMarketFactoryAbi, functionName: "marketAt", args: [i] })) as Address;
      if (this.finished.has(m)) continue;
      const info = (await this.chain.public.readContract({ address: m, abi: iPredictionMarketAbi, functionName: "info" })) as {
        feed: Address;
        closeTime: bigint;
        status: number;
        yesPool: bigint;
        noPool: bigint;
      };
      if (Number(info.status) !== 0) {
        this.finished.add(m);
        continue;
      }
      const close = BigInt(info.closeTime);
      if (now < close) continue;
      if (now >= close + SETTLE_WINDOW) {
        out.push(await this.send("expire", m, iPredictionMarketAbi as Abi, "expire", [], dryRun));
        continue;
      }
      // a one-sided market refunds whatever round is named
      const round = info.yesPool === 0n || info.noPool === 0n ? 0n : await firstRoundAfter(this.chain, info.feed, close).catch(() => null);
      if (round === null) {
        out.push({ job: "settle", target: m, status: "skipped", reason: "no round after the close yet" });
        continue;
      }
      out.push(await this.send("settle", m, iPredictionMarketAbi as Abi, "settle", [round], dryRun));
    }
    return out;
  }

  private async fills(now: bigint, dryRun: boolean): Promise<R2Step[]> {
    const book = this.r2.limitBook!;
    const sql = this.sql!;
    const rows = await sql<
      { order_hash: string; owner: string; asset: string; sell_asset: boolean; amount_in: string; limit_price: string; tip_bps: number;
        pay_fee_in_orry: boolean; nonce: string; expiry: string; signature: string }[]
    >`select order_hash, owner, asset, sell_asset, amount_in::text, limit_price::text, tip_bps, pay_fee_in_orry, nonce::text, expiry::text, signature
      from limit_orders where status = 'open' and book = ${book.toLowerCase()} and expiry >= ${now.toString()}
      order by last_try asc nulls first limit ${this.opts.maxFillsPerPass ?? 50}`;
    const out: R2Step[] = [];
    for (const r of rows) {
      const order = {
        owner: r.owner as Address,
        asset: r.asset as Address,
        sellAsset: r.sell_asset,
        amountIn: BigInt(r.amount_in),
        limitPrice: BigInt(r.limit_price),
        tipBps: r.tip_bps,
        payFeeInOrry: r.pay_fee_in_orry,
        nonce: BigInt(r.nonce),
        expiry: BigInt(r.expiry),
      };
      const step = await this.send("fill", book, iLimitOrderBookAbi as Abi, "fill", [order, r.signature as Hex], dryRun);
      out.push({ ...step, target: r.order_hash });
      await sql`update limit_orders set last_try = now(), last_error = ${step.status === "sent" ? null : step.reason ?? step.status}
        where order_hash = ${r.order_hash}`;
    }
    return out;
  }

  private async paymaster(pm: Address, now: bigint, dryRun: boolean): Promise<R2Step[]> {
    const out: R2Step[] = [];
    const read = (functionName: string) =>
      this.chain.public.readContract({ address: pm, abi: iOrryPaymasterAbi, functionName } as never) as Promise<unknown>;
    const [rate, params, pendingRecipient, pendingBurn] = await Promise.all([read("cachedRate"), read("params"), read("pendingRecipient"), read("pendingBurn")]);
    const [, at] = rate as readonly [bigint, bigint | number];
    const age = now - BigInt(at);
    if (BigInt(at) === 0n || age * 2n >= BigInt((params as { maxRateAge: number }).maxRateAge)) {
      out.push(await this.send("refresh", pm, iOrryPaymasterAbi as Abi, "refreshRate", [], dryRun));
    }
    const pending = (pendingRecipient as bigint) + (pendingBurn as bigint);
    if (pending > 0n && Date.now() - this.lastFlush >= (this.opts.flushEveryMs ?? 3_600_000)) {
      const step = await this.send("flush", pm, iOrryPaymasterAbi as Abi, "flush", [], dryRun);
      if (step.status === "sent") this.lastFlush = Date.now();
      out.push(step);
    }
    return out;
  }
}
