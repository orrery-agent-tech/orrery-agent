"use client";

import { ORRY } from "@/lib/orry/config";
import { ShieldView } from "./ShieldView";

/** Open Shield: the full desk. */
export function ShieldPage() {
  return <ShieldView />;
}

/** Held Shield: a private balance stays withdrawable whatever the release switch says (only once the pool exists). */
export function ShieldExits() {
  return ORRY.shield ? <ShieldView exitOnly /> : null;
}
