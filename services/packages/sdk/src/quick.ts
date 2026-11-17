/**
 * Entry points that need almost no configuration: an agent built from the key file the Operator page saves, and a
 * merchant's check of a payer in one call. Orrery's own addresses on Robinhood Chain are the defaults.
 */
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "@orrery/shared";
import { AgentClient, OrreryApi, verifyCheck } from "./index";

/**
 * Orrery v1 on Robinhood Chain 4663, addresses from deployments/4663.json (deployed 2026-11-16, block 115888274).
 * The RPC is one that publishes
 * transactions: an agent sends its own top-ups, and rpc-robinhood.blockmachine.io (the web's read endpoint) answers
 * eth_sendRawTransaction with "publishing transactions not supported by this endpoint" (seen on mainnet, 2026-11-11).
 */
export const ORRERY_MAINNET = {
  chainId: 4663,
  rpcUrl: "https://robinhood-rpc.publicnode.com",
  apiUrl: "https://api.orreryagent.com",
  module: "0x2B4F4B391eD19C26587fC7c83fbf7646BA24CE72",
  attestor: "0x6f192242029d779d676246C773AdbA47F7c3a0d7",
  lens: "0xe576C399A01beA52816889585c6693b674E174D2",
} as { readonly chainId: 4663; readonly rpcUrl: string; readonly apiUrl: string; readonly module: Address | null; readonly attestor: Address | null; readonly lens: Address | null };

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};
const chainFor = (chainId: number, rpcUrl: string) =>
  defineChain({ id: chainId, name: chainId === robinhoodChain.id ? robinhoodChain.name : `Chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });

/**
 * The agent's client from environment variables, as written by the key file of the Operator page. Only
 * `ORRERY_SIGNER_KEY` is required; `ORRERY_CHAIN_ID`, `ORRERY_RPC_URL` and `ORRERY_MODULE` default to Orrery on
 * Robinhood Chain.
 */
export function agentFromEnv(env: Env = processEnv()): AgentClient {
  const key = env.ORRERY_SIGNER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("ORRERY_SIGNER_KEY should hold the signer key from your Orrery key file (0x plus 64 hex characters).");
  const chainId = Number(env.ORRERY_CHAIN_ID ?? ORRERY_MAINNET.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("ORRERY_CHAIN_ID expects a positive chain ID, for example 4663.");
  const rpcUrl = env.ORRERY_RPC_URL || ORRERY_MAINNET.rpcUrl;
  const module = env.ORRERY_MODULE || (chainId === ORRERY_MAINNET.chainId ? ORRERY_MAINNET.module : undefined);
  if (!module || !isAddress(module)) throw new Error("ORRERY_MODULE should be the address of the Orrery policy module on this chain.");
  const chain = chainFor(chainId, rpcUrl);
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(key as Hex) }) as WalletClient & { account: Account };
  return new AgentClient(wallet, createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient, getAddress(module));
}

/**
 * A merchant's whole check in one call: asks the check service about `payer`, then verifies the signed answer against
 * the attestor on-chain. `ok` is true only for a valid, current answer about this payer. Defaults to Orrery on
 * Robinhood Chain; pass `apiUrl`, `attestor` and `publicClient` (or `rpcUrl`) for another network.
 */
export async function checkPayment(
  payer: Address,
  apiKey: string,
  opts: { apiUrl?: string; attestor?: Address; rpcUrl?: string; publicClient?: PublicClient } = {},
) {
  const rpcUrl = opts.rpcUrl ?? ORRERY_MAINNET.rpcUrl;
  const publicClient = opts.publicClient ?? (createPublicClient({ chain: chainFor(ORRERY_MAINNET.chainId, rpcUrl), transport: http(rpcUrl) }) as PublicClient);
  const res = await new OrreryApi(opts.apiUrl ?? ORRERY_MAINNET.apiUrl, apiKey).checkPayer(payer);
  const attestor = opts.attestor ?? ORRERY_MAINNET.attestor;
  if (!attestor) throw new Error("Provide the Orrery attestor address for this network.");
  return verifyCheck(publicClient, attestor, res, { payer });
}
