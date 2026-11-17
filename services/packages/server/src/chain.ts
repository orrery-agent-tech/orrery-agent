import { createPublicClient, createWalletClient, defineChain, fallback, http, type PublicClient, type WalletClient, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";

export interface Chain {
  public: PublicClient;
  wallet: (key: `0x${string}`) => WalletClient & { account: Account };
}

export function makeChain(cfg: Config): Chain {
  const chain = defineChain({
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls(cfg.rpcUrl) } },
  });
  const urls = rpcUrls(cfg.rpcUrl);
  // ORRERY_RPC_URL may list several endpoints, comma separated: the first is used, the next ones take over when it errors.
  const transport = urls.length === 1 ? http(urls[0], { retryCount: 3 }) : fallback(urls.map((u) => http(u, { retryCount: 2 })));
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  return {
    public: pub,
    wallet: (key) => createWalletClient({ chain, transport, account: privateKeyToAccount(key) }) as WalletClient & { account: Account },
  };
}

/** Splits `ORRERY_RPC_URL` into its endpoints, in order; at least one. */
export function rpcUrls(value: string): string[] {
  const urls = value.split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error("ORRERY_RPC_URL is empty");
  return urls;
}
