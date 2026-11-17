import { defineChain, type Address } from "viem";

/**
 * Public configuration. Contract addresses have no default: they are real deployment addresses. Without them the
 * reading features show their forward state instead of rendering blank.
 */
const env = (v: string | undefined) => (v && v.length > 0 ? v : undefined);

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);
/**
 * The page's read endpoints, tried in order (`NEXT_PUBLIC_RPC_URL` takes a comma list). On 4663 the free endpoints each
 * cap something: blockmachine allows 60 compute units a minute per IP (code -32029) and publishes no transactions, and
 * dRPC's free plan takes at most 3 requests per batch. publicnode leads because it has neither cap, and it is also the
 * endpoint a wallet receives when the page adds the chain.
 */
const DEFAULT_RPC_URLS = ["https://robinhood-rpc.publicnode.com", "https://rpc-robinhood.blockmachine.io", "https://robinhood.drpc.org"];
export const RPC_URLS = (env(process.env.NEXT_PUBLIC_RPC_URL)?.split(",").map((u) => u.trim()).filter(Boolean)) ?? DEFAULT_RPC_URLS;
export const RPC_URL = RPC_URLS[0]!;
/**
 * A keyed endpoint tried only after every public one has failed. It is set in the host's environment, never in the
 * repository, and never handed to a wallet as the chain's RPC.
 */
export const RPC_FALLBACK_URL = env(process.env.NEXT_PUBLIC_RPC_FALLBACK_URL);
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
