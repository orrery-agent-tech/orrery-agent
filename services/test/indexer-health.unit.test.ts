import { describe, expect, it } from "vitest";
import { blockTimes, chainHead, indexerHealth, lagBehind, logLine, type Chain } from "@orrery/server";

const base = { orry: null, orryOn: false, maxLag: 600n, confirmations: 10 };

describe("indexer health against the live head", () => {
  it("a stuck indexer is unhealthy even though its own stored head matches its cursor", () => {
    // stored state: last = head = 1,000 (lag 0 by the old rule); the chain has moved on 9,022 blocks
    const h = indexerHealth({ ...base, head: 10_022n, main: { last: 1_000n } });
    expect(h.ok).toBe(false);
    expect(h.mainLag).toBe(9_022n);
  });

  it("healthy within maxLag, and unhealthy when the head cannot be read or there is no cursor yet", () => {
    expect(indexerHealth({ ...base, head: 1_600n, main: { last: 1_000n } }).ok).toBe(true);
    expect(indexerHealth({ ...base, head: 1_601n, main: { last: 1_000n } }).ok).toBe(false);
    expect(indexerHealth({ ...base, head: null, main: { last: 1_000n } }).ok).toBe(false);
    expect(indexerHealth({ ...base, head: 1_000n, main: null }).ok).toBe(false);
  });

  it("the ORRY cursor may trail by confirmations on top of maxLag", () => {
    const on = { ...base, orryOn: true, head: 2_000n, main: { last: 2_000n } };
    expect(indexerHealth({ ...on, orry: { last: 1_390n } }).ok).toBe(true); // 610 = 600 + 10
    expect(indexerHealth({ ...on, orry: { last: 1_389n } }).okOrry).toBe(false);
    expect(indexerHealth({ ...on, orry: null }).ok).toBe(false);
  });

  it("a cursor ahead of a lagging RPC head counts as zero lag", () => {
    expect(lagBehind({ last: 105n }, 100n)).toBe(0n);
  });

  it("reads the head at most once per window", async () => {
    let calls = 0;
    let n = 100n;
    const chain = { public: { getBlockNumber: async () => (calls++, n++) } } as unknown as Chain;
    let t = 0;
    expect(await chainHead(chain, 3_000, () => t)).toBe(100n);
    t = 2_999;
    expect(await chainHead(chain, 3_000, () => t)).toBe(100n);
    t = 3_000;
    expect(await chainHead(chain, 3_000, () => t)).toBe(101n);
    expect(calls).toBe(2);
  });

  it("log lines never carry an RPC URL", () => {
    const err = Object.assign(new Error("HTTP request failed. URL: https://rpc.example.org/v2/SECRETKEY123 Status: 429"), { name: "HttpRequestError" });
    expect(logLine(err)).not.toContain("SECRETKEY123");
    expect(logLine(err)).toContain("[url]");
  });
});

describe("block times of logs", () => {
  it("uses the time on the log, and reads the block when the node sends none or 0x0", async () => {
    const reads: bigint[] = [];
    const chain = { public: { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => (reads.push(blockNumber), { timestamp: 1_000n + blockNumber }) } } as unknown as Chain;
    const logs = [
      { blockNumber: 1n, blockTimestamp: "0x6af2d65f" },
      { blockNumber: 2n, blockTimestamp: "0x0" },
      { blockNumber: 3n },
      { blockNumber: 3n, blockTimestamp: null },
    ] as never[];
    const t = await blockTimes(chain, logs);
    expect(t.get(1n)!.getTime()).toBe(0x6af2d65f * 1000);
    expect(t.get(2n)!.getTime()).toBe(1_002_000);
    expect(t.get(3n)!.getTime()).toBe(1_003_000);
    expect(reads).toEqual([2n, 3n]);
  });
});
