import { readFileSync } from "node:fs";
import { isAddress, isHex, toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

/**
 * Lane L2 configuration (Orrery Data, `docs/updates/L2-DATA-MCP-SPEC.md`). Null when no data-signer key is available:
 * `ORRERY_DATA_SIGNER_KEY[_FILE]`, or on the local chain 31337 the anvil mnemonic's index 11.
 */
export interface DataStock {
  symbol: string;
  token: Address;
  feed: Address;
  /** A Uniswap v4 stock/USDG pool for dataset 4; null serves the stock without a liquidity record (D-13). */
  poolId: Hex | null;
}

export interface DataConfig {
  /** Signs every data response (R-52); never the check signer, relayer, attester or quote signer. */
  signerKey: Hex;
  /** `DataFeeSplitter`: payee of ORRY packs; null turns ORRY payment off. */
  splitter: Address | null;
  /** `X402Permit2Proxy` and Permit2 for ORRY packs (the wave 3 contracts); no proxy turns ORRY payment off. */
  permit2Proxy: Address | null;
  permit2: Address;
  /** `DataProviderRegistry` and its 1% `MerchantSplitterFactory`; null turns third-party providers off. */
  registry: Address | null;
  providerFactory: Address | null;
  /** USD per call and calls per pack (USDG base units, 6 decimals). */
  callUsd: bigint;
  packCalls: number;
  /** ORRY pays this much less (basis points, R-60). */
  orryDiscountBps: number;
  /** Stake discount (FeeTiers) paid as extra calls, capped here (D-5). */
  maxStakeDiscountBps: number;
  /** FeeTiers for the stake discount; null: no discount. Falls back to the facilitator's. */
  feeTiers: Address | null;
  quoteTtlSeconds: number;
  startBlock: bigint;
  stocks: DataStock[];
  /** The stock issuer registry (blocks and pauses for every stock token); null: no issuer events. */
  issuerRegistry: Address | null;
  /** Pons V2 factory for dataset 5; null: no Pons events. */
  ponsFactory: Address | null;
  /** A feed whose round is older than this is `stale` (24 h heartbeat plus 1 h). */
  feedStaleSeconds: number;
  /** Uniswap v4 PoolManager for dataset 4. */
  poolManager: Address | null;
  /** Keeper: split when the splitter holds this much fresh ORRY, or any amount after `maxAgeHours`. */
  splitMinOrry: bigint;
  forwardMinUsdg: bigint;
  maxAgeHours: number;
  /** Cache of the public reads (catalogue, providers, chain health), so idle browser tabs cannot run up RPC calls. */
  cacheMs: number;
  /** Largest page a dataset returns. */
  maxLimit: number;
}

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/** Robinhood Chain 4663 references (verified 2026-11-11, `docs/updates/L2-DATA-MCP-SPEC.md` 0). */
const STOCKS_4663 = "TSLA:0x322F0929c4625eD5bAd873c95208D54E1c003b2d:0x4A1166a659A55625345e9515b32adECea5547C38,AAPL:0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9:0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,SPY:0x117cc2133c37B721F49dE2A7a74833232B3B4C0C:0x319724394D3A0e3669269846abE664Cd621f9f6A";
const ISSUER_REGISTRY_4663: Address = "0xe10b6f6B275de231345c20D14Ab812db62151b00";
const PONS_FACTORY_4663: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const POOL_MANAGER_4663: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

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

function big(env: NodeJS.ProcessEnv, name: string, dflt: string): bigint {
  const raw = env[name] || dflt;
  if (!/^\d{1,40}$/.test(raw)) throw new Error(`${name} must be a whole number of base units`);
  return BigInt(raw);
}

function signerKey(env: NodeJS.ProcessEnv, chainId: number): Hex | null {
  if (env.ORRERY_DATA_SIGNER_KEY) return env.ORRERY_DATA_SIGNER_KEY as Hex;
  const file = env.ORRERY_DATA_SIGNER_KEY_FILE;
  if (file) {
    const raw = readFileSync(file, "utf8").trim();
    return (raw.startsWith("{") ? (JSON.parse(raw) as { privateKey: Hex }).privateKey : raw) as Hex;
  }
  if (chainId === 31337) return toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 11 }).getHdKey().privateKey!);
  return null;
}

export function parseStocks(raw: string): DataStock[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [symbol, token, feed, poolId] = p.split(":");
      if (!symbol || !/^[A-Z0-9.]{1,12}$/.test(symbol) || !isAddress(token ?? "") || !isAddress(feed ?? "")) {
        throw new Error("ORRERY_DATA_STOCKS: use SYMBOL:token:feed[:poolId],...");
      }
      if (poolId && !(isHex(poolId) && poolId.length === 66)) throw new Error(`ORRERY_DATA_STOCKS: ${symbol} poolId must be 32 bytes`);
      return { symbol, token: token as Address, feed: feed as Address, poolId: (poolId as Hex) || null };
    });
}

/** `otherKeys`: the check signer, relayer, attester and quote signer keys; the data signer must differ from each (R-52). */
export function loadDataConfig(env: NodeJS.ProcessEnv, chainId: number, otherKeys: (Hex | null)[], fallbackFeeTiers: Address | null): DataConfig | null {
  const key = signerKey(env, chainId);
  if (!key) return null;
  if (otherKeys.some((k) => k && k.toLowerCase() === key.toLowerCase())) {
    throw new Error("ORRERY_DATA_SIGNER_KEY must be its own key, not the check signer, relayer, attester or quote signer key");
  }
  const registry = optAddr(env, "ORRERY_DATA_REGISTRY");
  const providerFactory = optAddr(env, "ORRERY_DATA_PROVIDER_FACTORY");
  if (!!registry !== !!providerFactory) throw new Error("ORRERY_DATA_REGISTRY and ORRERY_DATA_PROVIDER_FACTORY are set together");
  const on4663 = chainId === 4663;
  return {
    signerKey: key,
    splitter: optAddr(env, "ORRERY_DATA_SPLITTER"),
    permit2Proxy: optAddr(env, "ORRERY_X402_PERMIT2_PROXY"),
    permit2: optAddr(env, "ORRERY_PERMIT2") ?? "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    registry,
    providerFactory,
    callUsd: big(env, "ORRERY_DATA_CALL_USD", "1000"),
    packCalls: int(env, "ORRERY_DATA_PACK_CALLS", 1_000, 1, 10_000_000),
    orryDiscountBps: int(env, "ORRERY_DATA_ORRY_DISCOUNT_BPS", 2_000, 0, 9_000),
    maxStakeDiscountBps: int(env, "ORRERY_DATA_MAX_STAKE_DISCOUNT_BPS", 9_000, 0, 9_000),
    feeTiers: optAddr(env, "ORRERY_DATA_FEE_TIERS") ?? fallbackFeeTiers,
    quoteTtlSeconds: int(env, "ORRERY_DATA_QUOTE_TTL_SECONDS", 120, 30, 600),
    startBlock: BigInt(env.ORRERY_DATA_START_BLOCK ?? env.ORRERY_INDEXER_START_BLOCK ?? 0),
    stocks: parseStocks(env.ORRERY_DATA_STOCKS ?? (on4663 ? STOCKS_4663 : "")),
    issuerRegistry: optAddr(env, "ORRERY_DATA_ISSUER_REGISTRY") ?? (on4663 ? ISSUER_REGISTRY_4663 : null),
    ponsFactory: optAddr(env, "ORRERY_DATA_PONS_FACTORY") ?? (on4663 ? PONS_FACTORY_4663 : null),
    feedStaleSeconds: int(env, "ORRERY_DATA_FEED_STALE_SECONDS", 90_000, 60, 7 * 86_400),
    poolManager: optAddr(env, "ORRERY_DATA_POOL_MANAGER") ?? optAddr(env, "ORRERY_POOL_MANAGER") ?? (on4663 ? POOL_MANAGER_4663 : null),
    splitMinOrry: big(env, "ORRERY_DATA_SPLIT_MIN", "1000000000000000000000"),
    forwardMinUsdg: big(env, "ORRERY_DATA_FORWARD_MIN", "10000000"),
    maxAgeHours: int(env, "ORRERY_DATA_MAX_AGE_HOURS", 24, 1, 24 * 30),
    cacheMs: int(env, "ORRERY_DATA_CACHE_MS", 10_000, 0, 600_000),
    maxLimit: int(env, "ORRERY_DATA_MAX_LIMIT", 500, 10, 5_000),
  };
}

/** Data keeper gas key (`ORRERY_DATA_KEEPER_KEY[_FILE]`, D-15): its own role; anvil key 9 on 31337 only. */
export function loadDataKeeperKey(env: NodeJS.ProcessEnv = process.env): Hex {
  const chainId = Number(env.ORRERY_CHAIN_ID ?? 31337);
  if (env.ORRERY_DATA_KEEPER_KEY) return env.ORRERY_DATA_KEEPER_KEY as Hex;
  const file = env.ORRERY_DATA_KEEPER_KEY_FILE;
  if (file) {
    const raw = readFileSync(file, "utf8").trim();
    return (raw.startsWith("{") ? (JSON.parse(raw) as { privateKey: Hex }).privateKey : raw) as Hex;
  }
  if (chainId === 31337) return "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
  throw new Error(`ORRERY_DATA_KEEPER_KEY or ORRERY_DATA_KEEPER_KEY_FILE is required on chain ${chainId}`);
}
