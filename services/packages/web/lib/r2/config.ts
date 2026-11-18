import type { OrryFeature } from "../orry/config";

/** Lane L3 pages (docs/updates/L3-R2-SPEC.md section 7). Each opens with its release switch feature. */
export const R2_ROUTES: { feature: Extract<OrryFeature, "predict" | "limit-orders" | "shield" | "paymaster">; href: string; label: string }[] = [
  { feature: "predict", href: "/predict", label: "Predict" },
  { feature: "limit-orders", href: "/limit-orders", label: "Limit orders" },
  { feature: "shield", href: "/shield", label: "Shield" },
  { feature: "paymaster", href: "/gas", label: "Gas in ORRY" },
];

/** Burn sources added by lane L3, for the burn page. */
export const R2_BURN_SOURCES: Record<number, string> = {
  30: "New prediction markets",
  31: "ORRY paid as prediction fees",
  32: "ORRY paid as limit order fees",
  33: "ORRY paid as the gas premium",
};

/** Tip choices for the keeper that fills a limit order, in basis points of the order's USDG value. */
export const LIMIT_TIPS_BPS = [0, 10, 25, 50] as const;
/** Expiry choices for a limit order, in days (the API accepts at most 30). */
export const LIMIT_EXPIRY_DAYS = [1, 7, 30] as const;
