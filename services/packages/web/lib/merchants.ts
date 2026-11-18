"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { API_URL } from "./config";
import { get } from "./orry/api";

/** `GET /v1/merchants/:address` (services facilitator-public.ts). USD amounts carry 6 decimals. */
export interface MerchantView {
  merchant: Address;
  splitter: Address;
  created: boolean;
  feeBps: number;
  discountBps: number;
  stakeUsd: string;
  badge: boolean;
  badgeMinStakeUsd: string;
  profile: { name: string | null; url: string | null; description: string | null } | null;
  lastForwardAt: number | null;
  settled30d: { asset: Address; payments: number; amount: string }[];
}
export interface DirectoryEntry {
  merchant: Address;
  splitter: Address;
  name: string;
  url: string | null;
  description: string | null;
  stakeUsd: string;
}
export interface SupportedKind {
  network: string;
  asset: Address;
  extra: { assetTransferMethod: "eip3009" | "permit2"; name?: string; version?: string; proxy?: Address; permit2?: Address };
}

const live = { refetchInterval: 15_000, retry: 1 } as const;

export const useMerchant = (address?: Address) =>
  useQuery({ queryKey: ["merchants", address?.toLowerCase()], queryFn: () => get<MerchantView>(`/v1/merchants/${address}`), enabled: Boolean(API_URL && address), ...live });
export const useDirectory = (enabled: boolean) =>
  useQuery({ queryKey: ["merchants", "directory"], queryFn: () => get<{ merchants: DirectoryEntry[] }>("/v1/merchants"), enabled: Boolean(API_URL) && enabled, ...live });
export const useSupported = () =>
  useQuery({ queryKey: ["x402", "supported"], queryFn: () => get<{ kinds: SupportedKind[]; feeBps: number }>("/v1/x402/supported"), enabled: Boolean(API_URL), staleTime: 300_000 });

/** Basis points as a percent with up to two decimals: 20 → "0.2%", 15 → "0.15%". */
export const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
