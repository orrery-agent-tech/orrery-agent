import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DATA_CATALOG, assertDataValues, dataQueryHash, normalizeDataQuery, packCallsFor } from "@orrery/shared";
import { parseStocks } from "../packages/server/src/data-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../packages/server/src");

describe("Orrery Data sources (DA-4)", () => {
  it("every dataset names only the chain and Orrery's own system as sources", () => {
    for (const d of Object.values(DATA_CATALOG)) expect(d.sources.every((s) => s === "chain" || s === "orrery")).toBe(true);
  });

  it("the data modules call no other host: no fetch, no HTTP client, no URL", () => {
    const files = readdirSync(src).filter((f) => f.startsWith("data-") && f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const code = readFileSync(join(src, f), "utf8");
      expect(code, f).not.toMatch(/\bfetch\s*\(/);
      expect(code, f).not.toMatch(/from "(undici|node:https?|axios|got)"/);
      expect(code, f).not.toMatch(/https?:\/\//);
    }
  });
});

describe("Orrery Data helpers", () => {
  it("pays the stake discount as calls, capped", () => {
    expect(packCallsFor(1000, 0, 9000)).toBe(1000);
    expect(packCallsFor(1000, 2000, 9000)).toBe(1250);
    expect(packCallsFor(1000, 10_000, 9000)).toBe(10_000); // capped at 90%
    expect(packCallsFor(1000, -5, 9000)).toBe(1000);
  });

  it("hashes the query independent of key order and empty values", () => {
    expect(normalizeDataQuery({ b: 2, a: "x", c: "", d: undefined })).toEqual({ a: "x", b: "2" });
    expect(dataQueryHash({ b: "2", a: "x" })).toBe(dataQueryHash({ a: "x", b: "2" }));
  });

  it("refuses records whose JSON is not the same in every language", () => {
    expect(() => assertDataValues([{ a: "1", b: 2, c: true, d: null, e: [{ f: "x" }] }])).not.toThrow();
    expect(() => assertDataValues([{ a: 0.5 }])).toThrow(/safe integers/);
    expect(() => assertDataValues([{ a: 2 ** 60 }])).toThrow(/safe integers/);
  });

  it("parses the stock list and refuses a bad one", () => {
    const s = parseStocks("TSLA:0x322F0929c4625eD5bAd873c95208D54E1c003b2d:0x4A1166a659A55625345e9515b32adECea5547C38");
    expect(s[0]).toMatchObject({ symbol: "TSLA", poolId: null });
    expect(() => parseStocks("TSLA:0x1:0x2")).toThrow(/ORRERY_DATA_STOCKS/);
    expect(() => parseStocks(`TSLA:${"0x322F0929c4625eD5bAd873c95208D54E1c003b2d"}:${"0x4A1166a659A55625345e9515b32adECea5547C38"}:0x12`)).toThrow(/32 bytes/);
  });
});
