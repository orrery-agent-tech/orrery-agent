"use client";

import { useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import type { FillStatus, Mode } from "./api";

/**
 * Sealed orders kept in this browser (spec section 5: the web keeps the order and salt and reveals for the user).
 * The order and its salt are written before the commit is sent, so a closed tab never loses what it needs to reveal.
 */
export type SealState = "sealing" | "sealed" | "revealing" | "revealed" | "missed" | "settled";

export interface SealedOrder {
  id: string;
  chainId: number;
  market: Address;
  symbol: string;
  assetDecimals: number;
  account: Address;
  batch: string;
  order: { sellAsset: boolean; amountIn: string; limitPrice: string; mode: Mode; payFeeInOrry: boolean };
  salt: Hex;
  commitment: Hex;
  commitTx?: Hex;
  commitBlock?: string;
  revealTx?: Hex;
  commitEnd: number;
  revealEnd: number;
  state: SealState;
  /** Revealed by Orrery's relay (opt-in): this page does not ask the wallet to reveal it. */
  relay?: boolean;
  /** The market had a listed remainder pool when this order was sealed. */
  pooled?: boolean;
  /** Last status the relay reported: queued, sent, revealed or failed. */
  relayStatus?: string;
  /** Set when a reveal request was closed in the wallet: automatic reveal waits for the person's click. */
  waitForClick?: boolean;
  outcome?: { status: FillStatus | "expired"; inputUsed: string; output: string; usdgFee: string; orryFee: string; price?: string; clearTx?: Hex };
  createdAt: number;
}

const KEY = "orrery.markets.orders.v1";
const EMPTY: SealedOrder[] = [];
let cache: SealedOrder[] | null = null;
const listeners = new Set<() => void>();

function read(): SealedOrder[] {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as SealedOrder[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: SealedOrder[]) {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the order stays in memory for this tab.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export const useSealedOrders = () => useSyncExternalStore(subscribe, read, () => EMPTY);

export const saveOrder = (o: SealedOrder) => write([o, ...read().filter((x) => x.id !== o.id)]);
export const updateOrder = (id: string, patch: Partial<SealedOrder>) => write(read().map((x) => (x.id === id ? { ...x, ...patch } : x)));
export const removeOrder = (id: string) => write(read().filter((x) => x.id !== id));
export const getOrder = (id: string) => read().find((x) => x.id === id);
