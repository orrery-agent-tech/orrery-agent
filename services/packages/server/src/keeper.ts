import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex } from "viem";
import { NATIVE_ETH, iEarnVaultAbi, iEarnVaultFactoryAbi, iOrryBuybackAbi, iOrryRewardsRouterAbi, iOrreryHookAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import { hubsOf } from "./orry-price.js";

/**
 * ORRY keeper (build spec §5), multi-pair (R-35 to R-38): `collect` (only while the hook holds protocol fees),
 * `harvest` on every Earn vault, `executeSlice`, `distribute`, `burnEth`, then `buyWithQuote` for every hub quote other
 * than ETH that the buyback holds. In that order, so the hook's fees and the slice's ORRY reach the router before it
 * distributes, and what it forwards reaches the buyback before it buys. Every call is simulated first and sent only when
 * the simulation says it would do something (no revert, and a non-zero result where the function returns amounts).
 * Gas comes from the keeper key alone.
 */

export type KeeperAction = "collect" | "harvest" | "executeSlice" | "distribute" | "burnEth" | "buyWithQuote";

export interface KeeperStep {
  action: KeeperAction;
  target: Address;
  /** The quote token of `buyWithQuote`, or the vault's quote of `harvest`. */
  quote?: Address;
  status: "sent" | "skipped" | "failed";
  /** Revert name from the simulation (for example `TooSoon`, `NothingToDistribute`), "nothing to do", or the failure. */
  reason?: string;
  txHash?: Hex;
  /** The simulated result, as decimal strings. */
  result?: string[];
}

interface Job {
  action: KeeperAction;
  target: Address;
  abi: Abi;
  args?: readonly unknown[];
  quote?: Address;
  /** Checked before simulating: false skips the job as "nothing to do". */
  due?: () => Promise<boolean>;
}

async function jobs(cfg: Config, chain: Chain): Promise<Job[]> {
  const rc = cfg.orry;
  if (!rc) throw new Error("ORRY contracts are not configured");
  const hubs = await hubsOf(rc, chain);
  const vaults = (await chain.public.readContract({ address: rc.earnFactory, abi: iEarnVaultFactoryAbi, functionName: "vaults" })) as readonly Address[];
  const others = hubs.filter((h) => h.quote.toLowerCase() !== NATIVE_ETH.toLowerCase()).map((h) => h.quote);
  // collect() returns nothing: what it would pay is the hook's pending protocol fee per currency
  const currencies = [rc.token, NATIVE_ETH, ...others];
  const collectDue = async () => {
    const fees = await Promise.all(currencies.map((c) => chain.public.readContract({ address: rc.hook, abi: iOrreryHookAbi, functionName: "pendingProtocolFee", args: [c] })));
    return fees.some((f) => f > 0n);
  };
  const quoteDue = (quote: Address) => async () =>
    (await chain.public.readContract({ address: rc.buyback, abi: iOrryBuybackAbi, functionName: "maxQuoteIn", args: [quote] })) > 0n;
  return [
    { action: "collect", target: rc.hook, abi: iOrreryHookAbi as Abi, due: collectDue },
    ...vaults.map((v): Job => ({ action: "harvest", target: v, abi: iEarnVaultAbi as Abi })),
    { action: "executeSlice", target: rc.buyback, abi: iOrryBuybackAbi as Abi },
    { action: "distribute", target: rc.router, abi: iOrryRewardsRouterAbi as Abi },
    { action: "burnEth", target: rc.buyback, abi: iOrryBuybackAbi as Abi },
    ...others.map((q): Job => ({ action: "buyWithQuote", target: rc.buyback, abi: iOrryBuybackAbi as Abi, args: [q], quote: q, due: quoteDue(q) })),
  ];
}

const amounts = (r: unknown): bigint[] => (r === undefined ? [] : Array.isArray(r) ? (r as bigint[]) : [r as bigint]);

export function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "reverted";
    return e.shortMessage.split("\n")[0]!;
  }
  return "simulation failed";
}

/**
 * Gas limit for a transaction estimated at the latest block. An exact estimate runs out of gas when the transaction lands
 * in a later second: `OrryStaking` and `EarnVault` write their stream times only when the time moved, and a hub swap
 * writes a new `OrreryHook` oracle checkpoint (a cold storage slot) once the last one is 60 s old. Measured on the 4663
 * PoolManager runtime: a hub swap estimated at 119,543 used 144,836 when a checkpoint fell due before it landed. 20% plus
 * 60,000 covers both cold writes; unused gas is not charged.
 */
export const gasWithHeadroom = (estimate: bigint): bigint => (estimate * 12n) / 10n + 60_000n;

/** Sends a call the caller simulated, with `gasWithHeadroom` over a fresh estimate. */
export async function sendSimulated(chain: Chain, key: Hex, request: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<Hex> {
  const wallet = chain.wallet(key);
  const estimate = await chain.public.estimateContractGas({ ...request, account: wallet.account } as never);
  return wallet.writeContract({ ...request, gas: gasWithHeadroom(estimate), chain: null, account: wallet.account } as never);
}

/** One pass over the five jobs. Steps never stop each other: a failure is recorded and the next job runs. */
export async function runKeeperOnce(cfg: Config, chain: Chain, keeperKey: Hex, opts: { dryRun?: boolean } = {}): Promise<KeeperStep[]> {
  const wallet = chain.wallet(keeperKey);
  const out: KeeperStep[] = [];
  for (const job of await jobs(cfg, chain)) {
    let request;
    let result: bigint[];
    const at = { action: job.action, target: job.target, ...(job.quote ? { quote: job.quote } : {}) };
    try {
      if (job.due && !(await job.due())) {
        out.push({ ...at, status: "skipped", reason: "nothing to do" });
        continue;
      }
      const sim = await chain.public.simulateContract({ address: job.target, abi: job.abi, functionName: job.action, args: job.args, account: wallet.account } as never);
      request = sim.request;
      result = amounts(sim.result);
    } catch (e) {
      out.push({ ...at, status: "skipped", reason: revertName(e) });
      continue;
    }
    if (result.length > 0 && result.every((v) => v === 0n)) {
      out.push({ ...at, status: "skipped", reason: "nothing to do", result: result.map(String) });
      continue;
    }
    if (opts.dryRun) {
      out.push({ ...at, status: "skipped", reason: "dry run", result: result.map(String) });
      continue;
    }
    try {
      const hash = await sendSimulated(chain, keeperKey, request as never);
      const receipt = await chain.public.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs });
      out.push({
        ...at,
        status: receipt.status === "success" ? "sent" : "failed",
        reason: receipt.status === "success" ? undefined : "reverted on chain",
        txHash: hash,
        result: result.map(String),
      });
    } catch (e) {
      out.push({ ...at, status: "failed", reason: revertName(e) });
    }
  }
  return out;
}
