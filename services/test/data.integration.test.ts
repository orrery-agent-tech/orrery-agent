import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, encodeAbiParameters, encodeFunctionResult, getAbiItem, keccak256, maxUint256, toFunctionSelector, toHex, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import {
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  decodeHeader,
  devUSDGAbi,
  encodeHeader,
  iDataFeeSplitterAbi,
  iDataProviderRegistryAbi,
  iMerchantSplitterAbi,
  iOrreryHookAbi,
  poolManagerAbi,
  poolStateSlot,
  signPermit2Payment,
  transferWithAuthorizationTypes,
  verifyDataResponse,
  type DataPaymentRequirements,
  type DataResponse,
  type FacilitatorRequest,
  type PaymentRequired,
  type PublicPaymentRequirements,
} from "@orrery/sdk";
import { buildApi, connect, loadConfig, makeChain, migrate, setRelease, type Config, type Sql } from "@orrery/server";
import { privateKeyToAccount } from "viem/accounts";
import { devUSDGBytecode } from "./generated/bytecode.js";
import { merchantSplitterFactoryAbi, merchantSplitterFactoryBytecode, mockOrryAbi, mockOrryBytecode, x402Permit2ProxyAbi, x402Permit2ProxyBytecode } from "./generated/orry.js";
import { orryStandInAbi, orryStandInBytecode } from "./generated/standins.js";
import {
  dataEventEmitterAbi,
  dataEventEmitterBytecode,
  dataFeeSplitterAbi,
  dataFeeSplitterBytecode,
  dataProviderRegistryAbi,
  dataProviderRegistryBytecode,
  dataStakeValueAbi,
  dataStakeValueBytecode,
  dataTreasuryAbi,
  dataTreasuryBytecode,
} from "./generated/data.js";
import { DATABASE_URL, DATA_ANVIL_PORT } from "./env.js";
import { ROLE, anvilKey, clients, mine, rpcCall, send, startAnvil, warp } from "./orry-system.js";
import { dataKeeperOnce } from "../packages/server/src/data-keeper.js";
import { indexDataOnce, resolvePaymentBlocks } from "../packages/server/src/data-indexer.js";

/**
 * Lane L2 end to end on anvil with the real contracts (`docs/updates/L2-DATA-MCP-SPEC.md` 3 and 8): DevUSDG (EIP-3009),
 * a Pons-shaped ORRY, the canonical Permit2 runtime, X402Permit2Proxy, DataFeeSplitter, DataProviderRegistry with a 1%
 * MerchantSplitterFactory; FeeTiers, the hub and the PoolManager are stand-ins. Invariants DA-1, DA-2 and DA-4 to DA-9.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RPC = `http://127.0.0.1:${DATA_ANVIL_PORT}`;
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PERMIT2_RUNTIME = readFileSync(join(here, "../../contracts/test/facilitator/Permit2Code.sol"), "utf8").match(/hex"([0-9a-f]+)"/)![1]!;
const NETWORK = "eip155:31337";
const USD = 1_000_000n;
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
/** 1 USDG base unit = 1e14 ORRY base units, so 1 USD = 100 ORRY; ORRY is currency1 of the hub. */
const HUB_SQRT = 10_000_000n * Q96;
const HUB_POOL_ID: Hex = keccak256(toHex("data-test-usdg-hub"));
const STOCK_POOL_ID: Hex = keccak256(toHex("data-test-stock-pool"));

let anvil: ChildProcess | undefined;
let c: ReturnType<typeof clients>;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let base: string;
let usdg: Address, orry: Address, proxy: Address, splitter: Address, registry: Address, providerFactory: Address, stakeValue: Address, tiers: Address;
let hook: Address, pm: Address, standIn: Address, dataTreasury: Address, stock: Address, issuer: Address, pons: Address, feed: Address;
let apiKey = "";
const payer = () => c.address(ROLE.alice);
const bob = () => c.address(ROLE.bob);
const carol = () => c.address(ROLE.carol);
const treasury = () => c.address(ROLE.quoteSigner);

async function deploy(abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const w = c.wallet(ROLE.deployer);
  const hash = await w.deployContract({ abi, bytecode, args, chain: foundry, account: w.account });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deployment reverted in ${hash}`);
  return r.contractAddress;
}
const answer = (to: Address, abi: Abi, fn: string, result: unknown) =>
  send(c, ROLE.deployer, to, orryStandInAbi as Abi, "setResponse", [toFunctionSelector(getAbiItem({ abi, name: fn }) as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
const answerFor = (to: Address, abi: Abi, fn: string, args: unknown[], result: unknown) =>
  send(c, ROLE.deployer, to, orryStandInAbi as Abi, "setResponseFor", [
    (toFunctionSelector(getAbiItem({ abi, name: fn }) as never) + encodeAbiParameters((getAbiItem({ abi, name: fn }) as unknown as { inputs: never[] }).inputs, args as never).slice(2)) as Hex,
    encodeFunctionResult({ abi, functionName: fn, result } as never),
  ]);
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => c.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const balance = (token: Address, who: Address) => read<bigint>(token, mockOrryAbi as Abi, "balanceOf", [who]);
const now = async () => (await c.pub.getBlock()).timestamp;
async function catchUp() {
  await mine({ pub: c.pub }, cfg.confirmations + 1);
  for (let i = 0; i < 20; i++) {
    const r = await indexDataOnce(cfg, makeChain(cfg), sql);
    if (r.head - r.last <= BigInt(cfg.confirmations)) break;
  }
  await resolvePaymentBlocks(makeChain(cfg), sql);
}

async function get(path: string, key?: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
  return { status: r.status, headers: r.headers, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function usdgAuthorization(role: number, req: { payTo: Address; amount: bigint }) {
  const w = c.wallet(role);
  const t = await now();
  const auth = { from: w.account.address, to: req.payTo, value: req.amount, validAfter: t - 60n, validBefore: t + 3600n, nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  const signature = await w.signTypedData({
    account: w.account,
    domain: { name: "Global Dollar", version: "1", chainId: 31337, verifyingContract: usdg },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  return { signature, authorization: { ...auth, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } };
}

async function usdgPack(role: number, req: DataPaymentRequirements) {
  const payload = await usdgAuthorization(role, { payTo: req.payTo, amount: BigInt(req.amount) });
  return encodeHeader({ x402Version: 2, accepted: req, payload });
}

async function orryPack(role: number, req: DataPaymentRequirements) {
  const payload = await signPermit2Payment(c.wallet(role), { chainId: 31337, requirements: req as unknown as PublicPaymentRequirements, permit2: PERMIT2, proxy, deadline: (await now()) + 3600n });
  return encodeHeader(payload);
}

async function required(path: string): Promise<DataPaymentRequirements[]> {
  const r = await get(path);
  expect(r.status).toBe(402);
  return decodeHeader<PaymentRequired>(r.headers.get(HEADER_REQUIRED)!).accepts as unknown as DataPaymentRequirements[];
}

beforeAll(async () => {
  anvil = await startAnvil(DATA_ANVIL_PORT);
  c = clients(RPC);
  const startBlock = await c.pub.getBlockNumber();
  await rpcCall(c, "anvil_setCode", [PERMIT2, `0x${PERMIT2_RUNTIME}`]);
  usdg = await deploy(devUSDGAbi as Abi, devUSDGBytecode as Hex, [c.address(ROLE.deployer)]);
  orry = await deploy(mockOrryAbi as Abi, mockOrryBytecode as Hex);
  proxy = await deploy(x402Permit2ProxyAbi as Abi, x402Permit2ProxyBytecode as Hex, [PERMIT2]);
  dataTreasury = await deploy(dataTreasuryAbi as Abi, dataTreasuryBytecode as Hex, [c.address(ROLE.deployer)]);
  splitter = await deploy(dataFeeSplitterAbi as Abi, dataFeeSplitterBytecode as Hex, [orry, dataTreasury]);
  stakeValue = await deploy(dataStakeValueAbi as Abi, dataStakeValueBytecode as Hex);
  providerFactory = await deploy(merchantSplitterFactoryAbi as Abi, merchantSplitterFactoryBytecode as Hex, [100, usdg, orry, treasury(), "0x0000000000000000000000000000000000000000"]);
  registry = await deploy(dataProviderRegistryAbi as Abi, dataProviderRegistryBytecode as Hex, [stakeValue, providerFactory, 100n * USD]);
  standIn = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  hook = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  pm = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  tiers = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  feed = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  stock = await deploy(dataEventEmitterAbi as Abi, dataEventEmitterBytecode as Hex);
  issuer = await deploy(dataEventEmitterAbi as Abi, dataEventEmitterBytecode as Hex);
  pons = await deploy(dataEventEmitterAbi as Abi, dataEventEmitterBytecode as Hex);

  // ORRY price: one ORRY/USDG hub at 100 ORRY per USD
  await answer(hook, iOrreryHookAbi as Abi, "pairCount", 1n);
  await answer(hook, iOrreryHookAbi as Abi, "pairAt", { quote: usdg, usdFeed: usdg, poolId: HUB_POOL_ID, orryIsCurrency0: false, initialized: true, registeredAt: 1n });
  await answerFor(pm, poolManagerAbi as Abi, "extsload", [poolStateSlot(HUB_POOL_ID)], toHex(HUB_SQRT, { size: 32 }));
  // FeeTiers: bob has a 20% stake discount, everyone else none
  const tiersAbi = [
    { type: "function", name: "stakeUsd", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "discountBps", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint16" }] },
  ] as const satisfies Abi;
  await answer(tiers, tiersAbi, "stakeUsd", 0n);
  await answer(tiers, tiersAbi, "discountBps", 0);
  await answerFor(tiers, tiersAbi, "discountBps", [bob()], 2000);

  await send(c, ROLE.deployer, usdg, devUSDGAbi as Abi, "mint", [payer(), 1_000n * USD]);
  await send(c, ROLE.deployer, usdg, devUSDGAbi as Abi, "mint", [bob(), 1_000n * USD]);
  for (const who of [payer(), carol()]) {
    await send(c, ROLE.deployer, orry, mockOrryAbi as Abi, "transfer", [who, 10_000n * E18]);
  }
  await send(c, ROLE.alice, orry, mockOrryAbi as Abi, "approve", [PERMIT2, maxUint256]);
  await send(c, ROLE.carol, orry, mockOrryAbi as Abi, "approve", [PERMIT2, maxUint256]);

  cfg = loadConfig({
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: standIn,
    ORRERY_ATTESTOR: standIn,
    ORRERY_LENS: standIn,
    ORRERY_REGISTRY: standIn,
    ORRERY_USDG: usdg,
    ORRERY_TREASURY: treasury(),
    ORRERY_CONFIRMATIONS: "2",
    ORRERY_ORRY_TOKEN: orry,
    ORRERY_ORRY_HOOK: hook,
    ORRERY_ORRY_EARN_FACTORY: standIn,
    ORRERY_ORRY_STAKING: standIn,
    ORRERY_ORRY_ROUTER: standIn,
    ORRERY_ORRY_BUYBACK: standIn,
    ORRERY_ORRY_LENS: standIn,
    ORRERY_POOL_MANAGER: pm,
    ORRERY_ORRY_MIN_SAMPLES: "1",
    ORRERY_ORRY_FEATURES: "facilitator,orry-x402",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    ORRERY_SPLITTER_FACTORY: providerFactory, // the public facilitator's own factory does not matter here
    ORRERY_X402_PERMIT2_PROXY: proxy,
    ORRERY_PERMIT2: PERMIT2,
    ORRERY_FEE_TIERS: tiers,
    ORRERY_DATA_SPLITTER: splitter,
    ORRERY_DATA_REGISTRY: registry,
    ORRERY_DATA_PROVIDER_FACTORY: providerFactory,
    ORRERY_DATA_START_BLOCK: startBlock.toString(),
    ORRERY_DATA_STOCKS: `TST:${stock}:${feed}:${STOCK_POOL_ID}`,
    ORRERY_DATA_ISSUER_REGISTRY: issuer,
    ORRERY_DATA_PONS_FACTORY: pons,
    ORRERY_DATA_CACHE_MS: "0",
    ORRERY_DATA_SPLIT_MIN: "0",
  });
  sql = connect(cfg.databaseUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrate(sql);
  // one ORRY price sample, as the ORRY keeper writes them
  await sql`insert into orry_price_samples (sampled_at, block_number, hub_sqrt, usd_sqrt, ratio_num, ratio_den)
    values (now(), 1, ${HUB_SQRT.toString()}, 0, ${(HUB_SQRT * HUB_SQRT).toString()}, ${(1n << 192n).toString()})`;
  app = buildApi(cfg, makeChain(cfg), sql);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

describe("Orrery Data: keys and the release switch", () => {
  it("refuses a data signer that is another role's key (DA-2)", () => {
    const env = { ORRERY_CHAIN_ID: "31337", ORRERY_MODULE: standIn, ORRERY_ATTESTOR: standIn, ORRERY_LENS: standIn, ORRERY_REGISTRY: standIn, ORRERY_USDG: usdg, ORRERY_TREASURY: treasury() };
    expect(() => loadConfig({ ...env, ORRERY_DATA_SIGNER_KEY: anvilKey(ROLE.checkSigner) })).toThrow(/data signer|DATA_SIGNER/i);
    expect(() => loadConfig({ ...env, ORRERY_DATA_SIGNER_KEY: anvilKey(ROLE.deployer) })).toThrow(/DATA_SIGNER/);
    expect(loadConfig({ ...env, ORRERY_CHAIN_ID: "4663", ORRERY_RELAYER_KEY: anvilKey(0), ORRERY_CHECK_SIGNER_KEY: anvilKey(1), ORRERY_ATTESTER_KEY: anvilKey(2) }).data).toBeNull();
  });

  it("answers 404 on every data route while `data` and `data-providers` are held (DA-9)", async () => {
    for (const p of ["/v1/data", "/v1/data/signer", "/v1/data/datasets/chain-health", "/v1/data/providers", "/v1/data/x402/supported"]) {
      expect((await get(p)).status).toBe(404);
    }
    expect((await post("/v1/data/packs", {})).status).toBe(404);
    await setRelease(sql, "data", new Date(Date.now() - 1000), "test");
    await setRelease(sql, "data-providers", new Date(Date.now() - 1000), "test");
    expect((await get("/v1/data")).status).toBe(200);
  });

  it("publishes the catalogue, the prices and a data signer that is not the check signer", async () => {
    const r = await get("/v1/data");
    const body = r.body as unknown as { datasets: { id: string; sources: string[] }[]; pricing: Record<string, unknown> };
    expect(body.datasets.map((x) => x.id)).toEqual(["agents", "agent-economy", "stock-actions", "stock-liquidity", "pons-launches", "orry-economy", "chain-health"]);
    expect(body.datasets.every((x) => x.sources.every((s) => s === "chain" || s === "orrery"))).toBe(true);
    expect(body.pricing).toMatchObject({ callUsd: "1000", packCalls: 1000, packUsd: "1000000", orryDiscountBps: 2000 });
    expect(String(body.pricing.orryPayTo).toLowerCase()).toBe(splitter.toLowerCase());
    const s = await get("/v1/data/signer");
    const signer = String(s.body.signer);
    expect(signer).toBe(privateKeyToAccount(anvilKey(11)).address);
    expect(signer).not.toBe(c.address(ROLE.checkSigner));
  });
});

describe("Orrery Data: packs", () => {
  it("asks for a USDG pack at full price and an ORRY pack at 20% off, at a stored quote", async () => {
    const accepts = await required("/v1/data/datasets/chain-health");
    const [u, r] = accepts;
    expect(u).toMatchObject({ amount: "1000000", extra: { assetTransferMethod: "eip3009", calls: 1000 } });
    expect(u!.asset.toLowerCase()).toBe(usdg.toLowerCase());
    expect(u!.payTo.toLowerCase()).toBe(treasury().toLowerCase());
    expect(r!.asset.toLowerCase()).toBe(orry.toLowerCase());
    expect(r!.payTo.toLowerCase()).toBe(splitter.toLowerCase());
    expect(r!.amount).toBe((80n * E18).toString()); // 0.8 USD at 100 ORRY per USD
    expect(r!.extra).toMatchObject({ assetTransferMethod: "permit2", usd: "800000" });
    const [q] = await sql<{ amount: string }[]>`select amount::text as amount from data_orry_quotes where quote_id = ${r!.extra.quoteId!.toLowerCase()}`;
    expect(q!.amount).toBe(r!.amount);
  });

  it("sells a USDG pack once, issues the key once, and answers a repeat without a second grant (DA-5)", async () => {
    const [u] = await required("/v1/data/datasets/chain-health");
    const header = await usdgPack(ROLE.alice, u!);
    const before = await balance(usdg, treasury());
    const r = await post("/v1/data/packs", {}, { [HEADER_SIGNATURE]: header });
    expect(r.status).toBe(200);
    const account = r.body.account as { address: string; calls: string; apiKey?: string };
    expect(account.calls).toBe("1000");
    expect(account.apiKey).toMatch(/^or_/);
    apiKey = account.apiKey!;
    expect((await balance(usdg, treasury())) - before).toBe(USD);
    const again = await post("/v1/data/packs", {}, { [HEADER_SIGNATURE]: header });
    expect(again.status).toBe(200);
    expect((again.body.account as { calls: string }).calls).toBe("1000");
    expect(again.body.granted).toBe("0");
    expect((again.body.account as { apiKey?: string }).apiKey).toBeUndefined();
    expect((await balance(usdg, treasury())) - before).toBe(USD);
  });

  it("pays the stake discount as extra calls (D-5)", async () => {
    const [u] = await required("/v1/data/datasets/chain-health");
    const r = await post("/v1/data/packs", {}, { [HEADER_SIGNATURE]: await usdgPack(ROLE.bob, u!) });
    expect(r.status).toBe(200);
    expect((r.body.account as { calls: string }).calls).toBe("1250"); // 1000 / (1 - 0.2)
  });

  it("sells an ORRY pack to DataFeeSplitter, and refuses a used, wrong or expired quote (DA-6)", async () => {
    const accepts = await required("/v1/data/datasets/chain-health");
    const r = accepts[1]!;
    const wrong = { ...r, amount: (BigInt(r.amount) - 1n).toString() };
    const bad = await post("/v1/data/packs", {}, { [HEADER_SIGNATURE]: await orryPack(ROLE.carol, wrong) });
    expect(bad.status).toBe(402);
    expect(decodeHeader<{ errorReason: string }>(bad.headers.get("payment-response")!).errorReason).toBe("wrong_amount");
    const before = await balance(orry, splitter);
    const ok = await post("/v1/data/packs", {}, { [HEADER_SIGNATURE]: await orryPack(ROLE.carol, r) });
    expect(ok.status).toBe(200);
    expect((await balance(orry, splitter)) - before).toBe(80n * E18);
    expect((ok.body.account as { calls: string }).calls).toBe("1000");
    const reuse = await post("/v1/data/packs", {}, { [HEADER_SIGNATURE]: await orryPack(ROLE.alice, r) });
    expect(decodeHeader<{ errorReason: string }>(reuse.headers.get("payment-response")!).errorReason).toBe("quote_used");
    const late = (await required("/v1/data/datasets/chain-health"))[1]!;
    await warp(c, 200);
    const expired = await post("/v1/data/packs", {}, { [HEADER_SIGNATURE]: await orryPack(ROLE.alice, late) });
    expect(decodeHeader<{ errorReason: string }>(expired.headers.get("payment-response")!).errorReason).toBe("quote_expired");
  });

  it("answers a dataset paid in the same request, with the key in the answer", async () => {
    const [u] = await required("/v1/data/datasets/chain-health");
    const dave = 12;
    await rpcCall(c, "anvil_setBalance", [c.address(dave), toHex(10n ** 18n)]);
    await send(c, ROLE.deployer, usdg, devUSDGAbi as Abi, "mint", [c.address(dave), 5n * USD]);
    const r = await get("/v1/data/datasets/chain-health", undefined, { [HEADER_SIGNATURE]: await usdgPack(dave, u!) });
    expect(r.status).toBe(200);
    const acc = r.body.account as { calls: string; apiKey?: string };
    expect(acc.calls).toBe("999");
    expect(acc.apiKey).toMatch(/^or_/);
  });
});

describe("Orrery Data: signed answers", () => {
  it("signs with the data signer; any change to the records breaks it (DA-2)", async () => {
    const r = await get("/v1/data/datasets/chain-health", apiKey);
    expect(r.status).toBe(200);
    const res = r.body as unknown as DataResponse;
    const signer = privateKeyToAccount(anvilKey(11)).address;
    expect(await verifyDataResponse(res, { signer, chainId: 31337 })).toEqual({ ok: true });
    expect(await verifyDataResponse(res, { signer: c.address(ROLE.checkSigner) })).toEqual({ ok: false, reason: "unexpected_signer" });
    const tampered = { ...res, records: [{ ...res.records[0]!, block: "1" }] };
    expect(await verifyDataResponse(tampered, { signer })).toEqual({ ok: false, reason: "records_hash_mismatch" });
    const forged = { ...res, recordsHash: keccak256(toHex(JSON.stringify(tampered.records))), records: tampered.records };
    expect(await verifyDataResponse(forged, { signer })).toEqual({ ok: false, reason: "invalid_signature" });
    expect(res.records[0]).toMatchObject({ sampleBlocks: expect.any(Number), gasPriceWei: expect.any(String) });
    expect((res.account as { calls: string }).calls).toBe("999");
  });

  it("spends exactly one call per answer and refuses with 402 at zero (DA-7)", async () => {
    await sql`update data_accounts set calls = 1 where address = ${payer().toLowerCase()}`;
    const first = await get("/v1/data/datasets/chain-health", apiKey);
    expect(first.status).toBe(200);
    expect((first.body.account as { calls: string; low?: boolean }).calls).toBe("0");
    const second = await get("/v1/data/datasets/chain-health", apiKey);
    expect(second.status).toBe(402);
    expect(second.headers.get(HEADER_REQUIRED)).toBeTruthy();
    const bad = await get("/v1/data/datasets/chain-health?limit=0", apiKey);
    expect(bad.status).toBe(400);
    await sql`update data_accounts set calls = 100 where address = ${payer().toLowerCase()}`;
    expect((await get("/v1/data/datasets/agents?nope=1", apiKey)).status).toBe(400);
    expect((await get("/v1/data/datasets/nothing", apiKey)).status).toBe(404);
    const [acc] = await sql<{ calls: string }[]>`select calls::text as calls from data_accounts where address = ${payer().toLowerCase()}`;
    expect(acc!.calls).toBe("100"); // refused requests spend nothing
  });
});

describe("Orrery Data: providers (R-51)", () => {
  it("lists a staked provider, indexes it, and settles only to active providers' splitters (DA-8)", async () => {
    await send(c, ROLE.deployer, stakeValue, dataStakeValueAbi as Abi, "set", [bob(), 150n * USD]);
    await send(c, ROLE.bob, registry, iDataProviderRegistryAbi as Abi, "list", ["https://data.example.org/feed", "Example Feed", "Block-level stats", 2000n]);
    await catchUp();
    const list = await get("/v1/data/providers");
    const providers = list.body.providers as { provider: string; splitter: string; active: boolean; stakeUsd: string; listedTx: Hex; listedBlock: string }[];
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ provider: bob(), active: true, stakeUsd: (150n * USD).toString() });
    // DA-1: the listing names the block and transaction that hold its Listed event
    const receipt = await c.pub.getTransactionReceipt({ hash: providers[0]!.listedTx });
    expect(receipt.blockNumber.toString()).toBe(providers[0]!.listedBlock);
    expect(receipt.logs.some((l) => l.address.toLowerCase() === registry.toLowerCase())).toBe(true);
    expect(list.body.feeBps).toBe(100);

    const payTo = providers[0]!.splitter as Address;
    const req: PublicPaymentRequirements = { scheme: "exact", network: NETWORK, amount: (2n * USD).toString(), asset: usdg, payTo, maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" } };
    const body: FacilitatorRequest = { x402Version: 2, paymentRequirements: req, paymentPayload: { x402Version: 2, accepted: req, payload: await usdgAuthorization(ROLE.alice, { payTo, amount: 2n * USD }) } };
    expect((await post("/v1/data/x402/verify", body)).body).toMatchObject({ isValid: true });
    const settled = await post("/v1/data/x402/settle", body);
    expect(settled.body.success).toBe(true);
    expect(await balance(usdg, payTo)).toBe(2n * USD);

    // a splitter in the same factory whose owner never listed is refused
    await send(c, ROLE.carol, providerFactory, merchantSplitterFactoryAbi as Abi, "create", [carol()]);
    const other = await read<Address>(providerFactory, merchantSplitterFactoryAbi as Abi, "splitterOf", [carol()]);
    const req2 = { ...req, payTo: other };
    const body2: FacilitatorRequest = { x402Version: 2, paymentRequirements: req2, paymentPayload: { x402Version: 2, accepted: req2, payload: await usdgAuthorization(ROLE.alice, { payTo: other, amount: 2n * USD }) } };
    expect((await post("/v1/data/x402/settle", body2)).body).toMatchObject({ success: false, errorReason: "pay_to_is_not_an_active_data_provider" });
    // the provider unstakes: out of the active set without anyone acting
    await send(c, ROLE.deployer, stakeValue, dataStakeValueAbi as Abi, "set", [bob(), 0n]);
    const body3: FacilitatorRequest = { x402Version: 2, paymentRequirements: req, paymentPayload: { x402Version: 2, accepted: req, payload: await usdgAuthorization(ROLE.alice, { payTo, amount: 2n * USD }) } };
    expect((await post("/v1/data/x402/settle", body3)).body).toMatchObject({ success: false, errorReason: "pay_to_is_not_an_active_data_provider" });
    await send(c, ROLE.deployer, stakeValue, dataStakeValueAbi as Abi, "set", [bob(), 150n * USD]);
  });

  it("forwards the provider's splitter: 1% to the treasury, the rest to the provider", async () => {
    const payTo = await read<Address>(registry, iDataProviderRegistryAbi as Abi, "splitterOf", [bob()]);
    const t0 = await balance(usdg, treasury());
    const b0 = await balance(usdg, bob());
    await sql`update data_providers set listed_at = now() - interval '2 days'`;
    const steps = await dataKeeperOnce(cfg, makeChain(cfg), sql, anvilKey(ROLE.keeper));
    expect(steps.some((s) => s.action.startsWith("forward") && s.status === "sent")).toBe(true);
    expect(steps.find((s) => s.action === "split")?.status).toBe("sent"); // the ORRY packs were due too (split minimum 0)
    expect((await balance(usdg, treasury())) - t0).toBe(20_000n);
    expect((await balance(usdg, bob())) - b0).toBe(1_980_000n);
    expect(await balance(usdg, payTo)).toBe(0n);
  });
});

describe("Orrery Data: datasets and their sources (DA-1)", () => {
  it("names the block, transaction and log of each settled payment (agent economy)", async () => {
    await catchUp();
    const r = await get("/v1/data/datasets/agent-economy?view=payments", apiKey);
    expect(r.status).toBe(200);
    const recs = (r.body as unknown as DataResponse).records as { tx: Hex; block: string; logIndex: number; amount: string; provider: string | null }[];
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      const receipt = await c.pub.getTransactionReceipt({ hash: rec.tx });
      expect(receipt.blockNumber.toString()).toBe(rec.block);
      const log = receipt.logs.find((l) => l.logIndex === rec.logIndex)!;
      const d = decodeEventLog({ abi: devUSDGAbi as Abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: { value: bigint } };
      expect(d.eventName).toBe("Transfer");
      expect(d.args.value.toString()).toBe(rec.amount);
    }
    expect(recs[0]!.provider).toBe(bob().toLowerCase());
    const daily = await get("/v1/data/datasets/agent-economy?view=daily", apiKey);
    expect((daily.body as unknown as DataResponse).records[0]).toMatchObject({ payments: 1, amount: (2n * USD).toString() });
  });

  it("splits the ORRY packs (70% burned as source 11, 30% held) and serves the burn with its log", async () => {
    expect(await read<bigint>(splitter, iDataFeeSplitterAbi as Abi, "poolOwed")).toBe(24n * E18);
    await catchUp();
    const r = await get("/v1/data/datasets/orry-economy?view=burns&source=11", apiKey);
    expect(r.status).toBe(200);
    const [burn] = (r.body as unknown as DataResponse).records as { source: number; amount: string; tx: Hex; logIndex: number; label: string }[];
    expect(burn).toMatchObject({ source: 11, amount: (56n * E18).toString(), label: "Orrery Data in ORRY" });
    const receipt = await c.pub.getTransactionReceipt({ hash: burn!.tx });
    const log = receipt.logs.find((l) => l.logIndex === burn!.logIndex)!;
    const d = decodeEventLog({ abi: iDataFeeSplitterAbi as Abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: { source: number; amount: bigint } };
    expect(d).toMatchObject({ eventName: "Burned", args: { source: 11, amount: 56n * E18 } });
  });

  it("serves stock actions, stock state, Pons launches and curves from the chain", async () => {
    const em = dataEventEmitterAbi as Abi;
    await send(c, ROLE.deployer, stock, em, "multiplier", [10n ** 18n, 2n * 10n ** 18n, (await now()) + 86_400n]);
    await send(c, ROLE.deployer, stock, em, "setState", [10n ** 18n, (await now()) + 86_400n, false, true, 18]);
    await send(c, ROLE.deployer, issuer, em, "blocked", [carol()]);
    const curve = c.address(13);
    await rpcCall(c, "anvil_setBalance", [curve, toHex(21n * 10n ** 17n)]); // 2.1 ETH held: 50% of 4.2
    await send(c, ROLE.deployer, pons, em, "launch", [orry, curve, bob(), "0x0000000000000000000000000000000000000000", 0n, 42n * 10n ** 17n]);
    const feedAbi = [
      { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
      { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    ] as const satisfies Abi;
    await answer(feed, feedAbi, "latestRoundData", [1n, 250n * 10n ** 8n, 0n, await now(), 1n]);
    await answer(feed, feedAbi, "decimals", 8);
    await catchUp();

    const ev = (await get("/v1/data/datasets/stock-actions", apiKey)).body as unknown as DataResponse;
    const kinds = ev.records.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["multiplier", "blocked"]));
    expect(ev.records.find((r) => r.kind === "multiplier")).toMatchObject({ symbol: "TST", scope: "token" });
    expect(await verifyDataResponse(ev)).toEqual({ ok: true });

    const st = (await get("/v1/data/datasets/stock-actions?view=state", apiKey)).body as unknown as DataResponse;
    expect(st.records[0]).toMatchObject({ symbol: "TST", oraclePaused: true, feedState: "paused", uiMultiplier: (10n ** 18n).toString() });
    expect(JSON.stringify(st.records)).not.toContain(String(250n * 10n ** 8n)); // the feed answer is never served (D-12)

    const launches = (await get("/v1/data/datasets/pons-launches", apiKey)).body as unknown as DataResponse;
    expect(launches.records[0]).toMatchObject({ kind: "launched", token: orry.toLowerCase() });
    const curves = (await get("/v1/data/datasets/pons-launches?view=curves", apiKey)).body as unknown as DataResponse;
    expect(curves.records[0]).toMatchObject({ progressBps: 5000, quoteHeld: (21n * 10n ** 17n).toString() });
  });

  it("serves stock liquidity from the pool state and the feed", async () => {
    // TST is currency1 or currency0 by address; price 250 USDG per token either way
    const tokenIs0 = stock.toLowerCase() < usdg.toLowerCase();
    // raw price token1/token0: USDG raw per stock raw = 250e6 / 1e18
    const sqrt = tokenIs0 ? sqrtX96(250n * 10n ** 6n, 10n ** 18n) : sqrtX96(10n ** 18n, 250n * 10n ** 6n);
    const slot = poolStateSlot(STOCK_POOL_ID);
    await answerFor(pm, poolManagerAbi as Abi, "extsload", [slot], toHex(sqrt, { size: 32 }));
    await answerFor(pm, poolManagerAbi as Abi, "extsload", [toHex(BigInt(slot) + 3n, { size: 32 })], toHex(10n ** 15n, { size: 32 }));
    const r = (await get("/v1/data/datasets/stock-liquidity", apiKey)).body as unknown as DataResponse;
    const rec = r.records[0] as { priceUsdg: string; spreadToFeedBps: number; depthUsdg1Pct: string; liquidity: string };
    expect(Number(rec.priceUsdg)).toBeGreaterThan(249_990_000);
    expect(Number(rec.priceUsdg)).toBeLessThan(250_010_000);
    expect(Math.abs(rec.spreadToFeedBps)).toBeLessThanOrEqual(1);
    expect(rec.liquidity).toBe((10n ** 15n).toString());
    expect(BigInt(rec.depthUsdg1Pct)).toBeGreaterThan(0n);
  });

  it("keeps a probe history from the prober's own table (agents, view probes)", async () => {
    await sql`insert into probes (agent_id, probed_at, endpoints_live, registration_valid, domain_verified, registration_hash)
      values (7, now() - interval '1 hour', true, true, false, '0x00')`;
    await sql`update probes set probed_at = now(), domain_verified = true where agent_id = 7`;
    const r = (await get("/v1/data/datasets/agents?view=probes&agentId=7", apiKey)).body as unknown as DataResponse;
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ agentId: "7", domainVerified: true, source: "orrery-prober" });
    expect(r.records[1]).toMatchObject({ domainVerified: false });
  });
});

function sqrtX96(num: bigint, den: bigint): bigint {
  // floor(sqrt(num / den) * 2^96)
  const v = (num << 192n) / den;
  let x = v;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + v / x) / 2n;
  }
  return x;
}
