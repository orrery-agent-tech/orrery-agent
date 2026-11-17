import { concat, encodeFunctionData, encodePacked, parseAbi, size, type Address, type Hex } from "viem";

/**
 * One-click setup for the Operator page: the account an agent pays from, the agent's identity, its signer and the
 * starting limits. Pure helpers, no React, so the tests run without the app.
 */

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * Safe 1.4.1 (canonical deployment) and the Safe7579 v1.0.0 adapter, by chain. Bytecode present at every address on
 * 4663 (checked 2026-11-11). A chain missing here has no one-click account; its page keeps the address field only.
 */
export interface SafeStack {
  factory: Address;
  singleton: Address;
  adapter: Address;
  multiSendCallOnly: Address;
}
export const SAFE_STACK: Record<number, SafeStack> = {
  4663: {
    factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    adapter: "0x7579EE8307284F293B1927136486880611F20002",
    multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  },
};

export const safeSetupAbi = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function enableModule(address module)",
  "function isModuleEnabled(address module) view returns (bool)",
]);
export const safeFactoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);
const adapterInitAbi = parseAbi([
  "struct ModuleInit { address module; bytes initData; }",
  "struct RegistryInit { address registry; address[] attesters; uint8 threshold; }",
  "function initializeAccount(ModuleInit[] validators, ModuleInit[] executors, ModuleInit[] fallbacks, ModuleInit[] hooks, RegistryInit registryInit)",
]);
export const identityRegistryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

/** MultiSend packing: operation (0 = call), to, value, data length, data. */
const packCall = (to: Address, data: Hex): Hex => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, 0n, BigInt(size(data)), data]);

/**
 * Step 1 of the operator's account: a 1-of-1 Safe owned by `owner`, with the Safe7579 adapter as its fallback handler.
 * The proxy address is in the ProxyCreation event of the receipt.
 */
export function createSafeCall(stack: SafeStack, owner: Address, saltNonce: bigint): { to: Address; data: Hex } {
  const initializer = encodeFunctionData({ abi: safeSetupAbi, functionName: "setup", args: [[owner], 1n, ZERO, "0x", stack.adapter, ZERO, 0n, ZERO] });
  return { to: stack.factory, data: encodeFunctionData({ abi: safeFactoryAbi, functionName: "createProxyWithNonce", args: [stack.singleton, initializer, saltNonce] }) };
}

/**
 * Step 2, sent by the Safe as one delegatecall to MultiSendCallOnly: enable the adapter as a module and initialise the
 * Safe7579 account with the Orrery policy module installed as its executor. Both calls go to the Safe itself. The Safe's
 * address is part of this calldata, which is why it cannot ride inside step 1 (the address depends on step 1's calldata).
 */
export function prepareAccountCall(stack: SafeStack, safe: Address, policyModule: Address): { to: Address; data: Hex; operation: 1 } {
  const enable = encodeFunctionData({ abi: safeSetupAbi, functionName: "enableModule", args: [stack.adapter] });
  const init = encodeFunctionData({
    abi: adapterInitAbi,
    functionName: "initializeAccount",
    args: [[], [{ module: policyModule, initData: "0x" }], [], [], { registry: ZERO, attesters: [], threshold: 0 }],
  });
  return { to: stack.multiSendCallOnly, data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [concat([packCall(safe, enable), packCall(safe, init)])] }), operation: 1 };
}

// ------------------------------------------------------------------ starting limits

export interface LimitPreset {
  id: string;
  label: string;
  perTx: string;
  perDay: string;
  floatMax: string;
}
/** Starting points for the caps form, in USDG. The operator edits any of them before signing. */
export const LIMIT_PRESETS: LimitPreset[] = [
  { id: "small", label: "Small", perTx: "1", perDay: "10", floatMax: "5" },
  { id: "standard", label: "Standard", perTx: "10", perDay: "50", floatMax: "20" },
  { id: "large", label: "Large", perTx: "100", perDay: "500", floatMax: "200" },
];
export const DEFAULT_PRESET = LIMIT_PRESETS[1]!;

/** yyyy-mm-dd, `days` from `nowMs` in UTC: the form's default policy expiry. */
export const defaultExpiry = (nowMs: number, days = 30): string => new Date(nowMs + days * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ remembered agent

export interface Remembered {
  account?: string;
  agentId?: string;
}
const key = (chainId: number, owner: string) => `orrery.operator.${chainId}.${owner.toLowerCase()}`;

/** The account and agent this wallet last opened here. Public values only; a signer key is never stored. */
export function recall(chainId: number, owner: string): Remembered {
  try {
    const v = JSON.parse(window.localStorage.getItem(key(chainId, owner)) ?? "{}") as Remembered;
    return { account: typeof v.account === "string" ? v.account : undefined, agentId: typeof v.agentId === "string" ? v.agentId : undefined };
  } catch {
    return {};
  }
}
export function remember(chainId: number, owner: string, v: Remembered): void {
  try {
    window.localStorage.setItem(key(chainId, owner), JSON.stringify({ ...recall(chainId, owner), ...v }));
  } catch {}
}

// ------------------------------------------------------------------ signer key file

/** The file the operator hands to the agent: everything `AgentClient` needs, as environment variables. */
export function agentEnvFile(a: { signerKey: Hex; signer: Address; chainId: number; rpcUrl: string; module: Address; account: Address; agentId: bigint }): string {
  return [
    `# Orrery signer key · agent #${a.agentId} · chain ${a.chainId}. This file belongs on the agent's machine only.`,
    `ORRERY_SIGNER_KEY=${a.signerKey}`,
    `ORRERY_SIGNER_ADDRESS=${a.signer}`,
    `ORRERY_CHAIN_ID=${a.chainId}`,
    `ORRERY_RPC_URL=${a.rpcUrl}`,
    `ORRERY_MODULE=${a.module}`,
    `ORRERY_ACCOUNT=${a.account}`,
    `ORRERY_AGENT_ID=${a.agentId}`,
    "",
  ].join("\n");
}
