import type { OrryFeature } from "./orry/config";

/** The wallet dashboard: its own app, reached from the site nav and the wallet menu. Agent limits and credits live here only. */
export const DASHBOARD_HREF = "/dashboard";
export const AGENTS_HREF = `${DASHBOARD_HREF}/agents`;
export const CREDITS_HREF = `${DASHBOARD_HREF}/credits`;

export type ConsoleIcon = "overview" | "credits" | "agents" | "merchant" | "positions" | "orders";

/** One management section of the dashboard. A section with features reads "Soon" while none of them is open. */
export interface ConsoleSection {
  href: string;
  label: string;
  icon: ConsoleIcon;
  lead: string;
  features?: OrryFeature[];
  /** Needs the v1 contracts (module, attestor, lens) on this network. */
  core?: boolean;
}

export const CONSOLE_SECTIONS: ConsoleSection[] = [
  { href: DASHBOARD_HREF, label: "Overview", icon: "overview", lead: "Everything this wallet does on Orrery, in one view." },
  { href: `${DASHBOARD_HREF}/credits`, label: "Credits", icon: "credits", lead: "Credit balance, purchases and every check, plus buying more." },
  { href: `${DASHBOARD_HREF}/agents`, label: "Agents", icon: "agents", lead: "Set each agent's orbit: the caps and targets it pays within.", core: true },
  { href: `${DASHBOARD_HREF}/merchant`, label: "Merchant", icon: "merchant", lead: "The address where agents pay you over x402.", features: ["facilitator"] },
  { href: `${DASHBOARD_HREF}/positions`, label: "Positions", icon: "positions", lead: "Stake, Earn shares and whatever is claimable.", features: ["stake", "earn"] },
  { href: `${DASHBOARD_HREF}/orders`, label: "Orders", icon: "orders", lead: "Sealed orders across Stocks, Private Swap and Dark Pool.", features: ["stocks", "swap", "darkpool"] },
];

/** The section a path belongs to: the deepest match, the overview otherwise. */
export const sectionFor = (path: string): ConsoleSection =>
  [...CONSOLE_SECTIONS].reverse().find((s) => path === s.href || path.startsWith(`${s.href}/`)) ?? CONSOLE_SECTIONS[0]!;
