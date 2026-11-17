import { cookieStorage, createConfig, createStorage, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { activeChain, RPC_URLS } from "./config";

/**
 * Reads go to the first endpoint that answers: a rate limit, a refused batch or an outage on one moves the request to
 * the next. Batches stay at 50 (blockmachine refuses more than 100); dRPC's free plan takes 3, so it gets none.
 */
const endpoints = RPC_URLS.map((url) => http(url, /drpc\.org/.test(url) ? {} : { batch: { wait: 16, batchSize: 50 } }));

/**
 * Any injected wallet, never one brand: wagmi turns every EIP-6963 announcement into its own connector with the
 * wallet's own name and icon. The single connector registered here is the untargeted fallback for a wallet that only
 * writes `window.ethereum`. No `target`, no WalletConnect.
 */
export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected({ shimDisconnect: true })],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: { [activeChain.id]: endpoints.length > 1 ? fallback(endpoints, { retryCount: 2 }) : http(RPC_URLS[0], { batch: { wait: 16, batchSize: 50 }, retryCount: 2 }) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
