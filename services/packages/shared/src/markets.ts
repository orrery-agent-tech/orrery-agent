import type { Address, Hex } from "viem";

/**
 * Wave R1 markets (`docs/ORRY-R1-SPEC.md` section 5): JSON shapes of `/v1/markets/...`, browser-safe for the web app.
 * Token amounts are decimal strings in base units; times are unix seconds of chain time (numbers), `updatedAt` is ISO
 * 8601. Errors are `{ error }` like every other route. Prices of a batch (`limitPrice`, `price`) are USDG base units per
 * 1e18 asset base units, as in `ISealedBatchMarket`.
 */

export const MARKET_FEATURES = ["stocks", "swap", "darkpool"] as const;
export type MarketFeature = (typeof MARKET_FEATURES)[number];

export type OrderMode = "limit" | "swap";
export const ORDER_MODES: readonly OrderMode[] = ["limit", "swap"]; // ISealedBatchMarket.Mode: Limit = 0, Swap = 1

/** commit: commit window open; reveal: reveal window open; clearing: reveal window over, not cleared yet, before expiry;
 * cleared; expired: not cleared by `expiresAt` (or `BatchExpired`), nothing moved. */
export type BatchStatus = "commit" | "reveal" | "clearing" | "cleared" | "expired";

/** Latest answer of the asset's Chainlink USD feed. */
export interface StockPrice {
  feed: Address;
  /** USD per 1 whole token with `decimals` decimals; null when the feed cannot be read or answers 0 or less. */
  answer: string | null;
  decimals: number;
  roundId: string | null;
  updatedAt: number | null;
  /** `updatedAt` is within the market's `maxStaleness` of chain time now (weekends and US market holidays: false). */
  fresh: boolean;
}

export interface MarketParams {
  commitSeconds: number;
  revealSeconds: number;
  feeBps: number;
  /** USDG base units (6 decimals). */
  minNotionalUsdg: string;
  /** USDG base units of ORRY burned per commit; "0" when commits are free. */
  commitFeeUsd: string;
  maxStaleness: number;
  maxOrders: number;
  /** Seconds after a batch's reveal window ends during which it can clear. */
  expirySeconds: number;
  /** Largest gap between a remainder-pool fill and the clearing price, in basis points (R1b). */
  maxDeviationBps: number;
  /** Further discount on a fee paid in ORRY (L3), in basis points, from the market's `orryFeeDiscountBps()`. */
  orryFeeDiscountBps: number;
}

export interface MarketPhase {
  /** The batch open for commits now (decimal string). */
  batch: string;
  inCommit: boolean;
  /** When the current window (commit or reveal) ends. */
  endsAt: number;
}

/** GET /v1/markets: one row per market the factory created, newest first. */
export interface MarketSummary {
  market: Address;
  asset: { address: Address; symbol: string; name: string; decimals: number };
  usdg: Address;
  price: StockPrice;
  params: MarketParams;
  phase: MarketPhase;
  /** The Uniswap v4 stock/USDG pool that fills the unmatched part of Swap orders (R1b); `listed` false: none, Swap
   * orders then behave as Limit orders. */
  remainderPool: { poolId: Hex; listed: boolean };
  /** The FeeTiers contract this market reads at clearing; its table: GET /v1/markets/fee-tiers. */
  feeTiers: Address;
  createdBlock: number;
}

export interface MarketsResponse {
  markets: MarketSummary[];
  /** Latest block time, so a browser can offset its own clock for countdowns. */
  chainTime: number;
  updatedAt: string;
}

/** GET /v1/markets/:market */
export interface MarketResponse extends MarketSummary {
  chainTime: number;
  updatedAt: string;
}

export interface OrderTerms {
  sellAsset: boolean;
  amountIn: string;
  limitPrice: string;
  mode: OrderMode;
  payFeeInOrry: boolean;
}

export interface OrderFill {
  inputUsed: string;
  output: string;
  /** USDG base units. */
  usdgFee: string;
  /** ORRY base units, burned. */
  orryFee: string;
  tx: Hex;
}

/** filled: some input used; unfilled: cleared without a fill (limit not met or no counter side); dropped: the input
 * could not be pulled at clearing; revealed: the batch has not settled yet; expired: the batch expired. */
export type RevealedStatus = "revealed" | "filled" | "unfilled" | "dropped" | "expired";

export interface RevealedOrder extends OrderTerms {
  /** Masked, `0x1234…abcd`. */
  account: string;
  status: RevealedStatus;
  fill: OrderFill | null;
}

export interface BatchResult {
  price: string;
  roundId: string;
  assetFilled: string;
  usdgFilled: string;
  /** Asset and USDG traded against the remainder pool (R1b), from the market's `result(batch)`. */
  assetViaPool: string;
  usdgViaPool: string;
  /** Sums of the batch's OrderFilled events. */
  usdgFees: string;
  orryFeesBurned: string;
  ordersFilled: number;
  ordersUnfilled: number;
  ordersDropped: number;
  tx: Hex;
  block: number;
  time: number;
}

export interface BatchView {
  market: Address;
  batch: string;
  commitEndsAt: number;
  revealEndsAt: number;
  expiresAt: number;
  status: BatchStatus;
  commits: number;
  reveals: number;
  /** ORRY base units burned by this batch's commits (burn source 5). */
  commitFeesBurned: string;
  result: BatchResult | null;
  /** The revealed orders, only once the reveal window has ended; null before, and in batch lists. */
  orders: RevealedOrder[] | null;
}

/** GET /v1/markets/:market/batches?limit=1..100&before=<batch>: batches with at least one commit, newest first. */
export interface BatchesResponse {
  market: Address;
  batches: BatchView[];
  updatedAt: string;
}

/** committed: reveal window still open, not revealed; missed: reveal window ended without a reveal. */
export type WalletOrderStatus = "committed" | "missed" | RevealedStatus;

export interface WalletOrder {
  market: Address;
  asset: Address;
  symbol: string;
  batch: string;
  status: WalletOrderStatus;
  commitment: Hex;
  commitTx: Hex;
  committedAt: number;
  /** ORRY base units burned by this commit (burn source 5). */
  commitFeeBurned: string;
  revealEndsAt: number;
  /** Null until revealed. */
  order: OrderTerms | null;
  revealTx: Hex | null;
  fill: OrderFill | null;
}

/** GET /v1/markets/accounts/:address/orders?limit=1..200&before=<block>: newest first. */
export interface WalletOrdersResponse {
  address: Address;
  orders: WalletOrder[];
  updatedAt: string;
}

/** One FeeTiers contract (L2): the stake discount on market fees, thresholds in USD at the ORRY price. */
export interface FeeTierTable {
  address: Address;
  /** The ORRY price oracle the thresholds are measured with. */
  orryPrice: Address;
  /** False while the ORRY price oracle is not ready: every discount is 0 then. */
  active: boolean;
  /** Ascending; `minStakeUsd` in USDG base units (6 decimals) of earning stake (plain plus agent as staker). */
  tiers: { minStakeUsd: string; discountBps: number }[];
  /** With `?account=`: that address's stake in USD and its discount now; otherwise null. */
  account: { address: Address; stakeUsd: string; discountBps: number } | null;
}

/** GET /v1/markets/fee-tiers?account=0x…: every FeeTiers contract the indexed markets use. */
export interface FeeTiersResponse {
  tables: FeeTierTable[];
  usdDecimals: 6;
  updatedAt: string;
}

/** POST /v1/markets/relay/reveals: opt-in reveal relay (spec section 5). Orrery's server holds the order and salt
 * until the batch's reveal window opens, then sends `revealFor(account, order, salt)`. The order is known to Orrery's
 * server before the batch closes; the trader chooses this. */
export interface RelayRevealRequest {
  market: Address;
  /** Decimal string. */
  batch: string;
  account: Address;
  order: OrderTerms;
  salt: Hex;
}

/** queued: waiting for the reveal window; sent: Orrery's relay revealed it (`tx`); revealed: another transaction
 * revealed it first (for example the wallet itself); failed: not revealed (`reason`). */
export type RelayStatus = "queued" | "sent" | "revealed" | "failed";

/** The answer to the POST, and GET /v1/markets/relay/reveals/:market/:batch/:account. Never carries the salt. */
export interface RelayRevealResponse {
  market: Address;
  batch: string;
  account: Address;
  status: RelayStatus;
  /** The relay sends from this time (the batch's commit window end) until `revealsBy`. */
  revealsFrom: number;
  revealsBy: number;
  tx: Hex | null;
  reason: string | null;
}

/** Minimal Chainlink AggregatorV3 interface, as the market and the API read it. */
export const aggregatorV3Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function", name: "getRoundData", stateMutability: "view", inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** ERC-20 metadata reads for the stock list (on-chain only). */
export const erc20MetaAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;
