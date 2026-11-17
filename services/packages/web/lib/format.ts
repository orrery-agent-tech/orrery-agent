import { formatUnits, type Address } from "viem";
import { USDG_DECIMALS } from "./config";

export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const usdg = (v: bigint) => {
  const s = formatUnits(v, USDG_DECIMALS);
  const [i, f = ""] = s.split(".");
  return `${Number(i).toLocaleString("en-US")}.${(f + "00").slice(0, 2)}`;
};
export const isZero = (a?: Address) => !a || /^0x0{40}$/i.test(a);
export function duration(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : m > 0 ? `${m} min ${String(s).padStart(2, "0")} s` : `${s} s`;
}
export const STATUS = ["No session", "Active", "Paused", "Revoked", "Expired"] as const;
