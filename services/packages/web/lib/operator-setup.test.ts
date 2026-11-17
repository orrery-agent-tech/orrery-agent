import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";
import { DEFAULT_PRESET, LIMIT_PRESETS, SAFE_STACK, agentEnvFile, createSafeCall, defaultExpiry, prepareAccountCall, safeFactoryAbi, safeSetupAbi } from "./operator-setup";

const stack = SAFE_STACK[4663]!;
const owner = "0x1111111111111111111111111111111111111111" as const;
const safe = "0x2222222222222222222222222222222222222222" as const;
const module = "0x2B4F4B391eD19C26587fC7c83fbf7646BA24CE72" as const;

describe("operator one-click setup", () => {
  it("creates a 1-of-1 Safe for the owner with the adapter as fallback handler and no setup delegatecall", () => {
    const c = createSafeCall(stack, owner, 7n);
    expect(c.to).toBe(stack.factory);
    const outer = decodeFunctionData({ abi: safeFactoryAbi, data: c.data });
    expect(outer.args[0]).toBe(stack.singleton);
    expect(outer.args[2]).toBe(7n);
    const setup = decodeFunctionData({ abi: safeSetupAbi, data: outer.args[1] });
    expect(setup.functionName).toBe("setup");
    const [owners, threshold, to, data, fallback, , payment] = setup.args as readonly [readonly string[], bigint, string, string, string, string, bigint, string];
    expect(owners).toEqual([owner]);
    expect(threshold).toBe(1n);
    expect(to).toBe("0x0000000000000000000000000000000000000000");
    expect(data).toBe("0x");
    expect(fallback).toBe(stack.adapter);
    expect(payment).toBe(0n);
  });

  it("prepares the account with two calls to the Safe itself, as a delegatecall to MultiSendCallOnly", () => {
    const p = prepareAccountCall(stack, safe, module);
    expect(p.to).toBe(stack.multiSendCallOnly);
    expect(p.operation).toBe(1);
    const [packed] = decodeFunctionData({ abi: parseAbi(["function multiSend(bytes transactions) payable"]), data: p.data }).args;
    const hex = packed.slice(2).toLowerCase();
    // each entry: operation (1 byte, 0 = call), to (20), value (32), length (32), data
    const entries: { op: string; to: string; value: string; data: string }[] = [];
    for (let i = 0; i < hex.length; ) {
      const len = Number(BigInt(`0x${hex.slice(i + 106, i + 170)}`));
      entries.push({ op: hex.slice(i, i + 2), to: `0x${hex.slice(i + 2, i + 42)}`, value: hex.slice(i + 42, i + 106), data: `0x${hex.slice(i + 170, i + 170 + len * 2)}` });
      i += 170 + len * 2;
    }
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.op).toBe("00");
      expect(e.to).toBe(safe);
      expect(BigInt(`0x${e.value}`)).toBe(0n);
    }
    const enable = decodeFunctionData({ abi: safeSetupAbi, data: entries[0]!.data as `0x${string}` });
    expect(enable.functionName).toBe("enableModule");
    expect(enable.args).toEqual([stack.adapter]);
    // the policy module rides in the executors of initializeAccount
    expect(entries[1]!.data.toLowerCase()).toContain(module.slice(2).toLowerCase());
  });

  it("starts the form on working limits and a 30 day expiry", () => {
    expect(LIMIT_PRESETS.map((p) => p.id)).toEqual(["small", "standard", "large"]);
    for (const p of LIMIT_PRESETS) {
      expect(Number(p.perTx)).toBeLessThanOrEqual(Number(p.floatMax));
      expect(Number(p.floatMax)).toBeLessThanOrEqual(Number(p.perDay));
    }
    expect(DEFAULT_PRESET.id).toBe("standard");
    expect(defaultExpiry(Date.parse("2026-11-11T12:00:00Z"))).toBe("2026-12-11");
  });

  it("writes a key file the SDK reads back", () => {
    const text = agentEnvFile({ signerKey: `0x${"ab".repeat(32)}`, signer: owner, chainId: 4663, rpcUrl: "https://rpc.example", module, account: safe, agentId: 42n });
    const env = Object.fromEntries(text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("=") as [string, string]));
    expect(env).toEqual({
      ORRERY_SIGNER_KEY: `0x${"ab".repeat(32)}`,
      ORRERY_SIGNER_ADDRESS: owner,
      ORRERY_CHAIN_ID: "4663",
      ORRERY_RPC_URL: "https://rpc.example",
      ORRERY_MODULE: module,
      ORRERY_ACCOUNT: safe,
      ORRERY_AGENT_ID: "42",
    });
  });
});
