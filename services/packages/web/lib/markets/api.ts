"use client";

import { useQuery } from "@tanstack/react-query";
import { isAddress, type Address, type Hex } from "viem";
import { API_URL } from "../config";
import { ApiError, big, post, time } from "../orry/api";
import { stockLogo, type StockLogo } from "./logos";

/**
 * Reads from the markets API (docs/ORRY-R1-SPEC.md section 5) in lane C's frozen shapes
 * (services/packages/shared/src/markets.ts on r1/services ff5f9d4). Amounts arrive as decimal strings in base units,
 * times as chain unix seconds; the parsers turn them into bigints and numbers and fill missing fields with neutral values.
 */

export type Mode = 0 | 1; // ISealedBatchMarket.Mode: 0 limit (Dark Pool), 1 swap (Private Swap)

export interface FeedPrice {
  answer: bigint;
  decimals: number;
  updatedAt: number;
  roundId: bigint;
}
export interface MarketParams {
  /** Derived from the market's phase: the start of batch 0. */
  start: number;
  commitSeconds: number;
  revealSeconds: number;
  feeBps: number;
  minNotionalUsdg: bigint;
  commitFeeUsd: bigint;
  maxStaleness: number;
  maxOrders: number;
  expirySeconds: number;
  maxDeviationBps?: number;
  orryFeeDiscountBps?: number;
}
export interface Market {
  market: Address;
  asset: Address;
  symbol: string;
  name: string;
  decimals: number;
  usdg?: Address;
  /** The company's official mark (lib/markets/logos.ts); a market without one is not listed. */
  logo?: StockLogo;
  price: FeedPrice | null;
  /** The feed is within the market's staleness bound: false on weekends and US market holidays, when batches expire. */
  fresh: boolean;
  params: MarketParams;
  /** R1b as the API reports it; the web prefers the market's own reads (useMarketChain). */
  poolListed?: boolean;
}
export interface BatchResult {
  price: bigint;
  roundId: bigint;
  assetFilled: bigint;
  usdgFilled: bigint;
  usdgFees: bigint;
  orryFeesBurned: bigint;
  ordersFilled: number;
  ordersUnfilled: number;
  ordersDropped: number;
  assetViaPool: bigint;
  usdgViaPool: bigint;
  tx?: Hex;
  time?: number;
}
export type BatchStatus = "commit" | "reveal" | "clearing" | "cleared" | "expired";
export interface Batch {
  batch: bigint;
  commitEndsAt: number;
  revealEndsAt: number;
  expiresAt: number;
  commits: number;
  reveals: number;
  status: BatchStatus;
  result?: BatchResult;
}
/** What happened to one order; "partial" is a fill that used less than the whole input. */
export type FillStatus = "filled" | "partial" | "unfilled" | "dropped";
export interface OrderTerms {
  sellAsset: boolean;
  amountIn: bigint;
  limitPrice: bigint;
  mode: Mode;
  payFeeInOrry: boolean;
}
export interface Fill {
  inputUsed: bigint;
  output: bigint;
  usdgFee: bigint;
  orryFee: bigint;
  tx?: Hex;
}
export interface BookOrder extends OrderTerms {
  account: string;
  status?: FillStatus | "revealed" | "expired";
  fill?: Fill;
}
export interface BatchDetail extends Batch {
  orders: BookOrder[];
}
export type HistoryStatus = "committed" | "missed" | "revealed" | "filled" | "partial" | "unfilled" | "dropped" | "expired";
export interface HistoryOrder {
  market: Address;
  symbol: string;
  batch: bigint;
  commitTx?: Hex;
  committedAt: number;
  commitFeeBurned: bigint;
  status: HistoryStatus;
  order?: OrderTerms;
  revealTx?: Hex;
  fill?: Fill;
}

type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return d;
};
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const addr = (v: unknown): Address | undefined => (typeof v === "string" && isAddress(v) ? (v as Address) : undefined);
const hex = (v: unknown): Hex | undefined => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? (v as Hex) : undefined);
const one = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const obj = (v: unknown): J | undefined => (v && typeof v === "object" ? (v as J) : undefined);

const parsePrice = (v: unknown): FeedPrice | null => {
  const o = obj(v);
  if (!o || o.answer === null || o.answer === undefined) return null;
  const answer = big(o.answer);
  return answer > 0n ? { answer, decimals: num(o.decimals, 8), updatedAt: time(o.updatedAt), roundId: big(o.roundId) } : null;
};

const parseMode = (v: unknown): Mode => (v === "swap" || num(v) === 1 ? 1 : 0);

const parseTerms = (o: J): OrderTerms => ({
  sellAsset: o.sellAsset === true || o.sellAsset === "true",
  amountIn: big(o.amountIn),
  limitPrice: big(o.limitPrice),
  mode: parseMode(o.mode),
  payFeeInOrry: o.payFeeInOrry === true || o.payFeeInOrry === "true",
});

const parseFill = (v: unknown): Fill | undefined => {
  const o = obj(v);
  return o ? { inputUsed: big(o.inputUsed), output: big(o.output), usdgFee: big(o.usdgFee), orryFee: big(o.orryFee), tx: hex(o.tx) } : undefined;
};

/** Lane C reports "filled" for any fill; the web reads a fill that used less than the input as partial. */
const fillStatus = (status: string, amountIn: bigint | undefined, fill: Fill | undefined): string =>
  status === "filled" && fill && amountIn !== undefined && fill.inputUsed < amountIn ? "partial" : status;

export function parseMarket(o: J, chainId: number): Market {
  const a = obj(o.asset) ?? { address: o.asset, symbol: o.symbol, name: o.name, decimals: o.decimals };
  const p = obj(o.params) ?? {};
  const ph = obj(o.phase) ?? {};
  const pr = obj(o.price) ?? {};
  const cs = num(p.commitSeconds);
  const rs = num(p.revealSeconds);
  const batch = num(ph.batch);
  const endsAt = time(ph.endsAt);
  const inCommit = ph.inCommit === true;
  // Batch n's commit window starts at start + n × (commit + reveal); the phase pins where batch n is now.
  const commitStart = inCommit ? endsAt - cs : endsAt - cs - rs;
  const asset = addr(a.address) ?? ZERO;
  const symbol = String(a.symbol ?? "");
  return {
    market: addr(o.market) ?? ZERO,
    asset,
    symbol,
    name: String(a.name ?? a.symbol ?? ""),
    decimals: num(a.decimals, 18),
    usdg: addr(o.usdg),
    logo: stockLogo(chainId, asset, symbol),
    price: parsePrice(o.price),
    fresh: pr.fresh !== false,
    poolListed: obj(o.remainderPool) ? (o.remainderPool as J).listed === true : undefined,
    params: {
      start: endsAt && cs + rs > 0 ? commitStart - batch * (cs + rs) : 0,
      commitSeconds: cs,
      revealSeconds: rs,
      feeBps: num(p.feeBps),
      minNotionalUsdg: big(p.minNotionalUsdg),
      commitFeeUsd: big(p.commitFeeUsd),
      maxStaleness: num(p.maxStaleness),
      maxOrders: num(p.maxOrders, 64),
      expirySeconds: num(p.expirySeconds, 86_400),
      maxDeviationBps: p.maxDeviationBps === undefined ? undefined : num(p.maxDeviationBps),
      orryFeeDiscountBps: p.orryFeeDiscountBps === undefined ? undefined : num(p.orryFeeDiscountBps),
    },
  };
}

const parseResult = (v: unknown): BatchResult | undefined => {
  const o = obj(v);
  if (!o) return undefined;
  return {
    price: big(o.price),
    roundId: big(o.roundId),
    assetFilled: big(o.assetFilled),
    usdgFilled: big(o.usdgFilled),
    usdgFees: big(o.usdgFees),
    orryFeesBurned: big(o.orryFeesBurned),
    ordersFilled: num(o.ordersFilled),
    ordersUnfilled: num(o.ordersUnfilled),
    ordersDropped: num(o.ordersDropped),
    assetViaPool: big(o.assetViaPool),
    usdgViaPool: big(o.usdgViaPool),
    tx: hex(o.tx),
    time: o.time === undefined || o.time === null ? undefined : time(o.time),
  };
};

export const parseBatch = (o: J): Batch => ({
  batch: big(o.batch),
  commitEndsAt: time(o.commitEndsAt),
  revealEndsAt: time(o.revealEndsAt),
  expiresAt: time(o.expiresAt),
  commits: num(o.commits),
  reveals: num(o.reveals),
  status: one(o.status, ["commit", "reveal", "clearing", "cleared", "expired"] as const, "clearing"),
  result: parseResult(o.result),
});

export const parseBatchDetail = (o: J): BatchDetail => ({
  ...parseBatch(o),
  orders: ((o.orders ?? []) as J[]).map((r) => {
    const t = parseTerms(r);
    const fill = parseFill(r.fill);
    return {
      ...t,
      account: String(r.account ?? ""),
      fill,
      status: r.status === undefined ? undefined : (fillStatus(String(r.status), t.amountIn, fill) as BookOrder["status"]),
    };
  }),
});

export const parseHistory = (o: J): HistoryOrder => {
  const order = obj(o.order) ? parseTerms(o.order as J) : undefined;
  const fill = parseFill(o.fill);
  const st = one(o.status, ["committed", "missed", "revealed", "filled", "unfilled", "dropped", "expired"] as const, "committed");
  return {
    market: addr(o.market) ?? ZERO,
    symbol: String(o.symbol ?? ""),
    batch: big(o.batch),
    commitTx: hex(o.commitTx),
    committedAt: time(o.committedAt),
    commitFeeBurned: big(o.commitFeeBurned),
    status: fillStatus(st, order?.amountIn, fill) as HistoryStatus,
    order,
    revealTx: hex(o.revealTx),
    fill,
  };
};

async function get<T>(path: string): Promise<T> {
  if (!API_URL) throw new ApiError(0, "no api");
  const r = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `Request failed (${r.status}).`);
  return body;
}

const live = { refetchInterval: 10_000, retry: 1 } as const;

/** Markets with their official logo only (owner rule: a stock without its real mark is not listed), and the gap
 * between chain time and this browser's clock for countdowns. */
export const useMarkets = (chainId: number) =>
  useQuery({
    queryKey: ["markets", "list", chainId],
    queryFn: async () => {
      const body = await get<J>("/v1/markets");
      const all = ((body.markets ?? []) as J[]).map((m) => parseMarket(m, chainId));
      const chainTime = body.chainTime === undefined ? undefined : time(body.chainTime);
      return { markets: all.filter((m) => m.symbol && m.logo), unlisted: all.filter((m) => !m.logo).map((m) => m.symbol || m.asset), skew: chainTime ? chainTime - Math.floor(Date.now() / 1000) : 0 };
    },
    enabled: Boolean(API_URL),
    ...live,
  });

export const useBatches = (market?: Address, limit = 12) =>
  useQuery({
    queryKey: ["markets", "batches", market?.toLowerCase(), limit],
    queryFn: async () => {
      const body = await get<J>(`/v1/markets/${market}/batches?limit=${limit}`);
      return ((body.batches ?? body.items ?? []) as J[]).map(parseBatch);
    },
    enabled: Boolean(API_URL && market),
    ...live,
  });

export const useBatchDetail = (market?: Address, batch?: bigint) =>
  useQuery({
    queryKey: ["markets", "batch", market?.toLowerCase(), batch?.toString()],
    queryFn: async () => parseBatchDetail(await get<J>(`/v1/markets/${market}/batches/${batch}`)),
    enabled: Boolean(API_URL && market && batch !== undefined),
    ...live,
  });

export const useOrderHistory = (address?: Address, limit = 50) =>
  useQuery({
    queryKey: ["markets", "orders", address?.toLowerCase(), limit],
    queryFn: async () => {
      const body = await get<J>(`/v1/markets/accounts/${address}/orders?limit=${limit}`);
      return ((body.orders ?? body.items ?? []) as J[]).map(parseHistory);
    },
    enabled: Boolean(API_URL && address),
    ...live,
  });

/**
 * Opt-in reveal relay (spec 5, `revealFor`; lane C r1/services f3538d0): Orrery's server holds the order and salt
 * until the batch's reveal window opens, then reveals for the trader. Shown only when NEXT_PUBLIC_MARKETS_RELAY=1.
 */
export const RELAY_ENABLED = process.env.NEXT_PUBLIC_MARKETS_RELAY === "1" && Boolean(API_URL);
export type RelayStatus = "queued" | "sent" | "revealed" | "failed";
export interface RelayState {
  status: RelayStatus;
  revealsFrom: number;
  revealsBy: number;
  tx?: Hex;
  reason?: string;
}
const parseRelay = (o: J): RelayState => ({
  status: one(o.status, ["queued", "sent", "revealed", "failed"] as const, "failed"),
  revealsFrom: time(o.revealsFrom),
  revealsBy: time(o.revealsBy),
  tx: hex(o.tx),
  reason: typeof o.reason === "string" ? o.reason : undefined,
});
export const relayReveal = async (p: { market: Address; account: Address; batch: string; order: { sellAsset: boolean; amountIn: string; limitPrice: string; mode: "limit" | "swap"; payFeeInOrry: boolean }; salt: Hex }) =>
  parseRelay(await post<J>("/v1/markets/relay/reveals", p));
export const relayStatus = async (market: Address, batch: string, account: Address) => parseRelay(await get<J>(`/v1/markets/relay/reveals/${market}/${batch}/${account}`));
