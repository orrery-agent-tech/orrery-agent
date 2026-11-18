import { USDG_DECIMALS } from "../config";
import { amount, parseAmount } from "../orry/format";

/**
 * Price units of the market (ISealedBatchMarket.Order.limitPrice and BatchResult.price): USDG base units per 1e18
 * asset base units. These helpers convert between that unit, the Chainlink answer and what a person reads or types.
 */
const E18 = 10n ** 18n;
const pow = (d: number) => 10n ** BigInt(d);

/** Chainlink USD answer to the market price unit. */
export const feedToPrice = (answer: bigint, feedDecimals: number, assetDecimals: number) =>
  (answer * pow(USDG_DECIMALS) * E18) / (pow(feedDecimals) * pow(assetDecimals));

/** Market price unit to USDG base units for one whole token, for display. */
export const pricePerToken = (price: bigint, assetDecimals: number) => (price * pow(assetDecimals)) / E18;

/** What a person typed as USDG per token to the market price unit. */
export function parsePrice(s: string, assetDecimals: number): bigint | undefined {
  const perToken = parseAmount(s, USDG_DECIMALS);
  return perToken === undefined ? undefined : (perToken * E18) / pow(assetDecimals);
}

/** USDG per token as a figure, two decimals (more for prices under a dollar). */
export function usd(perTokenBase?: bigint): string {
  if (perTokenBase === undefined) return "";
  const s = amount(perTokenBase, { decimals: USDG_DECIMALS, frac: perTokenBase < 10n ** 6n ? 4 : 2 });
  // Prices keep two decimals: 247.8 reads as 247.80.
  const [i, f = ""] = s.split(".");
  return perTokenBase >= 10n ** 6n && perTokenBase < 10n ** 12n ? `${i}.${f.padEnd(2, "0")}` : s;
}
/** USDG per token for an input field: plain digits, rounded to the cent. */
export const cents = (perTokenBase: bigint) => {
  const c = (perTokenBase + 5_000n) / 10_000n;
  return `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
};
/** A USDG amount in base units. */
export const usdg = (v?: bigint) => (v === undefined ? "" : amount(v, { decimals: USDG_DECIMALS, frac: 2 }));

export const usdgFor = (assetAmount: bigint, price: bigint) => (assetAmount * price) / E18;
export const assetFor = (usdgAmount: bigint, price: bigint) => (price > 0n ? (usdgAmount * E18) / price : 0n);

/** Spec DP-7: floor(notional × feeBps × (1 − discount) / 1e4), discount in basis points of the fee. */
export const feeOn = (notional: bigint, feeBps: number, discountBps = 0) => (notional * BigInt(feeBps) * BigInt(10_000 - discountBps)) / 100_000_000n;

/** A price moved by a tolerance: up for a buy limit, down for a sell limit. */
export const withTolerance = (price: bigint, bps: number, sellAsset: boolean) =>
  sellAsset ? (price * BigInt(10_000 - bps)) / 10_000n : (price * BigInt(10_000 + bps)) / 10_000n;

/** Basis points as a percent label: 15 → "0.15%", 2500 → "25%". */
export const bpsLabel = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
