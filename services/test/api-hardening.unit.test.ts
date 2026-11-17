import { describe, expect, it } from "vitest";
import { buildApi, limiter, loadConfig, type Chain, type Config, type Sql } from "@orrery/server";

/** No chain, no database: the API is built on stubs whose errors carry secrets, and none may reach a visitor. */
const SECRET_RPC = "https://rpc.example.org/v2/SECRETKEY123";
const SECRET_DB = "postgres://orrery:dbpassword@db.internal:5432/orrery";

function cfg(over: Partial<Config> = {}): Config {
  return {
    chainId: 4663,
    corsOrigins: [],
    publicRatePerMinute: 60,
    trustProxy: "loopback,linklocal,uniquelocal",
    addresses: { lens: "0x0000000000000000000000000000000000000001" },
    pricing: { checksPerMinute: 120, planChecksPerMinute: 1200 },
    ...over,
  } as unknown as Config;
}

const failingChain = {
  public: {
    readContract: async () => {
      throw Object.assign(new Error(`HTTP request failed.\n\nStatus: 401\nURL: ${SECRET_RPC}\nRequest body: {}`), { name: "HttpRequestError" });
    },
  },
} as unknown as Chain;

const failingSql = (() => {
  throw new Error(`connect ECONNREFUSED ${SECRET_DB}`);
}) as unknown as Sql;

const PAYER = "0x00000000000000000000000000000000000000aa";

describe("API errors never carry internal text", () => {
  it("a failed chain read answers 503 without the RPC URL", async () => {
    const app = buildApi(cfg(), failingChain, failingSql);
    const res = await app.inject({ method: "GET", url: `/v1/signers/${PAYER}` });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("SECRETKEY123");
    expect(res.body).not.toContain("rpc.example.org");
    expect(res.json()).toEqual({ error: "Chain read failed. Retry in a few seconds." });
  });

  it("an unhandled error answers 500 with a fixed message", async () => {
    const app = buildApi(cfg(), failingChain, failingSql);
    const res = await app.inject({ method: "GET", url: "/v1/credits", headers: { authorization: "Bearer some-key" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("dbpassword");
    expect(res.body).not.toContain("postgres://");
    expect(res.json()).toEqual({ error: "Unexpected server error. Please retry in a few seconds." });
  });

  it("a malformed body answers 400 with our own words", async () => {
    const app = buildApi(cfg(), failingChain, failingSql);
    const res = await app.inject({ method: "POST", url: "/v1/keys/rotate", headers: { "content-type": "application/json" }, payload: "{" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Malformed request. Fix the fields and resend." });
  });
});

describe("per-IP limit behind a proxy", () => {
  const hit = (app: ReturnType<typeof buildApi>, remoteAddress: string, xff?: string) =>
    app.inject({ method: "GET", url: `/v1/signers/${PAYER}`, remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {} });

  it("visitors behind a private-range proxy each get their own bucket", async () => {
    const app = buildApi(cfg({ publicRatePerMinute: 2 }), failingChain, failingSql);
    expect((await hit(app, "172.18.0.2", "198.51.100.1")).statusCode).toBe(503);
    expect((await hit(app, "172.18.0.2", "198.51.100.1")).statusCode).toBe(503);
    expect((await hit(app, "172.18.0.2", "198.51.100.1")).statusCode).toBe(429);
    expect((await hit(app, "172.18.0.2", "198.51.100.2")).statusCode).toBe(503);
  });

  it("a visitor on a public address cannot escape the limit with a forged header", async () => {
    const app = buildApi(cfg({ publicRatePerMinute: 2 }), failingChain, failingSql);
    expect((await hit(app, "203.0.113.9", "198.51.100.11")).statusCode).toBe(503);
    expect((await hit(app, "203.0.113.9", "198.51.100.12")).statusCode).toBe(503);
    expect((await hit(app, "203.0.113.9", "198.51.100.13")).statusCode).toBe(429);
  });

  it("trust is configurable and can be turned off", () => {
    const base = { ORRERY_MODULE: "0x1", ORRERY_ATTESTOR: "0x1", ORRERY_LENS: "0x1", ORRERY_REGISTRY: "0x1", ORRERY_USDG: "0x1", ORRERY_TREASURY: "0x1" };
    expect(loadConfig(base).trustProxy).toBe("loopback,linklocal,uniquelocal");
    expect(loadConfig({ ...base, ORRERY_TRUST_PROXY: "" }).trustProxy).toBe("loopback,linklocal,uniquelocal");
    expect(loadConfig({ ...base, ORRERY_TRUST_PROXY: "off" }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, ORRERY_TRUST_PROXY: "10.0.0.0/8" }).trustProxy).toBe("10.0.0.0/8");
  });
});

describe("limiter memory stays bounded", () => {
  it("holds at most maxEntries addresses, dropping the least recently seen", () => {
    let t = 0;
    const allow = limiter(1, 3, () => t);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    allow("b");
    allow("c");
    allow("d"); // pushes out "a", the least recently seen
    expect(allow("a")).toBe(true);
  });

  it("forgets idle buckets after a minute without changing any answer", () => {
    let t = 0;
    const allow = limiter(2, 10_000, () => t);
    for (let i = 0; i < 5_000; i++) allow(`10.0.${i >> 8}.${i & 255}`);
    expect(allow("x")).toBe(true);
    expect(allow("x")).toBe(true);
    expect(allow("x")).toBe(false);
    t += 61_000;
    expect(allow("x")).toBe(true);
  });
});

describe("RPC endpoint list", () => {
  it("keeps order, trims and drops empties", async () => {
    const { rpcUrls } = await import("@orrery/server");
    expect(rpcUrls("https://a.example, https://b.example ,")).toEqual(["https://a.example", "https://b.example"]);
    expect(rpcUrls("http://127.0.0.1:8545")).toEqual(["http://127.0.0.1:8545"]);
    expect(() => rpcUrls(" , ")).toThrow();
  });
});
