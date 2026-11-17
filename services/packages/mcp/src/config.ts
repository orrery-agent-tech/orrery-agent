import { readFileSync, statSync } from "node:fs";
import { isAddress, isHex, type Address, type Hex } from "viem";

/**
 * Orrery MCP server settings, all from the environment. Defaults point at Orrery on Robinhood Chain (4663), so a client
 * that sets only `ORRERY_API_KEY` gets the counterparty tools; agent tools also need the session signer's key file.
 */
export interface McpConfig {
  apiUrl: string;
  /** Counterparty tools (checks, credits, data queries); may be issued during the session by a pack purchase. */
  apiKey: string | null;
  /** Where a key issued during the session is saved (mode 600); null keeps it in memory for the session only. */
  apiKeyFile: string | null;
  rpcUrl: string;
  chainId: number;
  attestor: Address;
  module: Address;
  /** Session signer key, read from a file only readable by its owner (mode 600). Null: no agent tools. */
  agentKey: Hex | null;
  /** A payment worth more than this (USD) needs `confirm: true` in the call. */
  maxPaymentUsd: number;
}

/** Orrery v1 on 4663, from deployments/4663.json (deployed 2026-11-16, block 115888274). */
const ATTESTOR_4663: Address | null = "0x6f192242029d779d676246C773AdbA47F7c3a0d7";
const MODULE_4663: Address | null = "0x2B4F4B391eD19C26587fC7c83fbf7646BA24CE72";

function addr(env: NodeJS.ProcessEnv, name: string, dflt: Address | null): Address {
  const v = env[name] || dflt;
  if (!v) throw new Error(`Set ${name} to the Orrery contract address for this chain`);
  if (!isAddress(v)) throw new Error(`${name} expects a 0x address`);
  return v as Address;
}

/** Reads the session signer's key. The file must not be readable by group or others (mode 600 or stricter). */
export function readKeyFile(path: string): Hex {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} has mode ${mode.toString(8)}; run chmod 600 so only you can read it`);
  const raw = readFileSync(path, "utf8").trim();
  const key = (raw.startsWith("{") ? (JSON.parse(raw) as { privateKey?: string }).privateKey : raw) ?? "";
  if (!isHex(key) || key.length !== 66) throw new Error(`${path} should contain one 32 byte private key, 0x prefixed`);
  return key as Hex;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const max = env.ORRERY_MCP_MAX_PAYMENT_USD === undefined || env.ORRERY_MCP_MAX_PAYMENT_USD === "" ? 1 : Number(env.ORRERY_MCP_MAX_PAYMENT_USD);
  if (!Number.isFinite(max) || max < 0) throw new Error("ORRERY_MCP_MAX_PAYMENT_USD expects a USD amount of 0 or more");
  const chainId = Number(env.ORRERY_CHAIN_ID ?? 4663);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("ORRERY_CHAIN_ID expects a positive integer chain id");
  return {
    apiUrl: (env.ORRERY_API_URL || "https://api.orreryagent.com").replace(/\/+$/, ""),
    apiKey: env.ORRERY_API_KEY || null,
    apiKeyFile: env.ORRERY_API_KEY_FILE || null,
    rpcUrl: env.ORRERY_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    chainId,
    attestor: addr(env, "ORRERY_ATTESTOR", ATTESTOR_4663),
    module: addr(env, "ORRERY_MODULE", MODULE_4663),
    agentKey: env.ORRERY_AGENT_KEY_FILE ? readKeyFile(env.ORRERY_AGENT_KEY_FILE) : null,
    maxPaymentUsd: max,
  };
}
