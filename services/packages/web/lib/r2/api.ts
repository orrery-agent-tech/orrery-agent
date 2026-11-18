"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  LimitOrdersResponse,
  LimitOrderInput,
  LimitOrderSubmitResponse,
  PaymasterResponse,
  PredictMarketsResponse,
  R2AccountResponse,
} from "@orrery/shared";
import type { Address } from "viem";
import { API_URL } from "../config";

/** Reads and writes of the `/v1/r2/` routes (lane L3). A held route answers 404, which the pages never reach: they
 * render their held state from the release switch instead. */

export class R2ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_URL) throw new R2ApiError(0, "This build has no Orrery API address set.");
  const r = await fetch(`${API_URL}${path}`, { ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new R2ApiError(r.status, body.error ?? `Request failed (${r.status}).`);
  return body;
}

const live = { refetchInterval: 10_000, retry: 1 } as const;

export const usePredictMarkets = (enabled = true) =>
  useQuery({ queryKey: ["r2", "predict"], queryFn: () => call<PredictMarketsResponse>("/v1/r2/predict"), enabled: Boolean(API_URL) && enabled, ...live });

export const useLimitOrders = (owner?: Address, enabled = true) =>
  useQuery({
    queryKey: ["r2", "limit-orders", owner?.toLowerCase()],
    queryFn: () => call<LimitOrdersResponse>(`/v1/r2/limit-orders${owner ? `?owner=${owner}` : ""}`),
    enabled: Boolean(API_URL) && enabled,
    ...live,
  });

export const usePaymasters = (enabled = true) =>
  useQuery({ queryKey: ["r2", "paymaster"], queryFn: () => call<PaymasterResponse>("/v1/r2/paymaster"), enabled: Boolean(API_URL) && enabled, ...live });

/** Positions, stored orders and prepaid gas of one address: never held by the release switch. */
export const useR2Account = (address?: Address) =>
  useQuery({
    queryKey: ["r2", "account", address?.toLowerCase()],
    queryFn: () => call<R2AccountResponse>(`/v1/r2/accounts/${address}`),
    enabled: Boolean(API_URL && address),
    ...live,
  });

export const submitLimitOrder = (order: LimitOrderInput & { signature: string }) =>
  call<LimitOrderSubmitResponse>("/v1/r2/limit-orders", { method: "POST", body: JSON.stringify(order) });
