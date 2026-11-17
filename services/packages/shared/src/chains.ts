import { defineChain } from "viem";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-robinhood.blockmachine.io"] } },
});

export const robinhoodDevChain = defineChain({
  id: 46630,
  name: "Robinhood Chain development network",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});

export const caip2 = (chainId: number) => `eip155:${chainId}` as const;
