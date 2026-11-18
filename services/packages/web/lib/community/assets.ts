"use client";

import { erc20Abi, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { ADDRESSES, USDG_DECIMALS } from "../config";
import { amount } from "../orry/format";
import { isZeroAddr, sameAddr } from "./logic";

/** Symbol and decimals of a Reward Pool asset: address(0) is ETH, the config names ORRY, others are read from the token. */
export interface AssetMeta {
  symbol: string;
  decimals: number;
}

const ETH: AssetMeta = { symbol: "ETH", decimals: 18 };

export function useAssetMeta(assets: string[], orry: Address | null): (asset: string) => AssetMeta | undefined {
  const known = (a: string): AssetMeta | undefined => {
    if (isZeroAddr(a)) return ETH;
    if (sameAddr(a, orry)) return { symbol: "ORRY", decimals: 18 };
    if (sameAddr(a, ADDRESSES.usdg)) return { symbol: "USDG", decimals: USDG_DECIMALS };
    return undefined;
  };
  const unknown = [...new Set(assets.map((a) => a.toLowerCase()))].filter((a) => !known(a)) as Address[];
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: unknown.flatMap((a) => [
      { address: a, abi: erc20Abi, functionName: "symbol" as const },
      { address: a, abi: erc20Abi, functionName: "decimals" as const },
    ]),
    query: { enabled: unknown.length > 0, staleTime: Infinity },
  });
  return (a) => {
    const k = known(a);
    if (k) return k;
    const i = unknown.indexOf(a.toLowerCase() as Address);
    const s = data?.[i * 2];
    const d = data?.[i * 2 + 1];
    return i >= 0 && s?.status === "success" && d?.status === "success" ? { symbol: String(s.result), decimals: Number(d.result) } : undefined;
  };
}

/** An amount of a pool asset with its symbol, or "" while its metadata loads. */
export function assetAmount(v: bigint, meta?: AssetMeta): string {
  if (!meta) return "";
  return `${amount(v, { decimals: meta.decimals, frac: meta.symbol === "ETH" ? 5 : 2 })} ${meta.symbol}`;
}
