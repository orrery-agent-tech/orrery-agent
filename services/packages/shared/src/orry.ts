import { MARKET_FEATURES } from "./markets";
import { encodePacked, keccak256, parseAbi, type Address, type Hex } from "viem";

/**
 * ORRY services contract (`docs/ORRY-BUILD-SPEC.md` §5): release switch names, address masking, and the JSON shapes
 * of every `/v1/orry/` route. Browser-safe: the web app imports this file.
 *
 * Wire rules: token amounts are decimal strings in base units with a `decimals` field (ETH and ORRY both 18);
 * timestamps named `...At` or `time` are unix seconds (numbers); `updatedAt` is an ISO 8601 string. Errors are
 * `{ error: string }` with a 4xx or 5xx status, as on every other route of the API.
 */

// ------------------------------------------------------------------ release switch

/** One release switch for ORRY and the wave R1 markets (stocks, swap, darkpool). */
export const ORRY_FEATURES = ["earn", "stake", "claim", "burn", "leaderboard", "checkout", ...MARKET_FEATURES] as const;
export type OrryFeature = (typeof ORRY_FEATURES)[number];

/**
 * Every name the runtime release switch knows (`releases` table, `GET /v1/releases`): the ORRY route features above,
 * then the launch and update items that only the web reads. A name not in the table is held.
 */
export const RELEASE_FEATURES = [
  ...ORRY_FEATURES,
  "core", // the public launch of Orrery itself (T0)
  "agent-stake",
  "payg-checks",
  "facilitator",
  "facilitator-discount",
  "orry-x402",
  "stake-quota",
  "merchant-badge",
  "attesters",
  "credit-bond",
  "launch-priority",
  "cashback",
  "referrals",
  "template-market",
  "paymaster",
  "burn-to-boost",
  "passes",
  "chat",
  "achievements",
  // lane L2: Orrery Data (official datasets and packs), third-party data providers, the MCP server section
  "data",
  "data-providers",
  "mcp",
  "predict", // lane L3 (R2): prediction markets
  "limit-orders", // lane L3 (R2): signed limit orders
  "shield", // lane L3 (R2): Shield V2
  "credit", // lane L4: Orrery Credit lender pools (lines and bonds stay behind "credit-bond")
  "launch", // lane L5: Agent Launch pages and routes ("launch-priority" above opens its early window panel)
] as const;
export type ReleaseFeature = (typeof RELEASE_FEATURES)[number];

/**
 * GET /v1/releases: when each feature opens. `releases[feature]` is an ISO 8601 time, or null while it is held; a feature
 * that is not listed is held. A feature is open once its time is at or before `serverTime` (the API's clock), so a
 * client counts down against `serverTime`, not its own clock. The API applies the same rule to every request.
 */
export interface ReleasesResponse {
  serverTime: string;
  releases: Record<string, string | null>;
}

/** Which feature opens which route. A held feature's routes answer 404 exactly like an unknown route. */
export const ORRY_ROUTE_FEATURE = {
  "GET /v1/orry/earn": "earn",
  "GET /v1/orry/stake": "stake",
  "GET /v1/orry/leaderboard": "leaderboard",
  "GET /v1/orry/burns": "burn",
  "POST /v1/orry/quotes/credits": "checkout",
  "POST /v1/orry/quotes/verification": "checkout",
} as const satisfies Record<string, OrryFeature>;

/** Routes no release can hold: a user's balances, positions and claimables (what Earn withdraw, unstake, withdraw and
 * claim act on) and purchased credits stay readable whatever the switch says. */
export const NEVER_HELD_ROUTES = ["GET /v1/orry/accounts/:address", "GET /v1/credits", "GET /v1/releases"] as const;

/**
 * Parses `ORRERY_ORRY_FEATURES` (comma list of release names), which seeds an empty `releases` table. `undefined` means
 * "not set": the caller applies the chain default. An empty string holds every feature. Unknown names throw, so a typo
 * never opens or holds the wrong thing silently.
 */
export function parseOrryFeatures(raw: string | undefined): Set<ReleaseFeature> | undefined {
  if (raw === undefined) return undefined;
  const out = new Set<ReleaseFeature>();
  for (const part of raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    if (!(RELEASE_FEATURES as readonly string[]).includes(part)) {
      throw new Error(`Unknown ORRY feature "${part}". Use a comma list of: ${RELEASE_FEATURES.join(", ")}.`);
    }
    out.add(part as ReleaseFeature);
  }
  return out;
}

export const defaultOrryFeatures = (chainId: number): Set<OrryFeature> =>
  chainId === 4663 ? new Set() : new Set(ORRY_FEATURES);

// ------------------------------------------------------------------ leaderboard masking (R-5)

/** `0x1234…abcd`: first and last four hex digits, lower case, U+2026 between. The full address is never returned. */
export function maskAddress(address: string): string {
  const a = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("not an address");
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ------------------------------------------------------------------ constants

export const ORRY_DECIMALS = 18;
export const ETH_DECIMALS = 18;
export const USDG_DECIMALS = 6;

/** Burn sources of `IOrryBurnEvents.Burned`: 1 rewards router, 2 check packs, 3 verification, 4 buyback of ETH. */
export const BURN_SOURCES = { router: 1, credits: 2, verification: 3, buyback: 4, commitFee: 5, marketFee: 6, merchantFee: 7 } as const;

/** Checks per pack bought with ORRY: packs × packSize × 625 / 500 (R-9: 625 checks per 1 USD of ORRY). */
export const ORRY_CREDITS_NUM = 625n;
export const ORRY_CREDITS_DEN = 500n;
export const orryCreditsFor = (packs: number, packSize: number): bigint =>
  (BigInt(packs) * BigInt(packSize) * ORRY_CREDITS_NUM) / ORRY_CREDITS_DEN;

/**
 * USD price, in USDG base units, of `credits` paid in ORRY at the same 625 per 1 USD rate as a pack, rounded up so a
 * pay-as-you-go quote never undercuts a pack: credits × packPrice × 500 / (packSize × 625).
 */
export const orryUsdForCredits = (credits: bigint, packPrice: bigint, packSize: number): bigint => {
  const num = credits * packPrice * ORRY_CREDITS_DEN;
  const den = BigInt(packSize) * ORRY_CREDITS_NUM;
  return (num + den - 1n) / den;
};

/** Longest quote lifetime the API signs (spec §5). */
export const MAX_QUOTE_TTL_SECONDS = 120;
/** Price window of the quote median (spec §5). */
export const QUOTE_MEDIAN_WINDOW_SECONDS = 1800;

// ------------------------------------------------------------------ Uniswap v4 reads

/** Uniswap v4 PoolManager `Swap` event and the `extsload` read used for slot0 (no StateView needed). */
export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

/** `StateLibrary._getPoolStateSlot`: keccak256(abi.encodePacked(poolId, POOLS_SLOT = 6)). Slot0 is the first word. */
export const poolStateSlot = (poolId: Hex): Hex => keccak256(encodePacked(["bytes32", "uint256"], [poolId, 6n]));

/** Slot0 word layout: sqrtPriceX96 (bits 0..159), tick (160..183), protocolFee (184..207), lpFee (208..231). */
export function decodeSlot0(word: Hex): { sqrtPriceX96: bigint; tick: number; lpFee: number } {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  const lpFee = Number((v >> 208n) & 0xffffffn);
  return { sqrtPriceX96, tick, lpFee };
}

/** Uniswap v4 `TickMath.getSqrtPriceAtTick`: sqrtPriceX96 at `tick` (bit-exact port). */
export function sqrtPriceAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  if (abs > 887272n) throw new Error("tick out of range");
  let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of steps) if ((abs & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Integer square root (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Price bounds for `EarnVault.deposit` and `zapDeposit` (review M-3): the hub price may differ from `refSqrtPriceX96`
 * (a reference outside the instant hub price, e.g. its 30 minute mean) by at most `bandBps` of the price in either
 * direction. Bounds are on sqrtPriceX96, so the price band is applied under a square root.
 */
export function depositPriceBounds(refSqrtPriceX96: bigint, bandBps: number): { min: bigint; max: bigint } {
  const b = BigInt(bandBps);
  const min = (refSqrtPriceX96 * isqrt((10_000n - b) * 10n ** 16n)) / 10n ** 10n;
  const max = (refSqrtPriceX96 * isqrt((10_000n + b) * 10n ** 16n)) / 10n ** 10n + 1n;
  return { min, max };
}

/** ORRY base units per 1 ETH (1e18 wei) for the hub (currency0 native ETH, currency1 ORRY), rounded down. */
export const orryPerEthFromSqrt = (sqrtPriceX96: bigint): bigint => (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;

/** Native ETH as a hub quote and as an asset (multi-pair, R-35). */
export const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

/**
 * ORRY base units per quote base unit at a hub's sqrtPriceX96, exact as num / den. The pool price is currency1 per
 * currency0; `orryIsCurrency0` (the hook's `Pair`) says which side ORRY is on.
 */
export function orryPerQuoteRatio(sqrtPriceX96: bigint, orryIsCurrency0: boolean): { num: bigint; den: bigint } {
  const p = sqrtPriceX96 * sqrtPriceX96;
  const q192 = 1n << 192n;
  return orryIsCurrency0 ? { num: q192, den: p } : { num: p, den: q192 };
}

/** ORRY base units per 1 whole quote token (10^decimals base units), rounded down; null without a price. */
export function orryPerWholeQuote(sqrtPriceX96: bigint, orryIsCurrency0: boolean, decimals: number): bigint | null {
  if (sqrtPriceX96 === 0n) return null;
  const r = orryPerQuoteRatio(sqrtPriceX96, orryIsCurrency0);
  return (r.num * 10n ** BigInt(decimals)) / r.den;
}

// ------------------------------------------------------------------ API shapes (spec §5, frozen)

export interface AssetPair {
  eth: string;
  orry: string;
}

/** A quote token of a hub (multi-pair, R-35): native ETH is the zero address ("ETH", 18 decimals); any other quote's
 * symbol and decimals are the token's own, read on chain. */
export interface QuoteAsset {
  address: Address;
  symbol: string;
  decimals: number;
}

/** An amount of one asset, base units. ORRY is listed as an asset too (18 decimals). */
export interface AssetAmount {
  asset: Address;
  symbol: string;
  decimals: number;
  amount: string;
}

/** (quote, ORRY) amounts of one hub or vault, base units of each. */
export interface QuotePair {
  quote: string;
  orry: string;
}

/** One ORRY/X hub and its Earn vault. */
export interface OrryHubView {
  quote: QuoteAsset;
  poolId: Hex;
  /** The hub pool has a price (initialized through the hook). */
  initialized: boolean;
  /** The pair's Earn vault; null until anyone calls `IEarnVaultFactory.createVault(quote)`. */
  vault: Address | null;
  /** What the vault's full-range position holds now (`positionAmounts`); zeros without a vault. */
  tvl: QuotePair;
  /** Liquidity units; not a token amount. */
  totalShares: string;
  /** Sums of the vault's `FeesHarvested` in the last 7 days and in total. */
  fees7d: QuotePair;
  feesAllTime: QuotePair;
  /** ORRY base units added to the vault's reward stream with `notifyRewards` (sums of its `RewardsNotified`) in the last
   * 7 days and in total: income for the vault's LPs on top of the hub's fees. "0" without a vault. */
  notified7d: string;
  notifiedAllTime: string;
  /** ORRY base units per 1 whole quote token (10^decimals base units) at the hub's current price; null until it has one. */
  orryPerQuote: string | null;
}

/** GET /v1/orry/earn: every registered hub, in the hook's order (`pairAt`). */
export interface OrryEarnResponse {
  decimals: 18;
  hubs: OrryHubView[];
  updatedAt: string;
}

/** GET /v1/orry/stake */
export interface OrryStakeResponse {
  decimals: 18;
  /** `OrryStaking.totalEarning()`: active stake earning now. */
  totalEarning: string;
  /** Sum of `RewardsNotified` in the last 7 days and in total. */
  rewards7d: AssetPair;
  rewardsAllTime: AssetPair;
  /** Addresses with an earning balance above zero. */
  stakers: number;
  updatedAt: string;
}

export interface OrryAgentPosition {
  agentId: string;
  owner: Address;
  active: string;
  leaving: string;
  leavingAt: number;
  /** True when `owner` is still the agent's current owner, so checks report this position. */
  reportedForAgent: boolean;
}

/** One Earn vault position of an account (`IOrryLens.EarnPosition`). */
export interface OrryEarnPosition {
  vault: Address;
  quote: QuoteAsset;
  shares: string;
  unlockAt: number;
  /** Earn fees ready to claim. */
  fees: QuotePair;
  /** What the shares would withdraw now. */
  position: QuotePair;
}

/** GET /v1/orry/accounts/:address: the `IOrryLens.Claimables` fields, agent positions, and all-time earnings. Every
 * figure is measured at one block, the block the indexer's tables are complete through. */
export interface OrryAccountResponse {
  address: Address;
  decimals: 18;
  /** One entry per vault, in the factory's order. */
  earn: OrryEarnPosition[];
  stakeActive: string;
  stakeLeaving: string;
  stakeReadyAt: number;
  stakeRewardsEth: string;
  stakeRewardsOrry: string;
  agentPositions: OrryAgentPosition[];
  /** Claimed (events) plus pending, Earn and Stake together, per asset: ORRY, native ETH, then the other quotes in the
   * hook's order; zeros included. */
  earnedAllTime: AssetAmount[];
  updatedAt: string;
}

/** One row of GET /v1/orry/leaderboard (the response is an array of these). */
export interface OrryLeaderboardEntry {
  rank: number;
  /** Masked, `0x1234…abcd`. */
  address: string;
  decimals: 18;
  /** kind=stakers: earning balance (plain plus agent stake). */
  stake?: string;
  /** kind=earners: claimed plus pending, Earn and Stake, per asset as in the account route, at one block per account
   * (re-read every snapshot). */
  earned?: AssetAmount[];
  /** kind=earners: `earned` valued in ORRY base units at the hubs' current prices, the ranking key; an asset whose hub
   * has no price counts 0. */
  valueOrry?: string;
}
export type OrryLeaderboardResponse = OrryLeaderboardEntry[];

export interface OrryBurnItem {
  tx: Hex;
  block: number;
  time: number;
  /** 1 router, 2 credits, 3 verification, 4 buyback, 5 market commit fee, 6 market fee paid in ORRY. */
  source: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  amount: string;
}

/** GET /v1/orry/burns */
export interface OrryBurnsResponse {
  decimals: 18;
  total: string;
  bySource: { "1": string; "2": string; "3": string; "4": string; "5": string; "6": string; "7": string };
  items: OrryBurnItem[];
}

export interface QuotePrice {
  /** ORRY base units per 1 USD (1,000,000 USDG base units) used for this quote. */
  orryPerUsd: string;
  /** Which price was lower for ORRY, so the one used: the current pool price or the 30 minute median. */
  basis: "spot" | "median";
  samples: number;
  windowSeconds: number;
}

interface QuoteEnvelope {
  signature: Hex;
  /** The quote signer; the treasury accepts it only while `isQuoteSigner(signer)` is true. */
  signer: Address;
  domain: { name: "Orrery Treasury"; version: "1"; chainId: number; verifyingContract: Address };
  decimals: 18;
  /** USD value priced, in USDG base units (6 decimals). */
  usdValue: string;
  usdDecimals: 6;
  price: QuotePrice;
}

/** POST /v1/orry/quotes/credits `{ buyer, packs }` */
export interface OrryCreditsQuoteResponse extends QuoteEnvelope {
  kind: "credits";
  quote: { buyer: Address; packs: number; orryAmount: string; quoteId: Hex; expiry: number };
  /** Checks granted to `buyer` once `CreditsPaid` for this quoteId is confirmed. */
  credits: string;
}

/**
 * POST /v1/orry/quotes/checks `{ buyer, checks }`: pay as you go (R-44 item 13). The same `CreditsQuote` and
 * `burnForCredits` as a pack; `quote.packs` is the number of checks. `credits` (checks × credits per check) reach `buyer`
 * once `CreditsPaid` for this quoteId is confirmed.
 */
export interface OrryChecksQuoteResponse extends QuoteEnvelope {
  kind: "checks";
  quote: { buyer: Address; packs: number; orryAmount: string; quoteId: Hex; expiry: number };
  checks: number;
  credits: string;
}

/** POST /v1/orry/quotes/verification `{ payer, agentId }` */
export interface OrryVerificationQuoteResponse extends QuoteEnvelope {
  kind: "verification";
  quote: { payer: Address; agentId: string; orryAmount: string; quoteId: Hex; expiry: number };
}
