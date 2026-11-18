/**
 * Community pages, pure part (lane L1, docs/updates/L1-COMMUNITY-SPEC.md). No imports, so the tests run without the app.
 */

/** UTF-8 byte length, as `OrryChat.post` counts `bytes(text).length`. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** `OrryNames.isValid`: 3 to 20 characters of a to z, 0 to 9 and underscore. */
export const validName = (s: string): boolean => /^[a-z0-9_]{3,20}$/.test(s);

/** The cap passed with a paid call: the live quote plus 1% headroom, rounded up. */
export const withHeadroom = (quote: bigint): bigint => (quote * 101n + 99n) / 100n;

/** Share of an amount in basis points, rounded down (the contracts' `amount * bps / 10_000`). */
export const bpsOf = (amount: bigint, bps: number): bigint => (amount * BigInt(bps)) / 10_000n;

/** Basis points as a percent without trailing zeros: 500 -> "5%", 2000 -> "20%", 1250 -> "12.5%". */
export const percent = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** USDG base units (6 decimals) as dollars with cents: "$0.01", "$1,250.00"; a non-zero amount under a cent reads "<$0.01". */
export function usd(v: bigint): string {
  if (v > 0n && v < 10_000n) return "<$0.01";
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const cents = (a % 1_000_000n) / 10_000n;
  return `${neg ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
export const isZeroAddr = (v?: string | null): boolean => !v || /^0x0{40}$/i.test(v);
export const sameAddr = (a?: string | null, b?: string | null): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** The `?ref=` of a referral link, when it is a real address other than the wallet itself. */
export function referrerFromSearch(search: string, me?: string): `0x${string}` | undefined {
  const ref = new URLSearchParams(search).get("ref")?.trim();
  if (!isAddr(ref) || isZeroAddr(ref) || sameAddr(ref, me)) return undefined;
  return ref;
}

export const referralLink = (origin: string, address: string): string => `${origin}/community/referrals?ref=${address}`;

/** A one-line excerpt for reply quotes. */
export function excerpt(text: string, max = 90): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
