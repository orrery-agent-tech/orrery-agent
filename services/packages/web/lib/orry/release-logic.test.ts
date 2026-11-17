import { describe, expect, it } from "vitest";
import { fallbackOpen, nextOpening, openFeatures, parseReleases, serverNow } from "./release-logic";

const T0 = Date.parse("2026-11-09T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("runtime release switch", () => {
  const body = { serverTime: iso(T0), releases: { earn: iso(T0 - 60_000), stake: iso(T0 + 90_000), claim: null, burn: "not a time" } };

  it("parses the API answer and rejects other shapes", () => {
    const snap = parseReleases(body)!;
    expect(snap.serverTimeMs).toBe(T0);
    expect(snap.releases.claim).toBeNull();
    expect(snap.releases.burn).toBeNull(); // an unreadable time holds
    expect(parseReleases({ releases: {} })).toBeUndefined();
    expect(parseReleases({ serverTime: iso(T0) })).toBeUndefined();
    expect(parseReleases(null)).toBeUndefined();
  });

  it("holds null and missing features, opens past times", () => {
    const open = openFeatures(parseReleases(body)!, T0);
    expect([...open]).toEqual(["earn"]);
    expect(open.has("leaderboard")).toBe(false); // missing from the answer: held
  });

  it("opens a future time when the server clock reaches it, without a new answer", () => {
    const snap = parseReleases(body)!;
    const receivedAt = 5_000; // performance.now() when the answer arrived
    expect(openFeatures(snap, serverNow(snap, receivedAt, receivedAt + 89_999)).has("stake")).toBe(false);
    expect(openFeatures(snap, serverNow(snap, receivedAt, receivedAt + 90_000)).has("stake")).toBe(true);
    expect(nextOpening(snap, T0)).toBe(T0 + 90_000);
    expect(nextOpening(snap, T0 + 90_000)).toBeUndefined();
  });

  it("measures from the server's clock, not the browser's", () => {
    const snap = parseReleases({ serverTime: iso(T0), releases: { earn: iso(T0 + 1_000) } })!;
    // A browser clock a day ahead changes nothing: only the elapsed time since the answer counts.
    expect(openFeatures(snap, serverNow(snap, 100, 100)).has("earn")).toBe(false);
    expect(openFeatures(snap, serverNow(snap, 100, 1_100)).has("earn")).toBe(true);
  });

  it("pulls a feature back when its time turns null", () => {
    const opened = parseReleases({ serverTime: iso(T0), releases: { earn: iso(T0 - 1) } })!;
    const pulled = parseReleases({ serverTime: iso(T0 + 60_000), releases: { earn: null } })!;
    expect(openFeatures(opened, T0).has("earn")).toBe(true);
    expect(openFeatures(pulled, T0 + 60_000).has("earn")).toBe(false);
  });

  it("accepts unix seconds and milliseconds", () => {
    const snap = parseReleases({ serverTime: T0 / 1000, releases: { earn: T0 - 1, stake: String((T0 + 5_000) / 1000) } })!;
    expect(snap.serverTimeMs).toBe(T0);
    expect([...openFeatures(snap, T0)]).toEqual(["earn"]);
    expect(nextOpening(snap, T0)).toBe(T0 + 5_000);
  });

  it("falls back to the build list, held when unset", () => {
    expect(fallbackOpen(undefined).size).toBe(0);
    expect(fallbackOpen("").size).toBe(0);
    expect([...fallbackOpen(" Earn, stake ,")]).toEqual(["earn", "stake"]);
  });
});
