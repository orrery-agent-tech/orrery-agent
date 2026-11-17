"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { getAddress, toHex, type Address, type Hex } from "viem";
import {
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  transferWithAuthorizationTypes,
  type PaymentPayload,
  type PaymentRequired,
} from "@orrery/shared";
import { API_URL, activeChain } from "@/lib/config";

/**
 * Credits for the dashboard: a read session opened by one signed message (no gas, read only), the account it reads
 * (balance, included checks, plan, key status, purchases, usage), the live pricing, and the x402 purchase itself.
 */

export type Product = "pack" | "plan";

export interface Pricing {
  packPrice: string;
  packSize: number;
  freeChecksPerMonth: number;
  creditsPerCheck: number;
  volumeCreditsPerCheck: number;
  volumeChecks: number;
  checksPerMinute: number;
  plan: { price: string; credits: number; days: number; checksPerMinute: number };
}

export interface AccountView {
  address: Address;
  credits: string;
  checkCost: number;
  planUntil: string | null;
  month: { checks: number; freeChecks: number; freeChecksLeft: number };
  apiKey: { active: boolean; createdAt: string | null };
  purchases: { at: string; product: string; paidIn: "USDG" | "ORRY"; amount: string | null; credits: string; tx: string | null }[];
  usage: {
    daily: { day: string; checks: number; freeChecks: number; creditsSpent: string }[];
    monthly: { month: string; checks: number; freeChecks: number; paidChecks: number }[];
  };
}

const storageKey = (a: Address) => `orrery-session-${a.toLowerCase()}`;
const readToken = (a: Address): string | null => {
  try {
    const raw = sessionStorage.getItem(storageKey(a));
    if (!raw) return null;
    const s = JSON.parse(raw) as { token: string; expiresAt: string };
    return Date.parse(s.expiresAt) > Date.now() + 60_000 ? s.token : null;
  } catch {
    return null;
  }
};

export const usePricing = () =>
  useQuery({
    queryKey: ["pricing"],
    queryFn: async () => (await (await fetch(`${API_URL}/v1/pricing`)).json()) as Pricing,
    enabled: Boolean(API_URL),
    staleTime: 10 * 60_000,
  });

/** The wallet's read session: kept for this tab only (sessionStorage), 24 hours at most. */
export function useAccountSession(address: Address | undefined, signMessage: (message: string) => Promise<Hex>) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setToken(address ? readToken(address) : null), [address]);

  const signIn = useCallback(async () => {
    if (!API_URL || !address) return;
    setBusy(true);
    setError(null);
    try {
      const n = (await (await fetch(`${API_URL}/v1/account/nonce?address=${address}`)).json()) as { nonce: string; message: string };
      const signature = await signMessage(n.message);
      const r = await fetch(`${API_URL}/v1/account/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, nonce: n.nonce, signature }) });
      const body = (await r.json()) as { token?: string; expiresAt?: string; error?: string };
      if (!r.ok || !body.token || !body.expiresAt) throw new Error(body.error ?? "The sign in was not completed.");
      try {
        sessionStorage.setItem(storageKey(address), JSON.stringify({ token: body.token, expiresAt: body.expiresAt }));
      } catch {
        // storage blocked: the session lives in memory for this page only
      }
      setToken(body.token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(/reject|denied/i.test(msg) ? "The signature request was dismissed." : msg || "The sign in was not completed.");
    } finally {
      setBusy(false);
    }
  }, [address, signMessage]);

  const signOut = useCallback(async () => {
    if (address) {
      try {
        sessionStorage.removeItem(storageKey(address));
      } catch {
        // nothing stored
      }
    }
    if (API_URL && token) await fetch(`${API_URL}/v1/account/session/close`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    setToken(null);
  }, [address, token]);

  return { token, busy, error, signIn, signOut, expired: () => setToken(null) };
}

/** The account behind a read session; a 401 ends the session so the page asks to sign in again. */
export function useAccount(token: string | null, onExpired: () => void) {
  return useQuery({
    queryKey: ["account", token],
    queryFn: async () => {
      const r = await fetch(`${API_URL}/v1/account`, { headers: { authorization: `Bearer ${token}` } });
      if (r.status === 401) {
        onExpired();
        throw new Error("Signed out");
      }
      if (!r.ok) throw new Error("The credit balance is still loading. Refresh shortly.");
      return (await r.json()) as AccountView;
    },
    enabled: Boolean(API_URL && token),
    refetchInterval: 30_000,
    retry: 1,
  });
}

export const useRefreshAccount = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["account"] });
};

/**
 * Buys a credit pack or the monthly plan over x402: the wallet signs one USDG transfer authorization (no gas for the
 * buyer), the API settles it and grants the credits. Returns the new balance and, for a first purchase, the API key.
 */
export async function buyCredits(opts: {
  address: Address;
  product: Product;
  signTypedData: (args: Parameters<typeof signShape>[0]) => Promise<Hex>;
  onPending?: () => void;
}): Promise<{ credits: string; planUntil: string | null; apiKey?: string }> {
  const url = `${API_URL}/v1/credits${opts.product === "plan" ? "?product=plan" : ""}`;
  const first = await fetch(url, { method: "POST" });
  const header = first.headers.get(HEADER_REQUIRED);
  if (first.status !== 402 || !header) throw new Error("The payment terms did not arrive. Request them again.");
  const required = decodeHeader<PaymentRequired>(header);
  const req = required.accepts.find((a) => a.network === `eip155:${activeChain.id}`);
  if (!req) throw new Error("This network has no payment option listed.");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const auth = {
    from: getAddress(opts.address),
    to: getAddress(req.payTo),
    value: BigInt(req.amount),
    validAfter: now - 60n,
    validBefore: now + BigInt(req.maxTimeoutSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await opts.signTypedData(
    signShape({ domain: { name: req.extra.name, version: req.extra.version, chainId: activeChain.id, verifyingContract: getAddress(req.asset) }, message: auth }),
  );
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: req,
    payload: {
      signature,
      authorization: { from: auth.from, to: auth.to, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString(), nonce: auth.nonce },
    },
  };
  for (let i = 0; i < 15; i++) {
    const r = await fetch(url, { method: "POST", headers: { [HEADER_SIGNATURE]: encodeHeader(payload) } });
    if (r.status === 202) {
      opts.onPending?.();
      await new Promise((res) => setTimeout(res, 2_000));
      continue;
    }
    const body = (await r.json()) as { apiKey?: string; credits?: string; planUntil?: string | null; error?: string };
    if (!r.ok) throw new Error(body.error ?? "The payment did not settle.");
    return { credits: body.credits ?? "0", planUntil: body.planUntil ?? null, apiKey: body.apiKey };
  }
  throw new Error("The payment is confirming. Refresh the balance shortly.");
}

/** The EIP-712 request the wallet signs for a USDG transfer authorization. */
export function signShape(a: {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  message: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
}) {
  return { domain: a.domain, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization" as const, message: a.message };
}

/** Issues a new API key with a signed message; every earlier key for the address stops working. */
export async function rotateApiKey(address: Address, signMessage: (message: string) => Promise<Hex>): Promise<string> {
  const n = (await (await fetch(`${API_URL}/v1/keys/nonce?address=${address}`)).json()) as { nonce: string; message: string };
  const signature = await signMessage(n.message);
  const r = await fetch(`${API_URL}/v1/keys/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, nonce: n.nonce, signature }) });
  const body = (await r.json()) as { apiKey?: string; error?: string };
  if (!r.ok || !body.apiKey) throw new Error(body.error ?? "No key came back. Request it again.");
  return body.apiKey;
}
