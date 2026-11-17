import { loadCommunity, type CommunityConfig } from "./community-config.js";
import { readFileSync } from "node:fs";
import { loadR2, type R2Config } from "./r2-config.js";
import { loadLaunch, type LaunchConfig } from "./launch-config.js";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { MARKET_FEATURES, MAX_QUOTE_TTL_SECONDS, ORRY_FEATURES, defaultOrryFeatures, parseOrryFeatures, type OrryFeature } from "@orrery/shared";
import { loadDataConfig, type DataConfig } from "./data-config.js";
import { loadCreditConfig, type CreditConfig } from "./credit-config.js";

/** ORRY contracts and settings (`docs/ORRY-BUILD-SPEC.md` §5). Null when `ORRERY_ORRY_TOKEN` is not set. */
export interface OrryConfig {
  token: Address;
  hook: Address;
  /** `IEarnVaultFactory`: one Earn vault per hub, listed by the factory. */
  earnFactory: Address;
  /** USDG: the quote of the ORRY/USDG hub, and the unit of quote prices. */
  usdg: Address;
  staking: Address;
  router: Address;
  treasury: Address;
  buyback: Address;
  lens: Address;
  claimAll: Address | null;
  poolManager: Address;
  /** Uniswap v4 poolId of a native ETH / USDG pool on the same PoolManager: the fallback USD path (ETH hub times this
   * pool) while the ORRY/USDG hub has no price. Optional. */
  usdPoolId: Hex | null;
  startBlock: bigint;
  /** Quote lifetime, at most 120 seconds. */
  quoteTtlSeconds: number;
  /** USD value of one verification paid in ORRY, in USDG base units (default 4 USDG, R-9). */
  verificationUsd: bigint;
  maxPacksPerQuote: number;
  /** Most checks in one pay-as-you-go quote (R-44 item 13). */
  maxChecksPerQuote: number;
  quoteRatePerMinute: number;
  /** Pool price samples: one per this many seconds; quotes need at least `minSamples` in the 30 minute window. */
  sampleSeconds: number;
  minSamples: number;
  /** Pending rewards per account are re-read at most this often (leaderboard of earners). */
  snapshotSeconds: number;
  snapshotMaxAccounts: number;
  /** Cache of the public ORRY reads, so idle browser tabs cannot run up RPC calls. */
  cacheMs: number;
}

/** Check pricing (R-58). */
export interface Pricing {
  /** Free checks per address per UTC month, used before credits. */
  freeChecksPerMonth: number;
  /** Free checks per UTC day across all addresses; past it checks use credits until the next day. */
  freeChecksPerDay: number;
  /** Credits a check costs until `volumeChecks` checks in the month. */
  creditsPerCheck: number;
  /** Credits a check costs past `volumeChecks` in the month, and from the first check while a plan is active. */
  volumeCreditsPerCheck: number;
  volumeChecks: number;
  /** Platform plan: price in USDG base units, credits it includes, days it lasts. */
  planPrice: bigint;
  planCredits: number;
  planDays: number;
  /** Paid checks per minute per address, without and with a plan. */
  checksPerMinute: number;
  planChecksPerMinute: number;
}

/** Wave R1 markets (`docs/ORRY-R1-SPEC.md` section 5). Null when `ORRERY_MARKET_FACTORY` is not set. */
export interface MarketsConfig {
  factory: Address;
  startBlock: bigint;
  /** Multicall3 for the price list; null reads each feed on its own (local chains have none). */
  multicall: Address | null;
  /** Cache of the market reads (prices, lists). */
  cacheMs: number;
  /** Batches the keeper looks back over when it starts (each was within its expiry window). */
  keeperLookback: number;
}

/** Wave 3 public x402 facilitator (R-57, utilities 1, 4, 6, 11). Null when `ORRERY_SPLITTER_FACTORY` is not set. */
export interface FacilitatorConfig {
  /** `MerchantSplitterFactory`: settlements go only to its splitters (a merchant's `payTo`). */
  factory: Address;
  /** `X402Permit2Proxy` for tokens without EIP-3009 (ORRY); null turns that path off. */
  permit2Proxy: Address | null;
  permit2: Address;
  startBlock: bigint;
  /** Smallest settlement accepted, in the asset's base units of USDG (6 decimals); smaller payments cost more gas than the fee. */
  minAmountUsdg: bigint;
  /** A splitter is forwarded when it holds at least this much USDG, or after `forwardMaxAgeHours` with any balance. */
  forwardMinUsdg: bigint;
  forwardMaxAgeHours: number;
  /** Settlements per payee per minute. */
  ratePerMinute: number;
  /** `FeeTiers` (wave R1) for the stake value behind badges and the check quota; null: no badge, no quota. */
  feeTiers: Address | null;
  /** Utility 6: the stake value (USD, 6 decimals) a merchant needs for the verified badge and the directory. */
  badgeMinStakeUsd: bigint;
  /** Utility 1: extra included checks a month by stake value, as [min stake USD (6 decimals), checks] ascending. */
  quotaTiers: [bigint, number][];
}

export interface Config {
  chainId: number;
  rpcUrl: string;
  databaseUrl: string;
  port: number;
  publicUrl: string;
  addresses: { module: Address; attestor: Address; lens: Address; registry: Address; usdg: Address };
  usdgDomain: { name: string; version: string };
  treasury: Address;
  packPrice: bigint;
  /** Credits per pack (one credit is packPrice / packSize USDG). */
  packSize: number;
  pricing: Pricing;
  minValiditySeconds: number;
  confirmations: number;
  receiptTimeoutMs: number;
  relayerKey: Hex;
  checkSignerKey: Hex;
  attesterKey: Hex;
  ipfsGateway: string;
  probeAllowPrivate: boolean;
  /** Peers allowed to set X-Forwarded-For (Fastify `trustProxy`), or false. */
  trustProxy: string | false;
  probeFreshSeconds: number;
  publicRatePerMinute: number;
  corsOrigins: string[];
  orry: OrryConfig | null;
  /** Release switch `ORRERY_ORRY_FEATURES`; held features answer 404. */
  orryFeatures: Set<OrryFeature>;
  /** Seeds an empty `releases` table (the runtime switch decides per request after that). */
  releaseSeed: { chainId: number; explicit: Set<string> | undefined };
  /** How long the API keeps the release rows before reading them again. */
  releasesCacheMs: number;
  /** Signs ORRY quotes; set only when checkout is open. Never the check signer or the relayer. */
  quoteSignerKey: Hex | null;
  markets: MarketsConfig | null;
  facilitator: FacilitatorConfig | null;
  /** Lane L1 Community (`community-config.ts`); null when `ORRERY_COMMUNITY_POOL` is not set. */
  community: CommunityConfig | null;
  /** Lane L2 Orrery Data (`data-config.ts`); null without a data-signer key. */
  data: DataConfig | null;
  /** Lane L3: wave R2 markets and the ORRY paymaster (r2-config.ts). */
  r2: R2Config | null;
  /** Lane L4: third-party attesters and Orrery Credit (credit-config.ts); null when neither is configured. */
  credit: CreditConfig | null;
  /** Lane L5: Agent Launch (launch-config.ts); null when `ORRERY_AGENT_LAUNCH` is not set. */
  launch: LaunchConfig | null;
}

/** Anvil's well-known development keys, used only when the chain is the local one (31337). */
const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
];

/** Uniswap v4 PoolManager on 4663 (verified, build spec §2). */
const POOL_MANAGER_4663: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

function key(env: NodeJS.ProcessEnv, name: string, chainId: number, devIndex: number): Hex {
  const k = optionalKey(env, name, chainId, devIndex);
  if (!k) throw new Error(`${name} or ${name}_FILE is required on chain ${chainId}`);
  return k;
}

function optionalKey(env: NodeJS.ProcessEnv, name: string, chainId: number, devIndex: number): Hex | null {
  const direct = env[name];
  if (direct) return direct as Hex;
  const file = env[`${name}_FILE`];
  if (file) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw.startsWith("{")) return (JSON.parse(raw) as { privateKey: Hex }).privateKey;
    return raw as Hex;
  }
  if (chainId === 31337) return ANVIL_KEYS[devIndex]!;
  return null;
}

/** Keeper gas key (`ORRERY_KEEPER_KEY[_FILE]`); anvil key 6 on 31337 only. Read by the keeper process alone. */
export function loadKeeperKey(env: NodeJS.ProcessEnv = process.env): Hex {
  const chainId = Number(env.ORRERY_CHAIN_ID ?? 31337);
  return key(env, "ORRERY_KEEPER_KEY", chainId, 6);
}

/** Market keeper gas key (`ORRERY_MARKET_KEEPER_KEY[_FILE]`), its own role so its nonces never race the ORRY
 * keeper's; anvil key 7 on 31337 only. Read by the market keeper process alone. */
export function loadMarketKeeperKey(env: NodeJS.ProcessEnv = process.env): Hex {
  const chainId = Number(env.ORRERY_CHAIN_ID ?? 31337);
  return key(env, "ORRERY_MARKET_KEEPER_KEY", chainId, 7);
}

/** Reveal relay gas key (`ORRERY_RELAY_KEY[_FILE]`): sends `revealFor` for traders who opted in. Its own role, not the
 * x402 settlement relayer (`ORRERY_RELAYER_KEY`); anvil key 8 on 31337 only. Read by the relay process alone. */
export function loadRelayKey(env: NodeJS.ProcessEnv = process.env): Hex {
  const chainId = Number(env.ORRERY_CHAIN_ID ?? 31337);
  return key(env, "ORRERY_RELAY_KEY", chainId, 8);
}

/** Multicall3, the same address on every EVM chain; deployed on 4663. */
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

function loadMarkets(env: NodeJS.ProcessEnv, chainId: number): MarketsConfig | null {
  const factory = optAddr(env, "ORRERY_MARKET_FACTORY");
  if (!factory) return null;
  const multicall = env.ORRERY_MULTICALL3 === "off" ? null : optAddr(env, "ORRERY_MULTICALL3") ?? (chainId === 4663 ? MULTICALL3 : null);
  return {
    factory,
    startBlock: BigInt(env.ORRERY_MARKETS_START_BLOCK ?? env.ORRERY_INDEXER_START_BLOCK ?? 0),
    multicall,
    cacheMs: int(env, "ORRERY_MARKETS_CACHE_MS", 10_000, 0, 600_000),
    keeperLookback: int(env, "ORRERY_MARKET_KEEPER_LOOKBACK", 12, 1, 1_000),
  };
}

const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

function loadFacilitator(env: NodeJS.ProcessEnv): FacilitatorConfig | null {
  const factory = optAddr(env, "ORRERY_SPLITTER_FACTORY");
  if (!factory) return null;
  const quota = (env.ORRERY_STAKE_QUOTA ?? "100000000:10000,1000000000:100000")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [usd, checks] = p.split(":");
      if (!/^\d+$/.test(usd ?? "") || !/^\d+$/.test(checks ?? "")) throw new Error("ORRERY_STAKE_QUOTA: use <min stake USD in 6 decimals>:<checks>,...");
      return [BigInt(usd!), Number(checks)] as [bigint, number];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    factory,
    permit2Proxy: optAddr(env, "ORRERY_X402_PERMIT2_PROXY"),
    permit2: optAddr(env, "ORRERY_PERMIT2") ?? PERMIT2,
    startBlock: BigInt(env.ORRERY_FACILITATOR_START_BLOCK ?? env.ORRERY_INDEXER_START_BLOCK ?? 0),
    minAmountUsdg: BigInt(env.ORRERY_FACILITATOR_MIN_AMOUNT ?? "10000"),
    forwardMinUsdg: BigInt(env.ORRERY_FORWARD_MIN ?? "10000000"),
    forwardMaxAgeHours: int(env, "ORRERY_FORWARD_MAX_AGE_HOURS", 24, 1, 24 * 30),
    ratePerMinute: int(env, "ORRERY_FACILITATOR_RATE_PER_MINUTE", 60, 1, 10_000),
    feeTiers: optAddr(env, "ORRERY_FEE_TIERS"),
    badgeMinStakeUsd: BigInt(env.ORRERY_MERCHANT_BADGE_USD ?? "100000000"),
    quotaTiers: quota,
  };
}

function optAddr(env: NodeJS.ProcessEnv, name: string): Address | null {
  const v = env[name];
  if (!v) return null;
  if (!isAddress(v)) throw new Error(`${name} expects a 0x address`);
  return v as Address;
}

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name];
  const v = raw === undefined || raw === "" ? dflt : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return v;
}

function loadOrry(env: NodeJS.ProcessEnv, chainId: number): OrryConfig | null {
  const token = optAddr(env, "ORRERY_ORRY_TOKEN");
  if (!token) return null;
  const need = (name: string, fallback?: string): Address => {
    const v = optAddr(env, name) ?? (fallback ? optAddr(env, fallback) : null);
    if (!v) throw new Error(`${name} is required when ORRERY_ORRY_TOKEN is set`);
    return v;
  };
  const usdPoolId = env.ORRERY_ORRY_USD_POOL_ID || null;
  if (usdPoolId && !(isHex(usdPoolId) && usdPoolId.length === 66)) throw new Error("ORRERY_ORRY_USD_POOL_ID must be a 32 byte 0x poolId");
  const poolManager = optAddr(env, "ORRERY_POOL_MANAGER") ?? (chainId === 4663 ? POOL_MANAGER_4663 : null);
  if (!poolManager) throw new Error("ORRERY_POOL_MANAGER is required on this chain");
  return {
    token,
    hook: need("ORRERY_ORRY_HOOK"),
    earnFactory: need("ORRERY_ORRY_EARN_FACTORY"),
    usdg: need("ORRERY_USDG"),
    staking: need("ORRERY_ORRY_STAKING"),
    router: need("ORRERY_ORRY_ROUTER"),
    treasury: need("ORRERY_ORRY_TREASURY", "ORRERY_TREASURY"),
    buyback: need("ORRERY_ORRY_BUYBACK"),
    lens: need("ORRERY_ORRY_LENS"),
    claimAll: optAddr(env, "ORRERY_ORRY_CLAIM_ALL"),
    poolManager,
    usdPoolId: usdPoolId as Hex | null,
    startBlock: BigInt(env.ORRERY_ORRY_START_BLOCK ?? env.ORRERY_INDEXER_START_BLOCK ?? 0),
    quoteTtlSeconds: int(env, "ORRERY_QUOTE_TTL_SECONDS", MAX_QUOTE_TTL_SECONDS, 30, MAX_QUOTE_TTL_SECONDS),
    verificationUsd: BigInt(env.ORRERY_ORRY_VERIFICATION_USD ?? "4000000"),
    maxPacksPerQuote: int(env, "ORRERY_ORRY_MAX_PACKS", 100, 1, 10_000),
    maxChecksPerQuote: int(env, "ORRERY_ORRY_MAX_CHECKS", 1_000, 1, 1_000_000),
    quoteRatePerMinute: int(env, "ORRERY_QUOTE_RATE_PER_MINUTE", 10, 1, 600),
    sampleSeconds: int(env, "ORRERY_ORRY_SAMPLE_SECONDS", 60, 5, 600),
    minSamples: int(env, "ORRERY_ORRY_MIN_SAMPLES", 10, 1, 360),
    snapshotSeconds: int(env, "ORRERY_ORRY_SNAPSHOT_SECONDS", 600, 10, 86_400),
    snapshotMaxAccounts: int(env, "ORRERY_ORRY_SNAPSHOT_MAX", 500, 1, 100_000),
    cacheMs: int(env, "ORRERY_ORRY_CACHE_MS", 10_000, 0, 600_000),
  };
}

function addr(env: NodeJS.ProcessEnv, name: string): Address {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v as Address;
}

/**
 * Which peers may name the visitor in X-Forwarded-For. The default trusts loopback and private ranges only: behind Caddy
 * (on the host or in a Docker network) the API reads the visitor's address, and a visitor reaching the port directly
 * from a public address cannot forge one. "off" turns forwarding headers off entirely.
 */
function trustProxyFrom(value: string | undefined): string | false {
  const v = value?.trim();
  if (!v) return "loopback,linklocal,uniquelocal";
  return v === "off" || v === "0" || v === "false" ? false : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const chainId = Number(env.ORRERY_CHAIN_ID ?? 31337);
  const orry = loadOrry(env, chainId);
  const markets = loadMarkets(env, chainId);
  const facilitator = loadFacilitator(env);
  const explicit = parseOrryFeatures(env.ORRERY_ORRY_FEATURES);
  const isMarket = (f: OrryFeature) => (MARKET_FEATURES as readonly string[]).includes(f);
  const routeFeatures = explicit ? new Set([...explicit].filter((f): f is OrryFeature => (ORRY_FEATURES as readonly string[]).includes(f))) : undefined;
  if (routeFeatures && [...routeFeatures].some((f) => !isMarket(f)) && !orry) throw new Error("ORRERY_ORRY_FEATURES needs the ORRY contract addresses (ORRERY_ORRY_TOKEN and the rest)");
  if (routeFeatures && [...routeFeatures].some(isMarket) && !markets) throw new Error("The stocks, swap and darkpool features need ORRERY_MARKET_FACTORY");
  // the seed's route features, what opens at the first start of an empty releases table: each group only with its
  // contracts configured (ORRY features with the ORRY addresses, markets with the factory)
  const orryFeatures = new Set<OrryFeature>([...(routeFeatures ?? defaultOrryFeatures(chainId))].filter((f) => (isMarket(f) ? !!markets : !!orry)));
  // A quote key given is always loaded, so checkout can open later at runtime; it is required when the seed opens checkout.
  let quoteSignerKey: Hex | null = orry ? optionalKey(env, "ORRERY_QUOTE_SIGNER_KEY", chainId, 5) : null;
  if (orryFeatures.has("checkout")) {
    // ORRY in USD comes from the ORRY/USDG hub (a launch pair, R-35); ORRERY_ORRY_USD_POOL_ID is the ETH path's fallback
    quoteSignerKey = key(env, "ORRERY_QUOTE_SIGNER_KEY", chainId, 5);
  }
  const cfg: Config = {
    chainId,
    rpcUrl: env.ORRERY_RPC_URL ?? "http://127.0.0.1:8545",
    databaseUrl: env.ORRERY_DATABASE_URL ?? "postgres://orrery:orrery@127.0.0.1:55432/orrery",
    port: Number(env.ORRERY_PORT ?? 8787),
    publicUrl: env.ORRERY_PUBLIC_URL ?? "http://127.0.0.1:8787",
    addresses: {
      module: addr(env, "ORRERY_MODULE"),
      attestor: addr(env, "ORRERY_ATTESTOR"),
      lens: addr(env, "ORRERY_LENS"),
      registry: addr(env, "ORRERY_REGISTRY"),
      usdg: addr(env, "ORRERY_USDG"),
    },
    usdgDomain: { name: env.ORRERY_USDG_NAME ?? "Global Dollar", version: env.ORRERY_USDG_VERSION ?? "1" },
    treasury: addr(env, "ORRERY_TREASURY"),
    packPrice: BigInt(env.ORRERY_PACK_PRICE ?? "1000000"),
    packSize: Number(env.ORRERY_PACK_SIZE ?? 500),
    pricing: {
      freeChecksPerMonth: int(env, "ORRERY_FREE_CHECKS_PER_MONTH", 1_000, 0, 1_000_000),
      freeChecksPerDay: int(env, "ORRERY_FREE_CHECKS_PER_DAY", 250_000, 0, 100_000_000),
      creditsPerCheck: int(env, "ORRERY_CREDITS_PER_CHECK", 2, 1, 1_000),
      volumeCreditsPerCheck: int(env, "ORRERY_VOLUME_CREDITS_PER_CHECK", 1, 1, 1_000),
      volumeChecks: int(env, "ORRERY_VOLUME_CHECKS", 100_000, 0, 1_000_000_000),
      planPrice: BigInt(env.ORRERY_PLAN_PRICE ?? "99000000"),
      planCredits: int(env, "ORRERY_PLAN_CREDITS", 49_500, 0, 1_000_000_000),
      planDays: int(env, "ORRERY_PLAN_DAYS", 30, 1, 366),
      checksPerMinute: int(env, "ORRERY_CHECKS_PER_MINUTE", 120, 1, 100_000),
      planChecksPerMinute: int(env, "ORRERY_PLAN_CHECKS_PER_MINUTE", 1_200, 1, 100_000),
    },
    minValiditySeconds: Number(env.ORRERY_MIN_VALIDITY_SECONDS ?? 120),
    confirmations: Number(env.ORRERY_CONFIRMATIONS ?? 10),
    receiptTimeoutMs: Number(env.ORRERY_RECEIPT_TIMEOUT_MS ?? 30_000),
    relayerKey: key(env, "ORRERY_RELAYER_KEY", chainId, 0),
    checkSignerKey: key(env, "ORRERY_CHECK_SIGNER_KEY", chainId, 1),
    attesterKey: key(env, "ORRERY_ATTESTER_KEY", chainId, 2),
    ipfsGateway: env.ORRERY_IPFS_GATEWAY ?? "https://ipfs.io/ipfs/",
    probeAllowPrivate: env.ORRERY_PROBE_ALLOW_PRIVATE === "1" && chainId === 31337,
    trustProxy: trustProxyFrom(env.ORRERY_TRUST_PROXY),
    probeFreshSeconds: Number(env.ORRERY_PROBE_FRESH_SECONDS ?? 600),
    publicRatePerMinute: Number(env.ORRERY_PUBLIC_RATE_PER_MINUTE ?? 60),
    corsOrigins: (env.ORRERY_CORS_ORIGINS ?? "http://localhost:3100,http://127.0.0.1:3100").split(",").map((o) => o.trim()).filter(Boolean),
    orry,
    orryFeatures,
    releaseSeed: { chainId, explicit: explicit as Set<string> | undefined },
    releasesCacheMs: int(env, "ORRERY_RELEASES_CACHE_MS", 2_000, 0, 60_000),
    quoteSignerKey,
    markets,
    facilitator,
    community: loadCommunity(env, chainId),
    data: null,
    r2: loadR2(env),
    credit: loadCreditConfig(env),
    launch: loadLaunch(env),
  };
  const p = cfg.pricing;
  if (p.volumeCreditsPerCheck > p.creditsPerCheck) throw new Error("ORRERY_VOLUME_CREDITS_PER_CHECK must not exceed ORRERY_CREDITS_PER_CHECK");
  // The facilitator tells a pack from a plan by the amount paid.
  if (cfg.packPrice <= 0n || p.planPrice <= 0n || p.planPrice === cfg.packPrice) throw new Error("ORRERY_PLAN_PRICE and ORRERY_PACK_PRICE must be positive and differ");
  // One key per role (R-L7): a leaked quote signer must not also sign checks, attestations or settlements.
  if (quoteSignerKey && [cfg.checkSignerKey, cfg.relayerKey, cfg.attesterKey].some((k) => k.toLowerCase() === quoteSignerKey.toLowerCase())) {
    throw new Error("ORRERY_QUOTE_SIGNER_KEY must be its own key, not the check signer, relayer or attester key");
  }
  // Lane L2: Orrery Data, with its own signer key (R-52)
  cfg.data = loadDataConfig(env, chainId, [cfg.checkSignerKey, cfg.relayerKey, cfg.attesterKey, quoteSignerKey], facilitator?.feeTiers ?? null);
  return cfg;
}
