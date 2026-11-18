"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useWallet } from "@/lib/orry/chain";
import { useAutoReveal } from "@/lib/markets/chain";

type Runtime = ReturnType<typeof useAutoReveal>;
const Ctx = createContext<Runtime | null>(null);

/** One automatic revealer per market page; the desk, the strip and the order list read it from here. */
export function MarketsRuntime({ children }: { children: ReactNode }) {
  const { address } = useWallet();
  const rt = useAutoReveal(address);
  return <Ctx.Provider value={rt}>{children}</Ctx.Provider>;
}

export function useRuntime(): Runtime {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRuntime outside MarketsRuntime");
  return v;
}
