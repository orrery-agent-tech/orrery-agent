"use client";

import { useEffect, useRef } from "react";
import { encodeAbiParameters, erc20Abi, getAddress, keccak256, parseAbi, parseAbiParameters, toHex, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { iFeeTiersAbi, iOrryPriceOracleAbi, iSealedBatchMarketAbi } from "@orrery/shared";
import { activeChain } from "../config";
import { receiptOf, useNow, useTx } from "../orry/chain";
import { relayReveal, relayStatus } from "./api";
import { span } from "../orry/format";
import { ORRY } from "../orry/config";
import type { FillStatus, Mode } from "./api";
import { removeOrder, saveOrder, updateOrder, useSealedOrders, type SealedOrder } from "./store";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const marketAbi = iSealedBatchMarketAbi as Abi;

/** Batch windows from the market's fixed start and the two lengths (spec 2.1). */
export interface Phase {
  batch: bigint;
  inCommit: boolean;
  commitStart: number;
  commitEnd: number;
  revealEnd: number;
  /** Seconds left in the current window. */
  left: number;
}
export function phaseAt(now: number, start: number, commitSeconds: number, revealSeconds: number): Phase | undefined {
  const len = commitSeconds + revealSeconds;
  if (!len || !start || now < start) return undefined;
  const n = Math.floor((now - start) / len);
  const commitStart = start + n * len;
  const commitEnd = commitStart + commitSeconds;
  const revealEnd = commitEnd + revealSeconds;
  const inCommit = now < commitEnd;
  return { batch: BigInt(n), inCommit, commitStart, commitEnd, revealEnd, left: (inCommit ? commitEnd : revealEnd) - now };
}

/** Fixed settings of one market, read once. */
export interface MarketChain {
  asset?: Address;
  usdg?: Address;
  orry?: Address;
  feeTiers?: Address;
  orryPrice?: Address;
  start?: number;
  commitSeconds?: number;
  revealSeconds?: number;
  feeBps?: number;
  minNotionalUsdg?: bigint;
  commitFeeUsd?: bigint;
  maxOrders?: number;
  expiry?: number;
  /** Lever L3: extra discount on a fee paid in ORRY, basis points. */
  orryFeeDiscountBps?: number;
  /** R1b: whether unmatched Swap orders fill against the market's Uniswap v4 pool, and how far from the clearing price. */
  poolListed?: boolean;
  /** The remainder pool's Uniswap v4 key (currency0, currency1, fee, tickSpacing, hooks). */
  poolKey?: PoolKey;
  maxDeviationBps?: number;
}
const FIXED = ["asset", "usdg", "orry", "feeTiers", "orryPrice", "start", "commitSeconds", "revealSeconds", "feeBps", "minNotionalUsdg", "commitFeeUsd", "MAX_ORDERS", "EXPIRY", "orryFeeDiscountBps", "remainderPool", "maxDeviationBps"] as const;

export function useMarketChain(market?: Address): MarketChain & { loaded: boolean } {
  const { data, isFetched } = useReadContracts({
    allowFailure: true,
    contracts: FIXED.map((functionName) => ({ address: market ?? ZERO, abi: marketAbi, functionName })),
    query: { enabled: Boolean(market), staleTime: Infinity },
  });
  const v = <T,>(i: number) => {
    const x = data?.[i];
    return x && x.status === "success" ? (x.result as T) : undefined;
  };
  const n = (i: number) => {
    const x = v<bigint | number>(i);
    return x === undefined ? undefined : Number(x);
  };
  return {
    loaded: isFetched,
    asset: v<Address>(0),
    usdg: v<Address>(1),
    orry: v<Address>(2),
    feeTiers: v<Address>(3),
    orryPrice: v<Address>(4),
    start: n(5),
    commitSeconds: n(6),
    revealSeconds: n(7),
    feeBps: n(8),
    minNotionalUsdg: v<bigint>(9),
    commitFeeUsd: v<bigint>(10),
    maxOrders: n(11),
    expiry: n(12),
    orryFeeDiscountBps: n(13),
    poolListed: v<readonly [unknown, boolean]>(14)?.[1],
    poolKey: v<readonly [PoolKey, boolean]>(14)?.[0],
    maxDeviationBps: n(15),
  };
}

type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
/** The Uniswap v4 PoolManager that holds the markets' remainder pools. */
const POOL_MANAGER: Record<number, Address> = { 4663: "0x8366a39cc670b4001a1121b8f6a443a643e40951" };
const extsloadAbi = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const E18 = 10n ** 18n;

/**
 * The remainder pool's own price, in the market's unit (USDG base units per 1e18 asset base units, like the feed
 * price), read from the PoolManager's slot0. The order desk compares it with the clearing band before a seal, the same
 * check the market buy script makes.
 */
export function usePoolPrice(cfg: MarketChain): bigint | undefined {
  const key = cfg.poolListed ? cfg.poolKey : undefined;
  const manager = POOL_MANAGER[activeChain.id];
  const slot = key && manager
    ? toHex(BigInt(keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks])), 6n]))), { size: 32 })
    : undefined;
  const { data } = useReadContract({ address: manager, abi: extsloadAbi, functionName: "extsload", args: slot ? [slot] : undefined, query: { enabled: Boolean(slot), refetchInterval: 15_000 } });
  if (!data || !key || !cfg.usdg) return undefined;
  const sqrtP = BigInt(data as Hex) & ((1n << 160n) - 1n);
  if (sqrtP === 0n) return undefined;
  return getAddress(key.currency0) === getAddress(cfg.usdg) ? ((1n << 192n) * E18) / (sqrtP * sqrtP) : (sqrtP * sqrtP * E18) >> 192n;
}

/** Fee discount from ORRY stake (lever L2, thresholds in USD at the ORRY price: R-44, R-46), the tier table, and the
 * ORRY price for the sealing fee (2.3, 2.4). Every discount is 0 while the ORRY price is not ready. */
export interface FeeView {
  discountBps: number;
  tiers: { minStakeUsd: bigint; discountBps: number }[];
  /** USD value (USDG base units) of the account's earning stake now. */
  stakeUsd?: bigint;
  orryReady?: boolean;
  /** ORRY that the sealing fee costs right now; 0n when the market charges none. */
  commitFeeOrry?: bigint;
  loaded: boolean;
}
export function useFeeView(cfg: MarketChain, account?: Address): FeeView {
  const ft = cfg.feeTiers ?? ZERO;
  const rp = cfg.orryPrice ?? ZERO;
  const base = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: ft, abi: iFeeTiersAbi, functionName: "tierCount" },
      { address: rp, abi: iOrryPriceOracleAbi, functionName: "ready" },
      { address: ft, abi: iFeeTiersAbi, functionName: "discountBps", args: [account ?? ZERO] },
    ],
    query: { enabled: Boolean(cfg.feeTiers && cfg.orryPrice), refetchInterval: 15_000 },
  });
  const count = Math.min(Number(base.data?.[0]?.status === "success" ? base.data[0].result : 0), 8);
  const ready = base.data?.[1]?.status === "success" ? (base.data[1].result as boolean) : undefined;
  const tiers = useReadContracts({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, i) => ({ address: ft, abi: iFeeTiersAbi, functionName: "tier" as const, args: [BigInt(i)] as const })),
    query: { enabled: count > 0, staleTime: Infinity },
  });
  const extra = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: rp, abi: iOrryPriceOracleAbi, functionName: "orryFor", args: [cfg.commitFeeUsd ?? 0n] },
      { address: ft, abi: iFeeTiersAbi, functionName: "stakeUsd", args: [account ?? ZERO] },
    ],
    query: { enabled: Boolean(cfg.orryPrice), refetchInterval: 15_000 },
  });
  const commitFee = cfg.commitFeeUsd === undefined ? undefined : cfg.commitFeeUsd === 0n || ready === false ? 0n : extra.data?.[0]?.status === "success" ? (extra.data[0].result as bigint) : undefined;
  return {
    loaded: base.isFetched,
    discountBps: account && base.data?.[2]?.status === "success" ? Number(base.data[2].result) : 0,
    tiers: (tiers.data ?? [])
      .map((t) => (t.status === "success" ? { minStakeUsd: (t.result as readonly [bigint, number])[0], discountBps: Number((t.result as readonly [bigint, number])[1]) } : null))
      .filter((t): t is { minStakeUsd: bigint; discountBps: number } => t !== null),
    stakeUsd: account && extra.data?.[1]?.status === "success" ? (extra.data[1].result as bigint) : undefined,
    orryReady: ready,
    commitFeeOrry: commitFee,
  };
}

/** Wallet balances of the market's two sides and ORRY. */
export function useBalances(cfg: MarketChain, account?: Address) {
  const a = account ?? ZERO;
  const { data, refetch } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: cfg.asset ?? ZERO, abi: erc20Abi, functionName: "balanceOf", args: [a] },
      { address: cfg.usdg ?? ZERO, abi: erc20Abi, functionName: "balanceOf", args: [a] },
      { address: cfg.orry ?? ZERO, abi: erc20Abi, functionName: "balanceOf", args: [a] },
    ],
    query: { enabled: Boolean(account && cfg.asset && cfg.usdg), refetchInterval: 12_000 },
  });
  const v = (i: number) => (data?.[i]?.status === "success" ? (data[i].result as bigint) : undefined);
  return { asset: v(0), usdg: v(1), orry: cfg.orry ? v(2) : undefined, refetch };
}

/** Holdings of every listed stock token for one wallet, by asset address. */
export function useHoldings(assets: Address[], account?: Address) {
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: assets.map((asset) => ({ address: asset, abi: erc20Abi, functionName: "balanceOf" as const, args: [account ?? ZERO] as const })),
    query: { enabled: Boolean(account && assets.length), refetchInterval: 15_000 },
  });
  const out = new Map<string, bigint>();
  assets.forEach((a, i) => {
    const x = data?.[i];
    if (x && x.status === "success") out.set(a.toLowerCase(), x.result as bigint);
  });
  return account ? out : undefined;
}

/** Revealed orders and the result of one batch, straight from the market. */
export function useBatchChain(market?: Address, batch?: bigint) {
  const enabled = Boolean(market && batch !== undefined);
  const head = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: market ?? ZERO, abi: marketAbi, functionName: "orderCount", args: [batch ?? 0n] },
      { address: market ?? ZERO, abi: marketAbi, functionName: "result", args: [batch ?? 0n] },
    ],
    query: { enabled, refetchInterval: 6_000 },
  });
  const count = Math.min(Number(head.data?.[0]?.status === "success" ? (head.data[0].result as bigint) : 0n), 64);
  const rows = useReadContracts({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, i) => ({ address: market ?? ZERO, abi: marketAbi, functionName: "orderAt", args: [batch ?? 0n, BigInt(i)] })),
    query: { enabled: enabled && count > 0, refetchInterval: 12_000 },
  });
  type R = { cleared: boolean; price: bigint; roundId: bigint; assetFilled: bigint; usdgFilled: bigint; usdgFees: bigint; orryFeesBurned: bigint; ordersDropped: number; assetViaPool: bigint; usdgViaPool: bigint };
  const result = head.data?.[1]?.status === "success" ? (head.data[1].result as R) : undefined;
  const orders = (rows.data ?? [])
    .map((r) => {
      if (r.status !== "success") return null;
      const [account, o] = r.result as readonly [Address, { sellAsset: boolean; amountIn: bigint; limitPrice: bigint; mode: number; payFeeInOrry: boolean }];
      return { account, sellAsset: o.sellAsset, amountIn: o.amountIn, limitPrice: o.limitPrice, mode: Number(o.mode) as Mode, payFeeInOrry: o.payFeeInOrry };
    })
    .filter((x) => x !== null);
  return { loaded: head.isFetched, count, orders, result };
}

export interface Approval {
  token: Address;
  symbol: string;
  amount: bigint;
}

/** Seals in progress in this tab: the revealer leaves them alone until the commit has landed or failed. */
const sealing = new Set<string>();

const randomSalt = (): Hex => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
};

/**
 * Seals one order: approvals for what clearing will pull, then the commitment. The order and salt are stored in this
 * browser first; the reveal happens from the page when the batch's reveal window opens (useAutoReveal).
 */
export function useSeal() {
  const pub = usePublicClient();
  const tx = useTx();

  async function seal(p: {
    market: Address;
    symbol: string;
    assetDecimals: number;
    account: Address;
    timing: { start: number; commitSeconds: number; revealSeconds: number };
    order: { sellAsset: boolean; amountIn: bigint; limitPrice: bigint; mode: Mode; payFeeInOrry: boolean };
    approvals: Approval[];
    /** Opt-in: hand the order and salt to Orrery's relay, which reveals it with revealFor. */
    relay?: boolean;
    /** The market had a listed remainder pool when the order was sealed (worded into the result). */
    pooled?: boolean;
  }) {
    let id: string | undefined;
    const ok = await tx.run("Seal order", async ({ send, step }) => {
      if (!pub) throw new Error("The network did not answer. Retry in a few seconds.");
      for (const a of p.approvals) {
        if (a.amount <= 0n) continue;
        const current = await pub.readContract({ address: a.token, abi: erc20Abi, functionName: "allowance", args: [p.account, p.market] });
        if (current >= a.amount) continue;
        step(`Let this market use your ${a.symbol}. Approve in your wallet.`);
        await send({ address: a.token, abi: erc20Abi as Abi, functionName: "approve", args: [p.market, a.amount] });
      }
      // The batch is read after the approvals, from the chain's own clock: the commitment must name the batch it lands in.
      const head = Number((await pub.getBlock()).timestamp);
      const ph = phaseAt(head, p.timing.start, p.timing.commitSeconds, p.timing.revealSeconds);
      if (!ph || !ph.inCommit || ph.commitEnd - head < 3) {
        const wait = ph ? (ph.inCommit ? ph.left + p.timing.revealSeconds : ph.left) : 0;
        throw new Error(`Sealing for this batch is ending. Seal in the next one, which opens in ${span(Math.max(1, wait))}.`);
      }
      const batch = ph.batch;
      const salt = randomSalt();
      const commitment = (await pub.readContract({ address: p.market, abi: marketAbi, functionName: "commitmentFor", args: [batch, p.account, p.order, salt] })) as Hex;
      const revealEnd = Number((await pub.readContract({ address: p.market, abi: marketAbi, functionName: "revealEnd", args: [batch] })) as bigint);
      id = `${activeChain.id}:${p.market.toLowerCase()}:${batch}:${p.account.toLowerCase()}`;
      sealing.add(id);
      saveOrder({
        id,
        chainId: activeChain.id,
        market: p.market,
        symbol: p.symbol,
        assetDecimals: p.assetDecimals,
        account: p.account,
        batch: batch.toString(),
        order: { ...p.order, amountIn: p.order.amountIn.toString(), limitPrice: p.order.limitPrice.toString() },
        salt,
        commitment,
        commitEnd: revealEnd - p.timing.revealSeconds,
        revealEnd,
        state: "sealing",
        pooled: p.pooled,
        createdAt: Math.floor(Date.now() / 1000),
      });
      step("Sign the seal in your wallet.");
      let sent: Hex | undefined;
      try {
        const hash = await send({ address: p.market, abi: marketAbi, functionName: "commit", args: [commitment] }, (h) => {
          sent = h;
          updateOrder(id!, { commitTx: h });
        });
        const r = await receiptOf(pub as PublicClient, hash);
        updateOrder(id, { state: "sealed", commitTx: hash, commitBlock: r.blockNumber.toString() });
        if (p.relay) {
          step("Passing the order to Orrery's relay.");
          try {
            const r = await relayReveal({ market: p.market, account: p.account, batch: batch.toString(), order: { ...p.order, amountIn: p.order.amountIn.toString(), limitPrice: p.order.limitPrice.toString(), mode: p.order.mode === 1 ? "swap" : "limit" }, salt });
            if (r.status === "failed") throw new Error(r.reason ?? "relay refused");
            updateOrder(id, { relay: true, relayStatus: r.status });
          } catch {
            // The order stays with this page, which reveals it as usual.
            return `Your order is sealed in batch ${batch}. The relay could not take it, so your wallet prompts the reveal here instead.`;
          }
          return `Your order is sealed in batch ${batch}. Orrery's relay reveals it inside the reveal window, so this tab may close.`;
        }
      } catch (e) {
        // A seal the wallet already published stays with this page: once the commit window passes, the commitment on
        // chain decides whether it is kept (and revealed here) or dropped. Only a seal that never went out is removed.
        if (sent && !(e instanceof Error && /reverted on chain/.test(e.message))) {
          return `Your seal is on its way in batch ${batch}. This page confirms it on chain and prompts the reveal when the window opens.`;
        }
        removeOrder(id);
        throw e;
      } finally {
        sealing.delete(id);
      }
      return `Your order is sealed in batch ${batch}. Once that reveal window opens, your wallet prompts the reveal here.`;
    });
    return ok ? id : undefined;
  }

  return { seal, busy: tx.busy, notice: tx.notice, setNotice: tx.setNotice };
}

/**
 * Reveals this wallet's sealed orders from the browser as soon as each batch's reveal window opens, then follows the
 * batch to its result. Mounted once per market page.
 */
export function useAutoReveal(account?: Address) {
  const pub = usePublicClient();
  const orders = useSealedOrders();
  const now = useNow(1000);
  const tx = useTx();
  const inFlight = useRef(new Set<string>());
  const lastCheck = useRef(new Map<string, number>());

  const mine = orders.filter((o) => o.chainId === activeChain.id && account && o.account.toLowerCase() === account.toLowerCase());

  async function reveal(o: SealedOrder, manual = false) {
    if (!pub || inFlight.current.has(o.id)) return;
    inFlight.current.add(o.id);
    try {
      // The reveal lands in a block: wait until the chain itself has passed the end of the commit window.
      const head = await pub.getBlock();
      if (Number(head.timestamp) < o.commitEnd) return;
      updateOrder(o.id, { state: "revealing", waitForClick: false });
      const order = { ...o.order, amountIn: BigInt(o.order.amountIn), limitPrice: BigInt(o.order.limitPrice) };
      let hash: Hex | undefined;
      const ok = await tx.run(manual ? "Reveal" : `Reveal ${o.symbol} order`, async ({ send }) => {
        hash = await send({ address: o.market, abi: marketAbi, functionName: "reveal", args: [order, o.salt] });
        return `Your ${o.symbol} order is revealed in batch ${o.batch}. Settlement follows when the batch clears.`;
      });
      // A request closed in the wallet (or any failure) waits for the person's click instead of reopening the wallet.
      if (ok && hash) updateOrder(o.id, { state: "revealed", revealTx: hash });
      else updateOrder(o.id, { state: "sealed", waitForClick: true });
    } catch {
      updateOrder(o.id, { state: "sealed", waitForClick: true });
    } finally {
      inFlight.current.delete(o.id);
    }
  }

  async function reconcile(o: SealedOrder) {
    if (!pub) return;
    inFlight.current.add(o.id);
    try {
      const onChain = (await pub.readContract({ address: o.market, abi: marketAbi, functionName: "commitmentOf", args: [BigInt(o.batch), o.account] })) as Hex;
      if (onChain.toLowerCase() === o.commitment.toLowerCase()) updateOrder(o.id, { state: "sealed", waitForClick: false });
      else removeOrder(o.id);
    } catch {
      // Read again on the next tick.
    } finally {
      inFlight.current.delete(o.id);
    }
  }

  /** A relayed order: follow the relay's status; if it reports a failure while the window is open, this page reveals. */
  async function followRelay(o: SealedOrder) {
    const last = lastCheck.current.get(`relay:${o.id}`) ?? 0;
    if (Date.now() - last < 5000) return;
    lastCheck.current.set(`relay:${o.id}`, Date.now());
    try {
      const r = await relayStatus(o.market, o.batch, o.account);
      if (r.status === "failed") updateOrder(o.id, { relay: false, relayStatus: "failed", waitForClick: false });
      else if ((r.status === "sent" || r.status === "revealed") && r.tx) updateOrder(o.id, { state: "revealed", revealTx: r.tx, relayStatus: r.status });
      else if (r.status !== o.relayStatus) updateOrder(o.id, { relayStatus: r.status });
    } catch {
      // Read again on the next tick; after the window the Revealed event decides.
    }
  }

  async function settle(o: SealedOrder) {
    if (!pub || inFlight.current.has(o.id)) return;
    const last = lastCheck.current.get(o.id) ?? 0;
    if (Date.now() - last < 4000) return;
    lastCheck.current.set(o.id, Date.now());
    inFlight.current.add(o.id);
    try {
      const fromBlock = o.commitBlock ? BigInt(o.commitBlock) : undefined;
      const args = { batch: BigInt(o.batch), account: o.account };
      // A relayed order: once its reveal window has ended, the Revealed event says whether the relay revealed it.
      if (o.relay && o.state === "sealed") {
        const revealed = await pub.getContractEvents({ address: o.market, abi: iSealedBatchMarketAbi, eventName: "Revealed", args, fromBlock });
        if (revealed.length === 0) {
          updateOrder(o.id, { state: "missed" });
          return;
        }
        updateOrder(o.id, { state: "revealed", revealTx: revealed[0].transactionHash ?? undefined });
      }
      const r = (await pub.readContract({ address: o.market, abi: marketAbi, functionName: "result", args: [BigInt(o.batch)] })) as { cleared: boolean; price: bigint };
      if (!r.cleared) {
        const expiry = Number((await pub.readContract({ address: o.market, abi: marketAbi, functionName: "EXPIRY" })) as bigint);
        if (Math.floor(Date.now() / 1000) > o.revealEnd + expiry) updateOrder(o.id, { state: "settled", outcome: { status: "expired", inputUsed: "0", output: "0", usdgFee: "0", orryFee: "0" } });
        return;
      }
      const [filled, dropped] = await Promise.all([
        pub.getContractEvents({ address: o.market, abi: iSealedBatchMarketAbi, eventName: "OrderFilled", args, fromBlock }),
        pub.getContractEvents({ address: o.market, abi: iSealedBatchMarketAbi, eventName: "OrderDropped", args, fromBlock }),
      ]);
      const f = filled[0]?.args as { inputUsed?: bigint; output?: bigint; usdgFee?: bigint; orryFee?: bigint } | undefined;
      const tx = (filled[0] ?? dropped[0])?.transactionHash;
      const amountIn = BigInt(o.order.amountIn);
      let status: FillStatus = "unfilled";
      if (dropped.length) status = "dropped";
      else if (f && (f.output ?? 0n) > 0n) status = (f.inputUsed ?? 0n) >= amountIn ? "filled" : "partial";
      updateOrder(o.id, {
        state: "settled",
        outcome: {
          status,
          inputUsed: String(f?.inputUsed ?? 0n),
          output: String(f?.output ?? 0n),
          usdgFee: String(f?.usdgFee ?? 0n),
          orryFee: String(f?.orryFee ?? 0n),
          price: r.price.toString(),
          clearTx: tx ?? undefined,
        },
      });
    } catch {
      // Read again on the next tick.
    } finally {
      inFlight.current.delete(o.id);
    }
  }

  useEffect(() => {
    for (const o of mine) {
      if (o.state === "sealed" && !o.relay && now >= o.revealEnd) updateOrder(o.id, { state: "missed" });
      else if (o.state === "sealed" && o.relay && now >= o.revealEnd) void settle(o);
      else if (o.state === "sealed" && o.relay && now >= o.commitEnd - 5) void followRelay(o);
      else if (o.state === "sealed" && !o.relay && !o.waitForClick && now >= o.commitEnd + 1 && now < o.revealEnd) void reveal(o);
      else if (o.state === "revealed" && now >= o.revealEnd) void settle(o);
    }
    // Orders left mid-request by a closed tab: a reveal goes back to waiting for a click, and a seal is kept only if
    // its commitment is on chain once the commit window has passed.
    for (const o of mine) {
      if (inFlight.current.has(o.id) || sealing.has(o.id)) continue;
      if (o.state === "revealing" && !tx.busy) updateOrder(o.id, { state: "sealed", waitForClick: true });
      if (o.state === "sealing" && now > o.commitEnd) void reconcile(o);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  return { orders: mine, all: orders, now, notice: tx.notice, busy: tx.busy, revealNow: (o: SealedOrder) => reveal(o, true), dismiss: removeOrder };
}
