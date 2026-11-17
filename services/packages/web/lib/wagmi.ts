import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { activeChain, RPC_URL } from "./config";

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
  transports: { [activeChain.id]: http(RPC_URL, { batch: { wait: 16 }, retryCount: 2 }) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
