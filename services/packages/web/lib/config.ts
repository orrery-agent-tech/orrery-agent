import { defineChain, type Address } from "viem";

/**
 * Public configuration. Contract addresses have no default: they are real deployment addresses. Without them the
 * reading features show their forward state instead of rendering blank.
 */
const env = (v: string | undefined) => (v && v.length > 0 ? v : undefined);

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc-robinhood.blockmachine.io";
/**
 * The RPC written into an agent's key file. The page only reads through RPC_URL (the wallet publishes its own
 * transactions), but an agent sends its top-ups itself, and the default read endpoint on 4663 does not publish
 * transactions. Elsewhere the page's own RPC is the right one (a local chain, the development network).
 */
export const AGENT_RPC_URL = env(process.env.NEXT_PUBLIC_AGENT_RPC_URL) ?? (CHAIN_ID === 4663 ? "https://robinhood-rpc.publicnode.com" : RPC_URL);
export const API_URL = env(process.env.NEXT_PUBLIC_API_URL);
export const WALLET_DIRECTORY_URL = "https://ethereum.org/en/wallets/find-wallet/";

export const ADDRESSES = {
  module: env(process.env.NEXT_PUBLIC_MODULE) as Address | undefined,
  attestor: env(process.env.NEXT_PUBLIC_ATTESTOR) as Address | undefined,
  lens: env(process.env.NEXT_PUBLIC_LENS) as Address | undefined,
  registry: env(process.env.NEXT_PUBLIC_REGISTRY) as Address | undefined,
  usdg: (env(process.env.NEXT_PUBLIC_USDG) ?? (CHAIN_ID === 4663 ? "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" : undefined)) as Address | undefined,
};

export const deployed = Boolean(ADDRESSES.module && ADDRESSES.lens && ADDRESSES.attestor);

const NAMES: Record<number, string> = { 4663: "Robinhood Chain", 46630: "Robinhood Chain development network", 31337: "Local chain" };

export const activeChain = defineChain({
  id: CHAIN_ID,
  name: NAMES[CHAIN_ID] ?? `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const USDG_DECIMALS = 6;
