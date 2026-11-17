"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { API_URL } from "../config";
import { contractsReady, FEATURES_FALLBACK, ORRY_ROUTES, type OrryFeature } from "./config";
import { fallbackOpen, nextOpening, openFeatures, parseReleases, serverNow, type ReleaseSnapshot } from "./release-logic";

/**
 * Runtime release switch (lane C's ReleasesResponse, orry/services): reads `GET /v1/releases` on load and about once
 * a minute, and opens each feature when the
 * server's clock reaches its time (server time plus the time elapsed since the answer). Opening or pulling back a
 * wave needs no rebuild and no reload. While the API cannot be reached, the build's fallback list applies (held when
 * unset). Never-hold controls (withdrawals, unstake, claims, positions, purchased credits) do not read this switch.
 */

export type ReleaseSource = "loading" | "api" | "fallback";
export interface Releases {
  /** False until the first answer or the fallback: gates show a short wait instead of a held page that then opens. */
  ready: boolean;
  source: ReleaseSource;
  isOpen: (f: OrryFeature) => boolean;
  /** Open and its contracts configured in this build. */
  isLive: (f: OrryFeature) => boolean;
  /** The first open ORRY page for the nav, or undefined while every page is held. */
  navHref?: string;
}

interface Answer {
  snap: ReleaseSnapshot;
  receivedAt: number;
}

const HELD: Releases = { ready: false, source: "loading", isOpen: () => false, isLive: () => false };
const Ctx = createContext<Releases>(HELD);

async function fetchReleases(): Promise<Answer> {
  const r = await fetch(`${API_URL}/v1/releases`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`releases ${r.status}`);
  const snap = parseReleases(await r.json());
  if (!snap) throw new Error("releases shape");
  return { snap, receivedAt: performance.now() };
}

export function ReleasesProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ["releases"], queryFn: fetchReleases, enabled: Boolean(API_URL), refetchInterval: 60_000, staleTime: 55_000, retry: 1 });
  const [tick, setTick] = useState(0);

  // Re-evaluate at the next opening time so a wave opens on the second, between the minute reads.
  useEffect(() => {
    if (!q.data) return;
    const now = serverNow(q.data.snap, q.data.receivedAt, performance.now());
    const next = nextOpening(q.data.snap, now);
    if (next === undefined) return;
    const t = setTimeout(() => setTick((x) => x + 1), Math.min(next - now + 50, 2_147_000_000));
    return () => clearTimeout(t);
  }, [q.data, tick]);

  const value = useMemo<Releases>(() => {
    let open: Set<string>;
    let source: ReleaseSource;
    if (q.data) {
      open = openFeatures(q.data.snap, serverNow(q.data.snap, q.data.receivedAt, performance.now()));
      source = "api";
    } else if (!API_URL || q.isError) {
      open = fallbackOpen(FEATURES_FALLBACK);
      source = "fallback";
    } else return HELD;
    const isOpen = (f: OrryFeature) => open.has(f);
    const isLive = (f: OrryFeature) => open.has(f) && contractsReady(f);
    return { ready: true, source, isOpen, isLive, navHref: ORRY_ROUTES.find((r) => isLive(r.feature))?.href };
    // tick re-runs this at each opening time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, q.isError, tick]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useReleases = () => useContext(Ctx);
