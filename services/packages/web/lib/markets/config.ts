import type { OrryFeature } from "../orry/config";

/** Wave R1 market pages (docs/ORRY-R1-SPEC.md section 5). Each opens with its release switch feature. */
export const MARKET_ROUTES: { feature: Extract<OrryFeature, "stocks" | "swap" | "darkpool">; href: string; label: string }[] = [
  { feature: "stocks", href: "/stocks", label: "Stocks" },
  { feature: "swap", href: "/eclipse", label: "Eclipse" },
  { feature: "darkpool", href: "/quiet-book", label: "Quiet Book" },
];


/** Price tolerance choices for Private Swap, in basis points around the stock's current price. */
export const SWAP_TOLERANCE_BPS = [50, 100, 200] as const;

/** Burn sources added by the markets (spec 2.4): 5 commit fee, 6 trading fee paid in ORRY. */
export const MARKET_BURN_SOURCES: Record<number, string> = {
  5: "Sealing fee on market orders",
  6: "ORRY paid as market trading fee",
};
