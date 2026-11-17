"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BaseError, ContractFunctionRevertedError, HttpRequestError, RpcRequestError, TimeoutError, WaitForTransactionReceiptTimeoutError, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { useBalance, useConnection, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { iEarnVaultAbi, iEarnVaultFactoryAbi, iOrryRewardsRouterAbi, iOrryStakingAbi, iOrryTokenAbi } from "@orrery/shared";
import { activeChain } from "../config";
import { ORRY } from "./config";
import { span, utc } from "./format";

export function useNow(step = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), step);
    return () => clearInterval(t);
  }, [step]);
  return now;
}

/** Connected, on the right chain, with an address. */
export function useWallet() {
  const { address, isConnected, chainId } = useConnection();
  const ready = Boolean(isConnected && address && chainId === activeChain.id);
  return { address: ready ? (address as Address) : undefined, connected: isConnected, ready };
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Periods set in the constructors: lock, cooldowns, stream, distribute interval. Read once. Earn periods come from the
 * factory's first vault (every vault is built with the same constants). */
export function useOrryConstants() {
  const { data: firstVault } = useReadContract({ address: ORRY.earnFactory ?? ZERO, abi: iEarnVaultFactoryAbi, functionName: "vaultAt", args: [0n], query: { enabled: Boolean(ORRY.earnFactory), staleTime: Infinity } });
  const v = (firstVault as Address | undefined) ?? ZERO;
  const s = ORRY.staking ?? ZERO;
  const r = ORRY.router ?? ZERO;
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: v, abi: iEarnVaultAbi, functionName: "DEPOSIT_LOCK" },
      { address: v, abi: iEarnVaultAbi, functionName: "STREAM_PERIOD" },
      { address: s, abi: iOrryStakingAbi, functionName: "PLAIN_COOLDOWN" },
      { address: s, abi: iOrryStakingAbi, functionName: "AGENT_COOLDOWN" },
      { address: s, abi: iOrryStakingAbi, functionName: "STREAM_PERIOD" },
      { address: r, abi: iOrryRewardsRouterAbi, functionName: "MIN_INTERVAL" },
    ],
    query: { staleTime: Infinity, enabled: Boolean(firstVault || ORRY.staking || ORRY.router) },
  });
  const n = (i: number) => {
    const x = data?.[i];
    return x && x.status === "success" ? Number(x.result as bigint | number) : undefined;
  };
  return {
    depositLock: firstVault ? n(0) : undefined,
    earnStream: firstVault ? n(1) : undefined,
    plainCooldown: ORRY.staking ? n(2) : undefined,
    agentCooldown: ORRY.staking ? n(3) : undefined,
    stakeStream: ORRY.staking ? n(4) : undefined,
    distributeInterval: ORRY.router ? n(5) : undefined,
  };
}

/** Live stake, rewards and balances of one address, straight from the contracts (fresh after every transaction). Earn
 * positions, one per vault, come from useEarnPositions (lib/orry/earn.ts). */
export function useAccountChain(address?: Address) {
  const s = ORRY.staking ?? ZERO;
  const t = ORRY.token ?? ZERO;
  const a = address ?? ZERO;
  const { data, refetch, isFetched } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: s, abi: iOrryStakingAbi, functionName: "plainStake", args: [a] },
      { address: s, abi: iOrryStakingAbi, functionName: "pendingRewards", args: [a] },
      { address: s, abi: iOrryStakingAbi, functionName: "earningBalance", args: [a] },
      { address: t, abi: iOrryTokenAbi, functionName: "balanceOf", args: [a] },
    ],
    query: { enabled: Boolean(address), refetchInterval: 12_000 },
  });
  const ethBal = useBalance({ address, query: { enabled: Boolean(address), refetchInterval: 12_000 } });
  const ok = <T,>(i: number, has: unknown): T | undefined => {
    const x = data?.[i];
    return has && x && x.status === "success" ? (x.result as T) : undefined;
  };
  const plain = ok<readonly [bigint, bigint, bigint | number]>(0, ORRY.staking);
  const rewards = ok<readonly [bigint, bigint]>(1, ORRY.staking);
  return {
    loaded: isFetched,
    refetch: () => {
      void refetch();
      void ethBal.refetch();
    },
    stakeActive: plain?.[0],
    stakeLeaving: plain?.[1],
    stakeReadyAt: Number(plain?.[2] ?? 0),
    rewardsEth: rewards?.[0],
    rewardsOrry: rewards?.[1],
    earning: ok<bigint>(2, ORRY.staking),
    orryBalance: ok<bigint>(3, ORRY.token),
    ethBalance: ethBal.data?.value,
  };
}

const until = (t: unknown) => Number(t ?? 0) - Math.floor(Date.now() / 1000);

/** Plain messages for the contracts' custom errors. */
const ERRORS: Record<string, (args: readonly unknown[]) => string> = {
  SharesLocked: (a) => (until(a[0]) > 0 ? `These shares stay locked for ${span(until(a[0]))} more.` : "The lock on these shares is ending now. Send it again shortly."),
  PriceMovedInBlock: () => "The pool price shifted inside this block. Send it again in the next one.",
  SlippageExceeded: () => "The price left the bounds you set. Send again, or widen the slippage.",
  DeadlinePassed: () => "The deadline passed before the transaction landed. Send a fresh one.",
  InsufficientShares: () => "The amount exceeds the shares you hold.",
  ZeroAmount: () => "Amount must be greater than zero.",
  HubNotRegistered: () => "Deposits begin once the ORRY pool is live.",
  NothingReady: () => "No withdrawal has matured yet.",
  InsufficientActive: () => "The amount exceeds your active stake.",
  NotAgentController: () => "Staking for this agent is open to its owner and its agent wallet.",
  NotStaker: () => "This stake moves only from the address that placed it.",
  PositionHeldByAnotherStaker: () => "This agent already carries a stake from a different address.",
  AgentStakeLocked: (a) => `The stake on this agent stays locked until ${utc(Number(a[0] ?? 0))}.`,
  InexactTransfer: () => "The amount received differs from the amount sent.",
  TooSoon: (a) => (until(a[0]) > 0 ? `Rewards were distributed a short while ago. The next round opens in ${span(until(a[0]))}.` : "Rewards were distributed a short while ago. Send it again shortly."),
  NothingToDistribute: () => "No rewards are queued for distribution.",
  QuoteExpired: () => "This quote is out of date. Request a fresh quote.",
  QuoteUsed: () => "This quote has been spent. Request a fresh quote.",
  BadQuoteSignature: () => "The quote signature did not check out. Request a fresh quote.",
  CoinNotSet: () => "Paying in ORRY becomes available shortly.",
  DailyVerificationCap: () => "Today's ORRY verifications are all taken. Pay in USDG, or pay in ORRY again after 00:00 UTC.",
  InexactBurn: () => "The burned amount differs from the amount requested.",
  EthTransferFailed: () => "Your address did not accept the ETH payout.",
  // Sealed batch markets (wave R1).
  WrongPhase: () => "This batch has moved on to its next phase. Seal your order in the following batch.",
  AlreadyCommitted: () => "This wallet has already sealed an order in this batch. A new batch starts shortly.",
  BatchFull: () => "This batch has no room left. Seal your order in the following batch.",
  BadReveal: () => "The revealed order differs from the one you sealed.",
  BelowMinimum: () => "Order size is under this market's minimum.",
  AlreadyCleared: () => "This batch is already settled.",
  Expired: () => "This batch ended with no clearing price, so no funds moved.",
  BadRound: () => "The price reading belongs to a different round than this batch.",
  StalePrice: () => "The stock price for this batch has not arrived yet.",
  DeviationTooHigh: () => "The pool price sits too far from the batch price to clear now.",
  // Merchant payment addresses (wave 3).
  SplitterExists: () => "A payment address already exists for this.",
  NothingToForward: () => "No balance is waiting to be forwarded.",
};

export function explain(e: unknown, fallback: string): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      const f = ERRORS[reverted.data.errorName];
      if (f) return f(reverted.data.args ?? []);
    }
    if (/reject|denied/i.test(e.shortMessage + e.message)) return "The wallet request was dismissed.";
    if (/insufficient funds/i.test(e.message)) return "The ETH balance does not cover the amount plus gas.";
    if (e.walk((x) => x instanceof RpcRequestError || x instanceof HttpRequestError || x instanceof TimeoutError)) return `${fallback} The network did not answer in time. Send it again in a few seconds.`;
    return `${fallback} ${e.shortMessage}`.trim();
  }
  const msg = e instanceof Error ? e.message : "";
  if (/reject|denied/i.test(msg)) return "The wallet request was dismissed.";
  return msg ? `${fallback} ${msg.split("\n")[0]}` : fallback;
}

export type Notice = { tone: "ok" | "error" | ""; text: string } | null;

/**
 * The receipt of a transaction the wallet has already published. A read that fails on the way (a rate limit, an
 * endpoint that has not seen the block yet) is retried: the transaction is on its way either way, so only a long silence
 * ends the wait.
 */
export async function receiptOf(pub: PublicClient, hash: Hex): Promise<TransactionReceipt> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    } catch (e) {
      if (attempt >= 4 || e instanceof WaitForTransactionReceiptTimeoutError) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/**
 * Sends contract calls in order from the connected wallet and waits for each receipt. Every read refreshes after.
 * `approve` steps are skipped when the allowance already covers the amount.
 */
export function useTx() {
  const pub = usePublicClient();
  const qc = useQueryClient();
  const { address: account } = useConnection();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  /** `onSent` hears the hash as soon as the wallet publishes, before the receipt: the caller knows it went out. */
  async function send(c: Call, onSent?: (hash: Hex) => void): Promise<Hex> {
    if (!pub) throw new Error("The network is out of reach. Check the connection and send again.");
    // Simulating first surfaces the contract's own error before the wallet opens.
    await pub.simulateContract({ ...c, account } as never).catch((e) => {
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) throw e;
    });
    const hash = await writeContractAsync(c as never);
    onSent?.(hash);
    const r = await receiptOf(pub as PublicClient, hash);
    if (r.status !== "success") throw new Error("The transaction was reverted on chain.");
    return hash;
  }

  async function ensureAllowance(owner: Address, spender: Address, amount: bigint, step: (t: string) => void) {
    if (!pub || !ORRY.token) throw new Error("The ORRY token address is not set for this network.");
    const current = await pub.readContract({ address: ORRY.token, abi: iOrryTokenAbi, functionName: "allowance", args: [owner, spender] });
    if (current >= amount) return;
    step("Your wallet asks you to approve ORRY first.");
    await send({ address: ORRY.token, abi: iOrryTokenAbi as Abi, functionName: "approve", args: [spender, amount] });
  }

  async function run(label: string, fn: (h: { send: typeof send; step: (t: string) => void; ensureAllowance: typeof ensureAllowance }) => Promise<string | void>) {
    setBusy(label);
    setNotice({ tone: "", text: `${label}. Waiting for your wallet.` });
    try {
      const done = await fn({ send, step: (t) => setNotice({ tone: "", text: t }), ensureAllowance });
      setNotice({ tone: "ok", text: done || `${label} is on record.` });
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      setNotice({ tone: "error", text: explain(e, `${label} was not completed.`) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { run, busy, notice, setNotice };
}
