"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { API_URL } from "../config";
import { big, get } from "../orry/api";
import type { OrryFeature } from "../orry/config";
import { useReleases } from "../orry/releases";
import { isAddr, isZeroAddr } from "./logic";

/**
 * Community (lane L1): which pages are open and the deployment they talk to. A page opens when the runtime release switch
 * opens its feature and `GET /v1/community/config` names its contracts; otherwise it renders "Coming soon".
 */

export const COMMUNITY_FEATURES = ["chat", "achievements", "passes", "burn-to-boost", "cashback", "referrals", "template-market"] as const;
export type CommunityFeature = (typeof COMMUNITY_FEATURES)[number];

export interface CommunityAddresses {
  pool: Address | null;
  achievements: Address | null;
  chat: Address | null;
  names: Address | null;
  boost: Address | null;
  passes: Address | null;
  templates: Address | null;
  referrals: Address | null;
  cashback: Address | null;
  orry: Address | null;
  priceOracle: Address | null;
}

/** `GET /v1/community/config`, amounts as bigints (USD in USDG base units, ORRY in 18 decimals). */
export interface CommunityConfig {
  chainId: number;
  addresses: CommunityAddresses;
  postFeeUsd: bigint;
  nameFeeUsd: bigint;
  boostUsdPerDay: { post: bigint; agent: bigint; template: bigint };
  passUsd: { day: bigint; week: bigint };
  tipCutBps: number;
  reportMinStake: bigint;
  hideThreshold: number;
  maxTextBytes: number;
  templateBurnBps: number;
  checkWindowSeconds: number;
}

type J = Record<string, unknown>;
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const addr = (v: unknown) => (isAddr(v) && !isZeroAddr(v) ? (v as Address) : null);

export function parseCommunityConfig(o: J): CommunityConfig {
  const a = (o.addresses ?? {}) as J;
  const boost = (o.boostUsdPerDay ?? {}) as J;
  const pass = (o.passUsd ?? {}) as J;
  return {
    chainId: n(o.chainId),
    addresses: {
      pool: addr(a.pool),
      achievements: addr(a.achievements),
      chat: addr(a.chat),
      names: addr(a.names),
      boost: addr(a.boost),
      passes: addr(a.passes),
      templates: addr(a.templates),
      referrals: addr(a.referrals),
      cashback: addr(a.cashback),
      orry: addr(a.orry),
      priceOracle: addr(a.priceOracle),
    },
    postFeeUsd: big(o.postFeeUsd),
    nameFeeUsd: big(o.nameFeeUsd),
    boostUsdPerDay: { post: big(boost.post), agent: big(boost.agent), template: big(boost.template) },
    passUsd: { day: big(pass.day), week: big(pass.week) },
    tipCutBps: n(o.tipCutBps),
    reportMinStake: big(o.reportMinStake),
    hideThreshold: n(o.hideThreshold),
    maxTextBytes: n(o.maxTextBytes),
    templateBurnBps: n(o.templateBurnBps),
    checkWindowSeconds: n(o.checkWindowSeconds),
  };
}

/** Never held: it names the contracts every community page needs. */
export const useCommunityConfig = (enabled = true) =>
  useQuery({
    queryKey: ["community", "config"],
    queryFn: async () => parseCommunityConfig(await get<J>("/v1/community/config")),
    enabled: Boolean(API_URL) && enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });

/** Contracts each feature needs before its page or action opens. */
const NEEDS: Record<CommunityFeature, (keyof CommunityAddresses)[]> = {
  chat: ["chat", "orry"],
  achievements: ["pool"],
  passes: ["passes", "orry"],
  "burn-to-boost": ["boost", "orry"],
  cashback: ["cashback"],
  referrals: ["referrals"],
  "template-market": ["templates", "orry"],
};

export interface Community {
  /** False until the release switch and the config have answered (or cannot). */
  ready: boolean;
  config?: CommunityConfig;
  /** Open in the release switch and its contracts named in the config. */
  live: (f: CommunityFeature) => boolean;
}

export function useCommunity(): Community {
  const releases = useReleases();
  // The switch keys features by name; the community names are release features on the server, not ORRY pages here.
  const open = (f: CommunityFeature) => releases.isOpen(f as unknown as OrryFeature);
  // The config is read only once a community feature is open. Before that every community page shows its held state, the
  // nav (on every page) asks nothing, and an API without the community routes is never called.
  const anyOpen = releases.ready && COMMUNITY_FEATURES.some(open);
  const q = useCommunityConfig(anyOpen);
  const config = q.data;
  const settled = !API_URL || !anyOpen || config !== undefined || q.isError;
  return {
    ready: releases.ready && settled,
    config,
    live: (f) => Boolean(config && open(f) && NEEDS[f].every((k) => config.addresses[k])),
  };
}

export const COMMUNITY_ROUTES: { href: string; label: string; features: CommunityFeature[] }[] = [
  { href: "/community", label: "Chat", features: ["chat"] },
  { href: "/community/rewards", label: "Rewards", features: ["achievements"] },
  { href: "/community/templates", label: "Templates", features: ["template-market"] },
  { href: "/community/referrals", label: "Referrals", features: ["referrals", "cashback"] },
  { href: "/community/passes", label: "Passes", features: ["passes"] },
];

/** The site nav's Community entry: the first open community page, marked "Soon" while every one is held. */
export function useCommunityNavLink() {
  const c = useCommunity();
  const first = COMMUNITY_ROUTES.find((r) => r.features.some(c.live));
  return { href: first?.href ?? COMMUNITY_ROUTES[0]!.href, label: "Community", match: ["/community"], soon: c.ready && !first };
}
