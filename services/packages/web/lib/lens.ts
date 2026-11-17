"use client";

import { isAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import { orreryLensAbi } from "@orrery/shared";
import { ADDRESSES } from "./config";

export function useSignerView(signer?: string) {
  const ok = Boolean(signer && isAddress(signer) && ADDRESSES.lens);
  return useReadContract({
    address: ADDRESSES.lens,
    abi: orreryLensAbi,
    functionName: "checkBySigner",
    args: ok ? [signer as Address] : undefined,
    query: { enabled: ok, refetchInterval: 15_000 },
  });
}

export function useAgentView(agentId?: bigint, account?: string) {
  const ok = Boolean(agentId !== undefined && account && isAddress(account) && ADDRESSES.lens);
  return useReadContract({
    address: ADDRESSES.lens,
    abi: orreryLensAbi,
    functionName: "checkByAgent",
    args: ok ? [agentId!, account as Address] : undefined,
    query: { enabled: ok, refetchInterval: 15_000 },
  });
}
