"use client";

import type { ShieldEventsResponse } from "@orrery/shared";
import { API_URL } from "../../config";
import type { TransactProver } from "./prover";
import { eventFromJson, type PoolEvent } from "./wallet";

let loading: Promise<TransactProver> | null = null;

/** Loads the circuit and the WebAssembly prover once, on first use (MIT). Proving runs
 * on one thread unless the page is cross-origin isolated. */
export function getProver(): Promise<TransactProver> {
  if (!loading) {
    loading = (async () => {
      const [{ TransactProver }, circuit] = await Promise.all([import("./prover"), import("./transact.json")]);
      const threads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? navigator.hardwareConcurrency : 1;
      return TransactProver.create(circuit.default as never, threads);
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Every shield event from the API, in chain order (never held by the release switch). */
export async function loadShieldEvents(): Promise<PoolEvent[]> {
  if (!API_URL) throw new Error("This build has no Orrery API address set.");
  const out: PoolEvent[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const r = await fetch(`${API_URL}/v1/r2/shield/events${after ? `?after=${encodeURIComponent(after)}` : ""}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`Could not load the shield notes (status ${r.status}).`);
    const body = (await r.json()) as ShieldEventsResponse;
    out.push(...body.events.map((e) => eventFromJson(e as Record<string, unknown>)));
    after = body.cursor;
    if (body.done) break;
  }
  return out;
}
