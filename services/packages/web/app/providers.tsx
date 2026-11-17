"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, type State } from "wagmi";
import { ReleasesProvider } from "@/lib/orry/releases";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children, initialState }: { children: ReactNode; initialState?: State }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={client}>
        <ReleasesProvider>{children}</ReleasesProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
