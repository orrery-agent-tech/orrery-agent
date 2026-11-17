import type { Address } from "viem";
import { CHAIN_ID } from "../config";

/**
 * ORRY features and addresses (docs/ORRY-BUILD-SPEC.md section 6). Which features are open is decided at runtime by
 * `GET /v1/releases` (lib/orry/releases.tsx); opening a wave needs no rebuild. `NEXT_PUBLIC_ORRY_FEATURES` (a comma
 * list of the names below) is only the fallback while that API cannot be reached, and unset means everything held.
 * A held feature renders "Coming soon".
 */
export const ORRY_FEATURES = ["earn", "stake", "agent-stake", "claim", "burn", "leaderboard", "checkout", "payg-checks", "stocks", "swap", "darkpool", "facilitator", "merchant-badge", "data", "data-providers", "mcp", "predict", "limit-orders", "paymaster", "shield", "attesters", "credit", "credit-bond", "launch", "launch-priority"] as const;
export type OrryFeature = (typeof ORRY_FEATURES)[number];

/** Build-time fallback list, read only while the releases API is unreachable. */
export const FEATURES_FALLBACK = process.env.NEXT_PUBLIC_ORRY_FEATURES;

/** The same two words everywhere a held feature is named. */
export const COMING_SOON = "Coming soon";
/** Its short form beside a held section in the compact menus (site nav and dashboard sidebar). */
export const SOON_TAG = "Soon";

const env = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);

/** Real deployment addresses, no defaults. A feature whose contracts are not configured shows "Coming soon" too. */
export const ORRY = {
  token: env(process.env.NEXT_PUBLIC_ORRY_TOKEN),
  /** Multi-pair Earn: the factory lists one vault per ORRY/X hub (ETH, USDG, ...). */
  earnFactory: env(process.env.NEXT_PUBLIC_ORRY_EARN_FACTORY),
  staking: env(process.env.NEXT_PUBLIC_ORRY_STAKING),
  claimAll: env(process.env.NEXT_PUBLIC_ORRY_CLAIM_ALL),
  router: env(process.env.NEXT_PUBLIC_ORRY_REWARDS_ROUTER),
  treasury: env(process.env.NEXT_PUBLIC_ORRY_TREASURY),
  /** Wave R1: every market (one per stock token) and its fee tiers and ORRY price are read from the factory. */
  marketFactory: env(process.env.NEXT_PUBLIC_MARKET_FACTORY),
  /** Wave 3: one payment address (splitter) per merchant, created by this factory. */
  splitterFactory: env(process.env.NEXT_PUBLIC_SPLITTER_FACTORY),
  /** Lane L2: the open listing of third-party data providers (DataProviderRegistry). */
  dataRegistry: env(process.env.NEXT_PUBLIC_DATA_REGISTRY),
  /** Lane L3 (wave R2): prediction markets, the limit order book, the ORRY paymaster, Shield. */
  predictFactory: env(process.env.NEXT_PUBLIC_PREDICT_FACTORY),
  limitBook: env(process.env.NEXT_PUBLIC_LIMIT_BOOK),
  paymaster: env(process.env.NEXT_PUBLIC_PAYMASTER),
  shield: env(process.env.NEXT_PUBLIC_SHIELD),
  /** Lane L4: third-party attesters (AttesterRegistry and its fee splitter) and Orrery Credit (CreditPoolFactory). */
  attesterRegistry: env(process.env.NEXT_PUBLIC_ATTESTER_REGISTRY),
  attesterSplitter: env(process.env.NEXT_PUBLIC_ATTESTER_SPLITTER),
  creditFactory: env(process.env.NEXT_PUBLIC_CREDIT_FACTORY),
  /** Lane L5: Agent Launch and its router for the coin pages. */
  agentLaunch: env(process.env.NEXT_PUBLIC_AGENT_LAUNCH),
  spokeRouter: env(process.env.NEXT_PUBLIC_SPOKE_ROUTER),
};

/** Contracts each feature needs before it can open. Burn and leaderboard read the API only. */
const NEEDS: Record<OrryFeature, (keyof typeof ORRY)[]> = {
  earn: ["token", "earnFactory"],
  stake: ["token", "staking"],
  "agent-stake": ["token", "staking"],
  claim: ["earnFactory", "staking", "claimAll", "router", "token"],
  burn: [],
  leaderboard: [],
  checkout: ["token", "treasury"],
  "payg-checks": ["token", "treasury"],
  stocks: ["marketFactory"],
  swap: ["marketFactory"],
  darkpool: ["marketFactory"],
  facilitator: ["splitterFactory"],
  "merchant-badge": ["splitterFactory"],
  // lane L2: official data reads the API only; providers list through the registry
  data: [],
  "data-providers": ["dataRegistry"],
  mcp: [],
  predict: ["predictFactory"],
  "limit-orders": ["limitBook", "marketFactory"],
  paymaster: ["paymaster", "token"],
  shield: ["shield"],
  // lane L4
  attesters: ["attesterRegistry", "attesterSplitter", "token"],
  credit: ["creditFactory"],
  "credit-bond": ["creditFactory", "token"],
  launch: ["token", "agentLaunch", "spokeRouter", "staking"],
  "launch-priority": ["agentLaunch", "staking"],
};

/** The feature's contracts are configured in this build (a release time alone cannot open a feature without them). */
export const contractsReady = (f: OrryFeature) => NEEDS[f].every((k) => Boolean(ORRY[k]));

/** Explorer for transaction links; Blockscout on 4663, configurable elsewhere. */
export const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL || (CHAIN_ID === 4663 ? "https://robinhoodchain.blockscout.com" : undefined);

export const ORRY_ROUTES: { feature: OrryFeature; href: string; label: string }[] = [
  { feature: "earn", href: "/earn", label: "Earn" },
  { feature: "stake", href: "/stake", label: "Stake" },
  { feature: "claim", href: "/claim", label: "Claim" },
  { feature: "leaderboard", href: "/leaderboard", label: "Leaderboard" },
  { feature: "burn", href: "/burn", label: "Burn" },
];

