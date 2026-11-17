/**
 * Runtime release switch, pure part (launch plan prep item 3). `GET /v1/releases` answers
 * `{ serverTime, releases: { feature: iso | null } }`: a feature opens once the server's clock reaches its time, and a
 * null time holds it. Time is measured from the server's clock plus the time elapsed since the answer, never from the
 * browser's own clock. No imports, so the tests run without the app.
 */

export interface ReleaseSnapshot {
  /** Server clock when it answered, in milliseconds. */
  serverTimeMs: number;
  /** Opening time per feature in milliseconds, or null while held. A feature missing here is held. */
  releases: Record<string, number | null>;
}

const toMs = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v.trim() !== "") {
    if (/^\d+$/.test(v.trim())) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
};

/** The API's answer, or undefined when it does not have the expected shape (the caller then uses the fallback). */
export function parseReleases(body: unknown): ReleaseSnapshot | undefined {
  if (!body || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  const serverTimeMs = toMs(o.serverTime);
  if (serverTimeMs === undefined || !o.releases || typeof o.releases !== "object") return undefined;
  const releases: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(o.releases as Record<string, unknown>)) {
    const t = v === null ? null : toMs(v);
    releases[k.toLowerCase()] = t === undefined ? null : t;
  }
  return { serverTimeMs, releases };
}

/** Features open at `serverNowMs`: a time at or before now. */
export function openFeatures(snap: ReleaseSnapshot, serverNowMs: number): Set<string> {
  const out = new Set<string>();
  for (const [k, t] of Object.entries(snap.releases)) if (t !== null && t <= serverNowMs) out.add(k);
  return out;
}

/** The next opening still ahead of `serverNowMs`, so the page can open it at that moment without a reload. */
export function nextOpening(snap: ReleaseSnapshot, serverNowMs: number): number | undefined {
  let next: number | undefined;
  for (const t of Object.values(snap.releases)) if (t !== null && t > serverNowMs && (next === undefined || t < next)) next = t;
  return next;
}

/** Server time now, from the answer's server time and the milliseconds elapsed since it arrived. */
export const serverNow = (snap: ReleaseSnapshot, receivedAtMs: number, nowMs: number) => snap.serverTimeMs + Math.max(0, nowMs - receivedAtMs);

/**
 * While the API cannot be reached: the build's NEXT_PUBLIC_ORRY_FEATURES list, and nothing open when it is unset.
 */
export function fallbackOpen(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
