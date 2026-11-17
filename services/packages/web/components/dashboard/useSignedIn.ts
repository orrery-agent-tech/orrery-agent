"use client";

import { useEffect, useState } from "react";
import { useConnection } from "wagmi";

/** A wallet is connected in this browser. False on the server and on the first client render, so markup matches. */
export function useSignedIn(): boolean {
  const { isConnected, address } = useConnection();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && isConnected && Boolean(address);
}
