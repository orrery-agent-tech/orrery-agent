"use client";

import { useQuery } from "@tanstack/react-query";
import type { DataCatalogResponse, DataProvidersResponse } from "@orrery/shared";
import { API_URL } from "../config";
import { get } from "../orry/api";

/** Lane L2 reads: the data catalogue with prices (`GET /v1/data`), the signer, and the provider listing. */

const live = { refetchInterval: 20_000, retry: 1 } as const;

export const useDataCatalog = (enabled = true) =>
  useQuery({ queryKey: ["data", "catalog"], queryFn: () => get<DataCatalogResponse>("/v1/data"), enabled: Boolean(API_URL) && enabled, ...live });

export const useDataSigner = (enabled = true) =>
  useQuery({ queryKey: ["data", "signer"], queryFn: () => get<{ signer: string; chainId: number }>("/v1/data/signer"), enabled: Boolean(API_URL) && enabled, staleTime: 300_000 });

export const useDataProviders = (enabled = true) =>
  useQuery({ queryKey: ["data", "providers"], queryFn: () => get<DataProvidersResponse>("/v1/data/providers"), enabled: Boolean(API_URL) && enabled, ...live });

/** USDG base units (6 decimals) as dollars: two decimals, more only when the amount needs them (a price per call). */
export function dollars(v: string | bigint): string {
  const n = Number(BigInt(v)) / 1e6;
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4).replace(/0+$/, "")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
