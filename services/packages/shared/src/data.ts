import { keccak256, toBytes, verifyTypedData, type Address, type Hex } from "viem";

/**
 * Orrery Data (R-49 to R-52, R-60; `docs/updates/L2-DATA-MCP-SPEC.md`): official datasets built only from chain data
 * and Orrery's own system, sold in packs of calls, every response EIP-712 signed by the data-signer key.
 */

// ------------------------------------------------------------------ datasets

export const DATA_DATASETS = ["agents", "agent-economy", "stock-actions", "stock-liquidity", "pons-launches", "orry-economy", "chain-health"] as const;
export type DatasetId = (typeof DATA_DATASETS)[number];

export type DataSource = "chain" | "orrery";

export interface DatasetInfo {
  id: DatasetId;
  title: string;
  summary: string;
  /** Where every record comes from (DA-4): the chain, or Orrery's own system. Never a third-party API. */
  sources: DataSource[];
  /** `view` values the dataset answers; the first is the default. */
  views: string[];
  /** Filters it accepts besides `view`, `limit` and `before`. */
  filters: string[];
}

export const DATA_CATALOG: Record<DatasetId, DatasetInfo> = {
  agents: {
    id: "agents",
    title: "Agents",
    summary: "New ERC-8004 agents, verifications, attestations, policy changes, queued cap increases and endpoint probe history.",
    sources: ["chain", "orrery"],
    views: ["events", "probes"],
    filters: ["agentId", "kind"],
  },
  "agent-economy": {
    id: "agent-economy",
    title: "Agent economy",
    summary: "x402 payments settled through Orrery: per payment, daily volume and the top merchants.",
    sources: ["orrery", "chain"],
    views: ["payments", "daily", "merchants"],
    filters: ["merchant", "payer", "asset"],
  },
  "stock-actions": {
    id: "stock-actions",
    title: "Stock corporate actions",
    summary: "Multiplier changes, token and oracle pauses, issuer block events, and each stock's current state with its feed state.",
    sources: ["chain"],
    views: ["events", "state"],
    filters: ["symbol"],
  },
  "stock-liquidity": {
    id: "stock-liquidity",
    title: "Stock liquidity",
    summary: "Stock and USDG pools on Uniswap v4: price, in-range liquidity, depth for a 1% move and spread to the feed.",
    sources: ["chain"],
    views: ["pools"],
    filters: ["symbol"],
  },
  "pons-launches": {
    id: "pons-launches",
    title: "Pons launches",
    summary: "New tokens launched on Pons, graduations, and how far recent curves are from graduating.",
    sources: ["chain"],
    views: ["events", "curves"],
    filters: ["token", "kind"],
  },
  "orry-economy": {
    id: "orry-economy",
    title: "ORRY economy",
    summary: "ORRY burns by source, fees collected, stake totals, sampled hub prices and the staker leaderboard.",
    sources: ["chain", "orrery"],
    views: ["burns", "fees", "stake", "price", "leaderboard"],
    filters: ["source"],
  },
  "chain-health": {
    id: "chain-health",
    title: "Chain health",
    summary: "Robinhood Chain head, block time, base fee and how far each Orrery indexer is behind the head.",
    sources: ["chain", "orrery"],
    views: ["now"],
    filters: [],
  },
};

/** Burn source of `DataFeeSplitter` in `IOrryBurnEvents.Burned` (D-1: 7 is the MerchantSplitter, 8 to 10 lane L1). */
export const DATA_BURN_SOURCE = 11;

/** Every ORRY burn source known to this lane, for labels (1 to 7 launch and wave 3, 8 to 10 lane L1, 11 data). */
export const BURN_SOURCE_LABELS: Record<number, string> = {
  1: "Rewards router",
  2: "Check packs in ORRY",
  3: "Verification in ORRY",
  4: "Buyback of fees in ETH",
  5: "Market commitment fee",
  6: "Market fee in ORRY",
  7: "x402 settlement fee",
  8: "Burn to boost",
  9: "Passes",
  10: "Template market",
  11: "Orrery Data in ORRY",
};

// ------------------------------------------------------------------ signed responses (R-52)

export const DATA_DOMAIN_NAME = "Orrery Data";
export const DATA_DOMAIN_VERSION = "1";
export const dataDomain = (chainId: number) => ({ name: DATA_DOMAIN_NAME, version: DATA_DOMAIN_VERSION, chainId }) as const;
export const dataResponseTypes = {
  DataResponse: [
    { name: "dataset", type: "string" },
    { name: "queryHash", type: "bytes32" },
    { name: "recordsHash", type: "bytes32" },
    { name: "asOfBlock", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/** A record value: strings (every amount is a decimal string), safe integers, booleans, null, arrays and objects. */
export type DataValue = string | number | boolean | null | DataValue[] | { [key: string]: DataValue };
export type DataRecord = { [key: string]: DataValue };

/** Throws unless every number is a safe integer, so `JSON.stringify` is the same in every language that keeps the JSON. */
export function assertDataValues(v: unknown, path = "records"): void {
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`${path}: numbers must be safe integers; send decimals as strings`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => assertDataValues(x, `${path}[${i}]`));
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) assertDataValues(x, `${path}.${k}`);
    return;
  }
  throw new Error(`${path}: unsupported value`);
}

/** The query as signed: string values, keys in alphabetical order. */
export function normalizeDataQuery(q: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(q).sort()) {
    const v = q[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

export const dataRecordsHash = (records: DataRecord[]): Hex => keccak256(toBytes(JSON.stringify(records)));
export const dataQueryHash = (query: Record<string, string>): Hex => keccak256(toBytes(JSON.stringify(normalizeDataQuery(query))));

export interface DataAccountView {
  address: Address;
  /** Data calls left on this address. */
  calls: string;
  /** Present once, when a payment just issued this address its API key. */
  apiKey?: string;
}

export interface DataResponse {
  dataset: DatasetId;
  view: string;
  query: Record<string, string>;
  /** The block every record is at or before (decimal string). */
  asOfBlock: string;
  issuedAt: number;
  records: DataRecord[];
  /** Cursor for the next page (`before=`), not signed. */
  next: string | null;
  queryHash: Hex;
  recordsHash: Hex;
  signer: Address;
  signature: Hex;
  chainId: number;
  account?: DataAccountView;
}

/**
 * Verifies a data response as served: the hashes recomputed from `records` and `query`, then the EIP-712 signature.
 * Pass `signer` (from `GET /v1/data/signer`, or pinned in your client) to require Orrery's data signer.
 */
export async function verifyDataResponse(
  r: Pick<DataResponse, "dataset" | "query" | "asOfBlock" | "issuedAt" | "records" | "queryHash" | "recordsHash" | "signer" | "signature" | "chainId">,
  opts: { signer?: Address; chainId?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    assertDataValues(r.records);
  } catch {
    return { ok: false, reason: "records_not_canonical" };
  }
  if (opts.chainId !== undefined && opts.chainId !== r.chainId) return { ok: false, reason: "wrong_chain" };
  if (opts.signer && opts.signer.toLowerCase() !== r.signer.toLowerCase()) return { ok: false, reason: "unexpected_signer" };
  if (dataRecordsHash(r.records) !== r.recordsHash) return { ok: false, reason: "records_hash_mismatch" };
  if (dataQueryHash(r.query) !== r.queryHash) return { ok: false, reason: "query_hash_mismatch" };
  const valid = await verifyTypedData({
    address: r.signer,
    domain: dataDomain(r.chainId),
    types: dataResponseTypes,
    primaryType: "DataResponse",
    message: { dataset: r.dataset, queryHash: r.queryHash, recordsHash: r.recordsHash, asOfBlock: BigInt(r.asOfBlock), issuedAt: BigInt(r.issuedAt) },
    signature: r.signature,
  }).catch(() => false);
  return valid ? { ok: true } : { ok: false, reason: "invalid_signature" };
}

// ------------------------------------------------------------------ packs

/** A data pack requirement: USDG by EIP-3009 to the treasury, or ORRY by Permit2 (through `extra.proxy`) to
 * `DataFeeSplitter` at a stored quote (`extra.quoteId`, D-4). */
export interface DataPaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: {
    name?: string;
    version?: string;
    assetTransferMethod: "eip3009" | "permit2";
    proxy?: Address;
    permit2?: Address;
    quoteId?: Hex;
    /** USD the amount is worth (USDG base units) after the ORRY discount. */
    usd?: string;
    calls: number;
  };
}

/** Calls a pack grants an address with a stake discount of `discountBps` (D-5): the price stays, the calls grow. */
export function packCallsFor(packCalls: number, discountBps: number, maxDiscountBps: number): number {
  const d = Math.max(0, Math.min(discountBps, maxDiscountBps));
  return Math.floor((packCalls * 10_000) / (10_000 - d));
}

// ------------------------------------------------------------------ prices and providers

export interface DataPricing {
  /** USD per call, USDG base units (6 decimals). */
  callUsd: string;
  packCalls: number;
  /** Pack price in USDG base units. */
  packUsd: string;
  /** ORRY pays this much less (basis points, R-60). */
  orryDiscountBps: number;
  usdg: Address;
  /** The splitter that receives ORRY payments; null while ORRY payment is not open. */
  orryPayTo: Address | null;
  orry: Address | null;
  treasury: Address;
  network: string;
  signer: Address;
  /** Stake discount is paid as extra calls (D-5); this is the cap. */
  maxStakeDiscountBps: number;
}

export interface DataCatalogResponse {
  datasets: (DatasetInfo & { records: number | null })[];
  pricing: DataPricing;
}

export interface DataProviderView {
  provider: Address;
  splitter: Address;
  endpoint: string;
  name: string;
  description: string;
  priceUsdg: string;
  listedAt: number;
  updatedAt: number;
  listedBlock: string;
  listedTx: Hex;
  active: boolean;
  stakeUsd: string;
  settled30d: { asset: Address; payments: number; amount: string }[];
}

export interface DataProvidersResponse {
  providers: DataProviderView[];
  minStakeUsd: string;
  feeBps: number;
  registry: Address;
}

// <generated-abi> (services/scripts/data-gen-abi.ts writes this block from contracts/out; do not edit by hand)
export const iDataFeeSplitterAbi = [{"type":"function","name":"BURN_BPS","inputs":[],"outputs":[{"name":"","type":"uint16","internalType":"uint16"}],"stateMutability":"view"},{"type":"function","name":"BURN_SOURCE","inputs":[],"outputs":[{"name":"","type":"uint8","internalType":"uint8"}],"stateMutability":"view"},{"type":"function","name":"POOL_DELAY","inputs":[],"outputs":[{"name":"","type":"uint64","internalType":"uint64"}],"stateMutability":"view"},{"type":"function","name":"executePool","inputs":[],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"orry","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"pendingPool","inputs":[],"outputs":[{"name":"pool_","type":"address","internalType":"address"},{"name":"executableAt","type":"uint64","internalType":"uint64"}],"stateMutability":"view"},{"type":"function","name":"pool","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"poolOwed","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"previewSplit","inputs":[],"outputs":[{"name":"received","type":"uint256","internalType":"uint256"},{"name":"burned","type":"uint256","internalType":"uint256"},{"name":"toPool","type":"uint256","internalType":"uint256"},{"name":"owedAfter","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"proposePool","inputs":[{"name":"pool_","type":"address","internalType":"address"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"split","inputs":[],"outputs":[{"name":"burned","type":"uint256","internalType":"uint256"},{"name":"toPool","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},{"type":"function","name":"treasury","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"event","name":"Burned","inputs":[{"name":"source","type":"uint8","indexed":true,"internalType":"uint8"},{"name":"amount","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"PoolFunded","inputs":[{"name":"pool","type":"address","indexed":true,"internalType":"address"},{"name":"amount","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"PoolProposed","inputs":[{"name":"pool","type":"address","indexed":true,"internalType":"address"},{"name":"executableAt","type":"uint64","indexed":false,"internalType":"uint64"}],"anonymous":false},{"type":"event","name":"PoolSet","inputs":[{"name":"pool","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},{"type":"event","name":"Split","inputs":[{"name":"received","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"burned","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"toPool","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"error","name":"InexactBurn","inputs":[]},{"type":"error","name":"InexactFunding","inputs":[]},{"type":"error","name":"NoPoolProposal","inputs":[]},{"type":"error","name":"NotTreasuryOwner","inputs":[]},{"type":"error","name":"NothingToSplit","inputs":[]},{"type":"error","name":"PoolAlreadySet","inputs":[]},{"type":"error","name":"PoolNotReady","inputs":[{"name":"executableAt","type":"uint64","internalType":"uint64"}]},{"type":"error","name":"WrongPool","inputs":[]},{"type":"error","name":"ZeroAddress","inputs":[]}] as const;
export const iDataProviderRegistryAbi = [{"type":"function","name":"FEE_BPS","inputs":[],"outputs":[{"name":"","type":"uint16","internalType":"uint16"}],"stateMutability":"view"},{"type":"function","name":"isActive","inputs":[{"name":"provider","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"isListed","inputs":[{"name":"provider","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"list","inputs":[{"name":"endpoint","type":"string","internalType":"string"},{"name":"name","type":"string","internalType":"string"},{"name":"description","type":"string","internalType":"string"},{"name":"priceUsdg","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"splitter","type":"address","internalType":"address"}],"stateMutability":"nonpayable"},{"type":"function","name":"listing","inputs":[{"name":"provider","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"tuple","internalType":"struct IDataProviderRegistry.Listing","components":[{"name":"listedAt","type":"uint64","internalType":"uint64"},{"name":"updatedAt","type":"uint64","internalType":"uint64"},{"name":"priceUsdg","type":"uint256","internalType":"uint256"},{"name":"contentHash","type":"bytes32","internalType":"bytes32"}]}],"stateMutability":"view"},{"type":"function","name":"minStakeUsd","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"providerCount","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"providerFactory","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"splitterOf","inputs":[{"name":"provider","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"stakeUsdOf","inputs":[{"name":"provider","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"stakeValue","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"unlist","inputs":[],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"update","inputs":[{"name":"endpoint","type":"string","internalType":"string"},{"name":"name","type":"string","internalType":"string"},{"name":"description","type":"string","internalType":"string"},{"name":"priceUsdg","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"event","name":"Listed","inputs":[{"name":"provider","type":"address","indexed":true,"internalType":"address"},{"name":"splitter","type":"address","indexed":true,"internalType":"address"},{"name":"endpoint","type":"string","indexed":false,"internalType":"string"},{"name":"name","type":"string","indexed":false,"internalType":"string"},{"name":"description","type":"string","indexed":false,"internalType":"string"},{"name":"priceUsdg","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"Unlisted","inputs":[{"name":"provider","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},{"type":"event","name":"Updated","inputs":[{"name":"provider","type":"address","indexed":true,"internalType":"address"},{"name":"endpoint","type":"string","indexed":false,"internalType":"string"},{"name":"name","type":"string","indexed":false,"internalType":"string"},{"name":"description","type":"string","indexed":false,"internalType":"string"},{"name":"priceUsdg","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"error","name":"AlreadyListed","inputs":[]},{"type":"error","name":"BadDescription","inputs":[]},{"type":"error","name":"BadEndpoint","inputs":[]},{"type":"error","name":"BadName","inputs":[]},{"type":"error","name":"BadPrice","inputs":[]},{"type":"error","name":"NotListed","inputs":[]},{"type":"error","name":"StakeTooLow","inputs":[{"name":"have","type":"uint256","internalType":"uint256"},{"name":"need","type":"uint256","internalType":"uint256"}]},{"type":"error","name":"WrongFactory","inputs":[]},{"type":"error","name":"ZeroAddress","inputs":[]},{"type":"error","name":"ZeroMinStake","inputs":[]}] as const;
// </generated-abi>
