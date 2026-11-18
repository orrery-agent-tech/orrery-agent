import { isAddress, type Address, type Hex } from "viem";

/**
 * Lane L1 Community configuration (`docs/updates/L1-COMMUNITY-SPEC.md`). Null when `ORRERY_COMMUNITY_POOL` is not set:
 * the community routes then answer 404 and the community indexer does nothing. Contract addresses are real deployment
 * addresses with no default. The reward rates are services values (spec L1-14); the contracts bound them on chain.
 */
export interface CommunityConfig {
  pool: Address;
  achievements: Address | null;
  chat: Address | null;
  names: Address | null;
  boost: Address | null;
  passes: Address | null;
  templates: Address | null;
  referrals: Address | null;
  cashback: Address | null;
  /** R1 `OrryPriceOracle` (ORRY in USD at the hub TWAP); null hides live ORRY quotes. */
  priceOracle: Address | null;
  /** ORRY token and `OrryStaking`; default to the ORRY block's addresses when that block is configured. */
  orry: Address | null;
  staking: Address | null;
  startBlock: bigint;
  /** Utility 7: cashback as a share of each USDG fee (guess 200 = 2%). On chain at most `MAX_CASHBACK_BPS`. */
  cashbackBps: number;
  /** R-53: referrer share of each fee the referee pays (2000 = 20%), for `referralDays` after the link. */
  referralBps: number;
  referralDays: number;
  /** R-54: the referee's fee discount (1000 = 10%) for `referralDays`. */
  refereeDiscountBps: number;
  /** R-56: merchant referrals weigh twice; a referrer with `stakerMinUsd` of earning stake gets 12500 / 10000. */
  merchantWeightBps: number;
  stakerWeightBps: number;
  stakerMinUsd: bigint;
  /** R-55: referral USD per referrer per calendar month. */
  monthlyCapUsd: bigint;
  /** Referral tiers by referred volume over the referral window (plan guess). */
  tiersUsd: bigint[];
  /** Publishes accruals to `CashbackRewards` (its `publisher`). Null: the publisher job only prints what it would send. */
  publisherKey: Hex | null;
}

const ANVIL_PUBLISHER: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil account 7, 31337 only

function optAddr(env: NodeJS.ProcessEnv, name: string): Address | null {
  const v = env[name];
  if (!v) return null;
  if (!isAddress(v)) throw new Error(`${name} expects a 0x address`);
  return v as Address;
}

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function loadCommunity(env: NodeJS.ProcessEnv, chainId: number): CommunityConfig | null {
  const pool = optAddr(env, "ORRERY_COMMUNITY_POOL");
  if (!pool) return null;
  const rawKey = env.ORRERY_COMMUNITY_PUBLISHER_KEY;
  if (rawKey && !/^0x[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error("ORRERY_COMMUNITY_PUBLISHER_KEY must be a 32 byte hex key");
  const tiers = (env.ORRERY_REFERRAL_TIERS_USD ?? "1000000000,10000000000,50000000000").split(",").map((t) => {
    if (!/^\d+$/.test(t.trim())) throw new Error("ORRERY_REFERRAL_TIERS_USD: comma list of USD amounts in 6 decimals");
    return BigInt(t.trim());
  });
  return {
    pool,
    achievements: optAddr(env, "ORRERY_COMMUNITY_ACHIEVEMENTS"),
    chat: optAddr(env, "ORRERY_COMMUNITY_CHAT"),
    names: optAddr(env, "ORRERY_COMMUNITY_NAMES"),
    boost: optAddr(env, "ORRERY_COMMUNITY_BOOST"),
    passes: optAddr(env, "ORRERY_COMMUNITY_PASSES"),
    templates: optAddr(env, "ORRERY_COMMUNITY_TEMPLATES"),
    referrals: optAddr(env, "ORRERY_COMMUNITY_REFERRALS"),
    cashback: optAddr(env, "ORRERY_COMMUNITY_CASHBACK"),
    priceOracle: optAddr(env, "ORRERY_ORRY_PRICE_ORACLE"),
    orry: optAddr(env, "ORRERY_COMMUNITY_ORRY"),
    staking: optAddr(env, "ORRERY_COMMUNITY_STAKING"),
    startBlock: BigInt(env.ORRERY_COMMUNITY_START_BLOCK ?? env.ORRERY_INDEXER_START_BLOCK ?? 0),
    cashbackBps: int(env, "ORRERY_CASHBACK_BPS", 200, 0, 1000),
    referralBps: int(env, "ORRERY_REFERRAL_BPS", 2000, 0, 5000),
    referralDays: int(env, "ORRERY_REFERRAL_DAYS", 90, 1, 365),
    refereeDiscountBps: int(env, "ORRERY_REFEREE_DISCOUNT_BPS", 1000, 0, 5000),
    merchantWeightBps: int(env, "ORRERY_REFERRAL_MERCHANT_WEIGHT_BPS", 20_000, 10_000, 40_000),
    stakerWeightBps: int(env, "ORRERY_REFERRAL_STAKER_WEIGHT_BPS", 12_500, 10_000, 40_000),
    stakerMinUsd: BigInt(env.ORRERY_REFERRAL_STAKER_MIN_USD ?? "1000000000"),
    monthlyCapUsd: BigInt(env.ORRERY_REFERRAL_MONTHLY_CAP_USD ?? "1000000000"),
    tiersUsd: tiers.sort((a, b) => (a < b ? -1 : 1)),
    publisherKey: (rawKey as Hex | undefined) ?? (chainId === 31337 ? ANVIL_PUBLISHER : null),
  };
}
