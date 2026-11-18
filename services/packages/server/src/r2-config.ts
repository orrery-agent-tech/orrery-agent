import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";

/**
 * Lane L3 settings (`docs/updates/L3-R2-SPEC.md` section 7). Null when none of the R2 contracts is configured, so a
 * stack without them runs exactly as before. Every value here is an address of a deployment or a safe default.
 */
export interface R2Config {
  /** `PredictionMarketFactory`; null turns the predict routes, indexing and keeper steps off. */
  predictFactory: Address | null;
  /** `LimitOrderBook`; null turns the limit order routes, indexing and keeper steps off. */
  limitBook: Address | null;
  /** `OrryPaymaster` per EntryPoint (comma list in `ORRERY_PAYMASTERS`). */
  paymasters: Address[];
  /** `OrreryShield` (USDG); null turns the shield routes and indexing off. */
  shield: Address | null;
  startBlock: bigint;
  /** Cache of chain reads behind the public routes. */
  cacheMs: number;
  /** Stored limit orders per owner (spam bound for the public POST route). */
  maxOpenOrdersPerOwner: number;
  /** POSTs of limit orders per minute per IP. */
  orderRatePerMinute: number;
}

function optAddr(env: NodeJS.ProcessEnv, name: string): Address | null {
  const v = env[name];
  if (!v) return null;
  if (!isAddress(v)) throw new Error(`${name} expects a 0x address`);
  return getAddress(v);
}

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function loadR2(env: NodeJS.ProcessEnv): R2Config | null {
  const predictFactory = optAddr(env, "ORRERY_PREDICT_FACTORY");
  const limitBook = optAddr(env, "ORRERY_LIMIT_BOOK");
  const paymasters = (env.ORRERY_PAYMASTERS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (!isAddress(p)) throw new Error("ORRERY_PAYMASTERS must be a comma list of 0x addresses");
      return getAddress(p);
    });
  const shield = optAddr(env, "ORRERY_SHIELD");
  if (!predictFactory && !limitBook && paymasters.length === 0 && !shield) return null;
  return {
    predictFactory,
    limitBook,
    paymasters,
    shield,
    startBlock: BigInt(env.ORRERY_R2_START_BLOCK ?? env.ORRERY_INDEXER_START_BLOCK ?? 0),
    cacheMs: int(env, "ORRERY_R2_CACHE_MS", 10_000, 0, 600_000),
    maxOpenOrdersPerOwner: int(env, "ORRERY_LIMIT_MAX_OPEN_PER_OWNER", 50, 1, 10_000),
    orderRatePerMinute: int(env, "ORRERY_LIMIT_ORDER_RATE_PER_MINUTE", 20, 1, 10_000),
  };
}

/** Anvil's tenth development key (index 9), used only on the local chain (31337); no other role uses it. */
const ANVIL_KEY_9 = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as const;

/**
 * R2 keeper gas key (`ORRERY_R2_KEEPER_KEY` or `ORRERY_R2_KEEPER_KEY_FILE`, a file under `~/.secrets/orrery/`, made
 * only on the owner's word). Its own role, so its nonces never race another keeper's. Read by the R2 keeper alone.
 */
export function loadR2KeeperKey(env: NodeJS.ProcessEnv = process.env): `0x${string}` {
  const chainId = Number(env.ORRERY_CHAIN_ID ?? 31337);
  const direct = env.ORRERY_R2_KEEPER_KEY;
  if (direct) return direct as `0x${string}`;
  const file = env.ORRERY_R2_KEEPER_KEY_FILE;
  if (file) {
    const raw = readFileSync(file, "utf8").trim();
    return (raw.startsWith("{") ? (JSON.parse(raw) as { privateKey: string }).privateKey : raw) as `0x${string}`;
  }
  if (chainId === 31337) return ANVIL_KEY_9;
  throw new Error(`ORRERY_R2_KEEPER_KEY or ORRERY_R2_KEEPER_KEY_FILE is required on chain ${chainId}`);
}
