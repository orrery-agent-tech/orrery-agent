import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Abi, Address, Hex } from "viem";
import { foundry } from "viem/chains";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { devUSDGAbi } from "@orrery/sdk";
import { buildApi, connect, loadConfig, makeChain, migrate, setRelease, type Sql } from "@orrery/server";
import { createOrreryMcpServer, loadMcpConfig, readKeyFile } from "../src/index.js";
import { devUSDGBytecode } from "../../../test/generated/bytecode.js";
import { orryStandInAbi, orryStandInBytecode } from "../../../test/generated/standins.js";
import { DATABASE_URL, MCP_ANVIL_PORT } from "../../../test/env.js";
import { ROLE, anvilKey, clients, send, startAnvil } from "../../../test/orry-system.js";

/**
 * `@orrery/mcp` against the local stack: anvil with DevUSDG, the API with Orrery Data open, and the MCP server connected
 * to a client in memory. The agent is a plain signer whose float already holds USDG, so no policy module is needed.
 */

const RPC = `http://127.0.0.1:${MCP_ANVIL_PORT}`;
const USD = 1_000_000n;
let anvil: ChildProcess | undefined;
let c: ReturnType<typeof clients>;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let base: string;
let usdg: Address;
let client: Client;
const dir = mkdtempSync(join(tmpdir(), "orrery-mcp-"));
const keyFile = join(dir, "agent.key");
const apiKeyFile = join(dir, "api.key");
const treasury = () => c.address(ROLE.quoteSigner);

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
const parsed = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

async function deploy(abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const w = c.wallet(ROLE.deployer);
  const hash = await w.deployContract({ abi, bytecode, args, chain: foundry, account: w.account });
  return (await c.pub.waitForTransactionReceipt({ hash })).contractAddress!;
}

async function connectMcp(env: Record<string, string>): Promise<Client> {
  const server = createOrreryMcpServer({ config: loadMcpConfig(env) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "orrery-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(a), cl.connect(b)]);
  return cl;
}

beforeAll(async () => {
  anvil = await startAnvil(MCP_ANVIL_PORT);
  c = clients(RPC);
  usdg = await deploy(devUSDGAbi as Abi, devUSDGBytecode as Hex, [c.address(ROLE.deployer)]);
  const standIn = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  await send(c, ROLE.deployer, usdg, devUSDGAbi as Abi, "mint", [c.address(ROLE.alice), 10n * USD]);
  const cfg = loadConfig({
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: standIn,
    ORRERY_ATTESTOR: standIn,
    ORRERY_LENS: standIn,
    ORRERY_REGISTRY: standIn,
    ORRERY_USDG: usdg,
    ORRERY_TREASURY: treasury(),
    ORRERY_CONFIRMATIONS: "1",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    ORRERY_DATA_CACHE_MS: "0",
  });
  sql = connect(cfg.databaseUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrate(sql);
  await setRelease(sql, "data", new Date(Date.now() - 1000), "test");
  app = buildApi(cfg, makeChain(cfg), sql);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  writeFileSync(keyFile, anvilKey(ROLE.alice), { mode: 0o600 });
  client = await connectMcp({
    ORRERY_API_URL: base,
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_ATTESTOR: standIn,
    ORRERY_MODULE: standIn,
    ORRERY_AGENT_KEY_FILE: keyFile,
    ORRERY_API_KEY_FILE: apiKeyFile,
    ORRERY_MCP_MAX_PAYMENT_USD: "0.5",
  });
});

afterAll(async () => {
  await client?.close();
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

describe("@orrery/mcp", () => {
  it("lists every tool, and each description states its cost", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "orrery_agent_record",
        "orrery_allowance",
        "orrery_check_agent",
        "orrery_check_payer",
        "orrery_credits",
        "orrery_data_buy_pack",
        "orrery_data_catalog",
        "orrery_data_providers",
        "orrery_data_query",
        "orrery_data_verify",
        "orrery_ensure_float",
        "orrery_pay_x402",
        "orrery_pricing",
        "orrery_signer_record",
        "orrery_verify_check",
      ].sort(),
    );
    for (const t of tools) expect(t.description, t.name).toMatch(/^(No charge|Costs|Uses one|Gas only)/);
  });

  it("refuses a session key file others can read", () => {
    const loose = join(dir, "loose.key");
    writeFileSync(loose, anvilKey(ROLE.alice), { mode: 0o644 });
    expect(() => readKeyFile(loose)).toThrow(/chmod 600/);
    expect(readKeyFile(keyFile)).toBe(anvilKey(ROLE.alice));
  });

  it("reads the catalogue and the prices for free", async () => {
    const cat = parsed(await call("orrery_data_catalog"));
    expect((cat.datasets as unknown[]).length).toBe(7);
    const pricing = parsed(await call("orrery_pricing"));
    expect(pricing.data).toMatchObject({ packCalls: 1000, packUsd: "1000000" });
  });

  it("asks for a key before a paid query", async () => {
    const r = await call("orrery_data_query", { dataset: "chain-health" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/ORRERY_API_KEY/);
  });

  it("buys a pack only with confirm above the set amount, keeps the key out of the answer and in a 600 file", async () => {
    const capped = await call("orrery_data_buy_pack", { asset: "USDG" });
    expect(capped.isError).toBe(true);
    expect(capped.content[0]!.text).toMatch(/confirm: true/);
    const before = (await c.pub.readContract({ address: usdg, abi: devUSDGAbi, functionName: "balanceOf", args: [treasury()] })) as bigint;
    const r = await call("orrery_data_buy_pack", { asset: "USDG", confirm: true });
    expect(r.isError).toBeFalsy();
    const body = parsed(r);
    expect(body.calls).toBe("1000");
    expect(r.content[0]!.text).not.toMatch(/or_[0-9a-f]{64}/);
    expect(statSync(apiKeyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(apiKeyFile, "utf8")).toMatch(/^or_[0-9a-f]{64}$/);
    const after = (await c.pub.readContract({ address: usdg, abi: devUSDGAbi, functionName: "balanceOf", args: [treasury()] })) as bigint;
    expect(after - before).toBe(USD);
  });

  it("queries a dataset, verifies the signature before showing it, and spends one call", async () => {
    const r = parsed(await call("orrery_data_query", { dataset: "chain-health" }));
    expect(r.verified).toBe(true);
    expect((r.account as { calls: string }).calls).toBe("999");
    const records = r.records as Record<string, unknown>[];
    expect(records[0]).toMatchObject({ sampleBlocks: expect.any(Number) });
    const tampered = { ...r, records: [{ ...records[0], block: "0" }] };
    expect(parsed(await call("orrery_data_verify", { response: tampered }))).toEqual({ ok: false, reason: "records_hash_mismatch" });
    const { verified: _v, notice: _n, ...original } = r;
    expect(parsed(await call("orrery_data_verify", { response: original }))).toEqual({ ok: true });
    const credits = parsed(await call("orrery_credits"));
    expect(credits.data).toMatchObject({ calls: "999" });
  });

  it("pays an x402 URL from the float, only with confirm above the set amount", async () => {
    const url = `${base}/v1/data/packs`;
    const capped = await call("orrery_pay_x402", { url, method: "POST" });
    expect(capped.isError).toBe(true);
    const paid = parsed(await call("orrery_pay_x402", { url, method: "POST", confirm: true }));
    expect(paid).toMatchObject({ status: 200, paid: true, amount: "1000000" });
    expect((JSON.parse(String(paid.body)) as { account: { calls: string } }).account.calls).toBe("1999");
    expect((await call("orrery_pay_x402", { url: "http://example.com/x" })).content[0]!.text).toMatch(/https/);
  });
});
