import { formatUnits, parseUnits } from "viem";

/** Token amount in base units to a readable figure: grouped integer part, trimmed fraction. */
export function amount(v: bigint | undefined | null, opts: { decimals?: number; frac?: number } = {}): string {
  if (v === undefined || v === null) return "";
  const decimals = opts.decimals ?? 18;
  const frac = opts.frac ?? 4;
  const neg = v < 0n;
  const s = formatUnits(neg ? -v : v, decimals);
  const [i = "0", f = ""] = s.split(".");
  const intPart = BigInt(i).toLocaleString("en-US");
  // Large figures read better without a long tail; tiny ones keep enough digits to stay non-zero.
  const digits = BigInt(i) >= 1_000_000n ? 0 : BigInt(i) >= 1_000n ? Math.min(2, frac) : frac;
  let fracPart = f.slice(0, digits).replace(/0+$/, "");
  if (v !== 0n && BigInt(i) === 0n && fracPart === "") {
    const firstNonZero = f.search(/[1-9]/);
    if (firstNonZero >= 0 && firstNonZero < 12) fracPart = f.slice(0, firstNonZero + 2).replace(/0+$/, "");
  }
  return `${neg ? "-" : ""}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

export const eth = (v?: bigint | null) => amount(v, { frac: 5 });
export const orry = (v?: bigint | null) => amount(v, { frac: 2 });

/** Parses what a person typed into base units, or undefined when it is not a positive amount. */
export function parseAmount(s: string, decimals = 18): bigint | undefined {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return undefined;
  try {
    const v = parseUnits(t, decimals);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Base units back into an input value without grouping (for Max buttons). */
export const toInput = (v: bigint, decimals = 18) => formatUnits(v, decimals);

/** Wallet address as `0x1234…abcd`. Leaderboard rows arrive masked already; this keeps any full address masked too. */
export function mask(a?: string | null): string {
  if (!a) return "";
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Seconds as days, hours and minutes, the largest two units. */
export function span(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} ${d === 1 ? "day" : "days"}`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, "0")} s`;
  return `${s} s`;
}

/** A constant period (cooldown, lock) in words: "14 days", "15 minutes", "1 hour". */
export function period(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} ${seconds === 86400 ? "day" : "days"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0) return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} seconds`;
}

/** How often something may run: "once an hour", "once a day", "once every 6 hours". */
export function every(seconds: number): string {
  if (seconds === 3600) return "at most once per hour";
  if (seconds === 86400) return "at most once per day";
  return `at most once per ${period(seconds)}`;
}

export function ago(unixSeconds: number, now: number): string {
  const d = Math.max(0, now - unixSeconds);
  if (d < 60) return `${d} s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

export const utc = (unixSeconds: number) => `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Share of a total in percent with two decimals, from bigints. */
export function pct(part?: bigint, total?: bigint): string {
  if (part === undefined || !total || total === 0n) return "";
  const bp = Number((part * 1_000_000n) / total) / 10_000;
  return bp > 0 && bp < 0.01 ? "<0.01%" : `${bp.toFixed(2)}%`;
}
