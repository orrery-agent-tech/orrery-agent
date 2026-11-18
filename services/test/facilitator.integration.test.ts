import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, encodeFunctionResult, getAbiItem, maxUint256, parseEventLogs, toFunctionSelector, toHex, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import {
  FacilitatorApi,
  devUSDGAbi,
  iMerchantSplitterAbi,
  iMerchantSplitterFactoryAbi,
  signPermit2Payment,
  transferWithAuthorizationTypes,
  type FacilitatorRequest,
  type PublicPaymentRequirements,
} from "@orrery/sdk";
import { buildApi, connect, forwardDue, indexFacilitatorOnce, loadConfig, makeChain, migrate, setRelease, stakeQuota, type Config, type Sql } from "@orrery/server";
import { devUSDGBytecode } from "./generated/bytecode.js";
import { merchantSplitterFactoryAbi, merchantSplitterFactoryBytecode, mockOrryAbi, mockOrryBytecode, x402Permit2ProxyAbi, x402Permit2ProxyBytecode } from "./generated/orry.js";
import { orryStandInAbi, orryStandInBytecode } from "./generated/standins.js";
import { DATABASE_URL, FACILITATOR_ANVIL_PORT } from "./env.js";
import { ROLE, anvilKey, clients, mine, rpcCall, send, startAnvil } from "./orry-system.js";

/**
 * Wave 3 public x402 facilitator end to end on anvil with the real contracts: DevUSDG (EIP-3009), a Pons-shaped ORRY,
 * the canonical Permit2 runtime, MerchantSplitterFactory and X402Permit2Proxy. FeeTiers is a stand-in that answers each
 * account's stake value and discount. API, indexer and keeper step against the shared test Postgres.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RPC = `http://127.0.0.1:${FACILITATOR_ANVIL_PORT}`;
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PERMIT2_RUNTIME = readFileSync(join(here, "../../contracts/test/facilitator/Permit2Code.sol"), "utf8").match(/hex"([0-9a-f]+)"/)![1]!;
const NETWORK = "eip155:31337";
/** On-chain FeeTiers for the splitters: a view-only stub answering discountBps 2500 and stakeUsd 200 USD to any account.
 * The splitter reads FeeTiers with a STATICCALL, which the stand-in (it counts calls) cannot answer; the API reads the
 * per-account stand-in below with eth_call. Both give the merchant the same 25% discount. */
const CHAIN_TIERS: Address = "0x0000000000000000000000000000000000001e75";
const CHAIN_TIERS_RUNTIME: Hex = "0x60003560e01c6378e5e5fe14601c57630bebc20060005260206000f35b6109c460005260206000f3";
const USD = 1_000_000n;
const E18 = 10n ** 18n;

let anvil: ChildProcess | undefined;
let c: ReturnType<typeof clients>;
let cfg: Config;
let sql: Sql;
let app: ReturnType<typeof buildApi>;
let baseUrl: string;
let api: FacilitatorApi;
let usdg: Address, orry: Address, feeTiers: Address, factory: Address, proxy: Address, standIn: Address;
const merchant = () => c.address(ROLE.bob);
const other = () => c.address(ROLE.carol);
const payer = () => c.address(ROLE.alice);
const treasury = () => c.address(ROLE.quoteSigner);

async function deploy(abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const w = c.wallet(ROLE.deployer);
  const hash = await w.deployContract({ abi, bytecode, args, chain: foundry, account: w.account });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deployment reverted in ${hash}`);
  return r.contractAddress;
}
const answerFor = (to: Address, abi: Abi, fn: string, args: unknown[], result: unknown) =>
  send(c, ROLE.deployer, to, orryStandInAbi as Abi, "setResponseFor", [encodeFunctionData({ abi, functionName: fn, args } as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
const answer = (to: Address, abi: Abi, fn: string, result: unknown) =>
  send(c, ROLE.deployer, to, orryStandInAbi as Abi, "setResponse", [toFunctionSelector(getAbiItem({ abi, name: fn }) as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => c.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const balance = (token: Address, who: Address) => read<bigint>(token, mockOrryAbi as Abi, "balanceOf", [who]);
const splitterOf = (m: Address) => read<Address>(factory, iMerchantSplitterFactoryAbi as Abi, "splitterOf", [m]);
async function catchUp() {
  await mine({ pub: c.pub }, cfg.confirmations + 1);
  for (let i = 0; i < 20; i++) {
    const r = await indexFacilitatorOnce(cfg, makeChain(cfg), sql);
    if (r.head - r.last <= BigInt(cfg.confirmations)) return;
  }
}
const now = async () => (await c.pub.getBlock()).timestamp;

const feeTiersAbi = [
  { type: "function", name: "stakeUsd", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "discountBps", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint16" }] },
] as const satisfies Abi;

const usdgRequirements = (payTo: Address, amount: bigint): PublicPaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  amount: amount.toString(),
  asset: usdg,
  payTo,
  maxTimeoutSeconds: 600,
  extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" },
});
async function usdgPayment(payTo: Address, amount: bigint, opts: { to?: Address; validBefore?: bigint } = {}): Promise<FacilitatorRequest> {
  const w = c.wallet(ROLE.alice);
  const t = await now();
  const auth = { from: payer(), to: opts.to ?? payTo, value: amount, validAfter: t - 60n, validBefore: opts.validBefore ?? t + 3600n, nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  const signature = await w.signTypedData({
    account: w.account,
    domain: { name: "Global Dollar", version: "1", chainId: 31337, verifyingContract: usdg },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  const requirements = usdgRequirements(payTo, amount);
  return {
    x402Version: 2,
    paymentRequirements: requirements,
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { signature, authorization: { ...auth, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } },
    },
  };
}
async function orryPayment(payTo: Address, amount: bigint): Promise<FacilitatorRequest> {
  const requirements: PublicPaymentRequirements = { scheme: "exact", network: NETWORK, amount: amount.toString(), asset: orry, payTo, maxTimeoutSeconds: 600, extra: { assetTransferMethod: "permit2", proxy } };
  const deadline = (await now()) + 3600n;
  const payload = await signPermit2Payment(c.wallet(ROLE.alice), { chainId: 31337, requirements, permit2: PERMIT2, proxy, deadline });
  return { x402Version: 2, paymentRequirements: requirements, paymentPayload: payload };
}

beforeAll(async () => {
  anvil = await startAnvil(FACILITATOR_ANVIL_PORT);
  c = clients(RPC);
  const startBlock = await c.pub.getBlockNumber();
  await rpcCall(c, "anvil_setCode", [PERMIT2, `0x${PERMIT2_RUNTIME}`]);
  await rpcCall(c, "anvil_setCode", [CHAIN_TIERS, CHAIN_TIERS_RUNTIME]);
  usdg = await deploy(devUSDGAbi as Abi, devUSDGBytecode as Hex, [c.address(ROLE.deployer)]);
  orry = await deploy(mockOrryAbi as Abi, mockOrryBytecode as Hex);
  feeTiers = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  standIn = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
  factory = await deploy(merchantSplitterFactoryAbi as Abi, merchantSplitterFactoryBytecode as Hex, [20, usdg, orry, treasury(), CHAIN_TIERS]);
  proxy = await deploy(x402Permit2ProxyAbi as Abi, x402Permit2ProxyBytecode as Hex, [PERMIT2]);

  // the merchant stakes 200 USD (badge level 100 USD, first tier 25% off); the other merchant stakes nothing
  await answer(feeTiers, feeTiersAbi, "stakeUsd", 0n);
  await answer(feeTiers, feeTiersAbi, "discountBps", 0);
  await answerFor(feeTiers, feeTiersAbi, "stakeUsd", [merchant()], 200n * USD);
  await answerFor(feeTiers, feeTiersAbi, "discountBps", [merchant()], 2500);

  await send(c, ROLE.deployer, usdg, devUSDGAbi as Abi, "mint", [payer(), 1_000n * USD]);
  await send(c, ROLE.deployer, orry, mockOrryAbi as Abi, "transfer", [payer(), 1_000n * E18]);
  await send(c, ROLE.alice, orry, mockOrryAbi as Abi, "approve", [PERMIT2, maxUint256]);

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
    ORRERY_ORRY_HOOK: standIn,
    ORRERY_ORRY_EARN_FACTORY: standIn,
    ORRERY_ORRY_STAKING: standIn,
    ORRERY_ORRY_ROUTER: standIn,
    ORRERY_ORRY_BUYBACK: standIn,
    ORRERY_ORRY_LENS: standIn,
    ORRERY_POOL_MANAGER: standIn,
    ORRERY_ORRY_FEATURES: "burn,facilitator,orry-x402,merchant-badge,stake-quota",
    ORRERY_ORRY_CACHE_MS: "0",
    ORRERY_RELEASES_CACHE_MS: "0",
    ORRERY_PUBLIC_RATE_PER_MINUTE: "600",
    ORRERY_SPLITTER_FACTORY: factory,
    ORRERY_X402_PERMIT2_PROXY: proxy,
    ORRERY_PERMIT2: PERMIT2,
    ORRERY_FACILITATOR_START_BLOCK: startBlock.toString(),
    ORRERY_FEE_TIERS: feeTiers,
  });
  sql = connect(cfg.databaseUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrate(sql);
  app = buildApi(cfg, makeChain(cfg), sql);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  api = new FacilitatorApi(baseUrl);
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
  anvil?.kill("SIGTERM");
});

describe("public x402 facilitator", () => {
  it("lists USDG over EIP-3009 and ORRY over Permit2 through the proxy", async () => {
    const s = await api.supported();
    expect(s.feeBps).toBe(20);
    const byMethod = Object.fromEntries(s.kinds.map((k) => [k.extra.assetTransferMethod, k]));
    expect(byMethod.eip3009?.asset.toLowerCase()).toBe(usdg.toLowerCase());
    expect(byMethod.eip3009?.extra.name).toBe("Global Dollar");
    expect(byMethod.permit2?.asset.toLowerCase()).toBe(orry.toLowerCase());
    expect(byMethod.permit2?.extra.proxy?.toLowerCase()).toBe(proxy.toLowerCase());
    expect(s.kinds.every((k) => k.network === NETWORK)).toBe(true);
  });

  it("shows a merchant's payment address before it exists, and refuses payments to any other address", async () => {
    const m = await api.merchant(merchant());
    expect(m.created).toBe(false);
    expect(m.splitter).toBe(await splitterOf(merchant()));
    const direct = await api.verify(await usdgPayment(merchant(), 5n * USD));
    expect(direct).toMatchObject({ isValid: false, invalidReason: "pay_to_is_not_a_orrery_merchant" });
  });

  it("indexes the payment address once it is created", async () => {
    await send(c, ROLE.carol, factory, iMerchantSplitterFactoryAbi as Abi, "create", [merchant()]);
    await send(c, ROLE.carol, factory, iMerchantSplitterFactoryAbi as Abi, "create", [other()]);
    await catchUp();
    const m = await api.merchant(merchant());
    expect(m.created).toBe(true);
    expect(m.discountBps).toBe(2500);
    expect(m.badge).toBe(true);
    const rows = await sql<{ merchant: string }[]>`select merchant from merchants order by merchant`;
    expect(rows.map((r) => r.merchant).sort()).toEqual([merchant().toLowerCase(), other().toLowerCase()].sort());
  });

  it("settles USDG by EIP-3009 once, and answers a repeat with the same transaction", async () => {
    const to = await splitterOf(merchant());
    const req = await usdgPayment(to, 20n * USD);
    expect(await api.verify(req)).toMatchObject({ isValid: true, payer: payer() });
    const first = await api.settle(req);
    expect(first.success).toBe(true);
    expect(await balance(usdg, to)).toBe(20n * USD);
    const again = await api.settle(req);
    expect(again).toMatchObject({ success: true, transaction: first.transaction });
    expect(await balance(usdg, to)).toBe(20n * USD);
    expect(await api.verify(req)).toMatchObject({ isValid: false, invalidReason: "nonce_already_used" });
  });

  it("refuses a USDG authorization to another address, a short validity and an amount below the minimum", async () => {
    const to = await splitterOf(merchant());
    expect(await api.verify(await usdgPayment(to, 5n * USD, { to: other() }))).toMatchObject({ isValid: false, invalidReason: "wrong_recipient" });
    expect(await api.verify(await usdgPayment(to, 5n * USD, { validBefore: (await now()) + 30n }))).toMatchObject({ isValid: false, invalidReason: "expires_too_soon" });
    expect(await api.verify(await usdgPayment(to, 9_999n))).toMatchObject({ isValid: false, invalidReason: "amount_below_minimum" });
  });

  it("settles ORRY through Permit2 to the address the payer signed, once", async () => {
    const to = await splitterOf(merchant());
    const req = await orryPayment(to, 40n * E18);
    expect(await api.verify(req)).toMatchObject({ isValid: true, payer: payer() });
    const first = await api.settle(req);
    expect(first.success).toBe(true);
    expect(await balance(orry, to)).toBe(40n * E18);
    expect(await api.settle(req)).toMatchObject({ success: true, transaction: first.transaction });
    expect(await balance(orry, to)).toBe(40n * E18);

    // the same signature redirected to another merchant's payment address fails: the witness names the payee
    const elsewhere = await splitterOf(other());
    const moved: FacilitatorRequest = JSON.parse(JSON.stringify(await orryPayment(to, 1n * E18)));
    moved.paymentRequirements.payTo = elsewhere;
    moved.paymentPayload.accepted.payTo = elsewhere;
    moved.paymentPayload.payload.permit2Authorization!.witness.to = elsewhere;
    expect(await api.verify(moved)).toMatchObject({ isValid: false, invalidReason: "invalid_signature" });
  });

  it("forwards USDG with the fee to the treasury and ORRY with the fee burned, less the stake discount", async () => {
    const to = await splitterOf(merchant());
    const usdgBefore = await balance(usdg, merchant());
    const treasuryBefore = await balance(usdg, treasury());
    // the keeper forwards USDG at the minimum (10 USDG); ORRY waits for the age limit, so anyone forwards it here
    const sent = await forwardDue(cfg, makeChain(cfg), sql, anvilKey(ROLE.keeper));
    expect(sent.map((x) => [x.splitter.toLowerCase(), x.token.toLowerCase(), x.status])).toEqual([[to.toLowerCase(), usdg.toLowerCase(), "sent"]]);
    const usdgFee = (20n * USD * 20n * 7500n) / 100_000_000n; // 0.2% less 25% = 0.15%
    expect(await balance(usdg, merchant())).toBe(usdgBefore + 20n * USD - usdgFee);
    expect(await balance(usdg, treasury())).toBe(treasuryBefore + usdgFee);

    const supply = await read<bigint>(orry, mockOrryAbi as Abi, "totalSupply");
    const r = await send(c, ROLE.carol, to, iMerchantSplitterAbi as Abi, "forward", [orry]);
    const orryFee = (40n * E18 * 20n * 7500n) / 100_000_000n;
    expect(await balance(orry, merchant())).toBe(40n * E18 - orryFee);
    expect(await read<bigint>(orry, mockOrryAbi as Abi, "totalSupply")).toBe(supply - orryFee);
    const burned = parseEventLogs({ abi: iMerchantSplitterAbi as Abi, logs: r.logs, eventName: "Burned" }) as unknown as { args: { source: number; amount: bigint } }[];
    expect(burned.map((b) => [Number(b.args.source), b.args.amount])).toEqual([[7, orryFee]]);

    await catchUp();
    const ev = await sql<{ event: string }[]>`select event from facilitator_events where address = ${to.toLowerCase()} order by block_number, log_index`;
    expect(ev.map((e) => e.event)).toEqual(expect.arrayContaining(["Forwarded", "Burned"]));
    const [m] = await sql<{ last_forward_at: Date | null }[]>`select last_forward_at from merchants where merchant = ${merchant().toLowerCase()}`;
    expect(m?.last_forward_at).not.toBeNull();
    const burns = (await (await fetch(`${baseUrl}/v1/orry/burns?limit=5`)).json()) as { bySource: Record<string, string> };
    expect(BigInt(burns.bySource["7"] ?? "0")).toBe(orryFee);
    const view = await api.merchant(merchant());
    expect(view.settled30d.map((s) => [s.asset.toLowerCase(), s.payments])).toEqual(
      expect.arrayContaining([
        [usdg.toLowerCase(), 1],
        [orry.toLowerCase(), 1],
      ]),
    );
  });

  it("saves a profile signed by the merchant, refuses another signer, and lists only staked merchants", async () => {
    await api.saveProfile(c.wallet(ROLE.bob), merchant(), { name: "Weather API", url: "https://weather.example", description: "Forecasts per call." });
    await api.saveProfile(c.wallet(ROLE.carol), other(), { name: "No stake" });
    const n = (await (await fetch(`${baseUrl}/v1/merchants/profile/nonce?address=${merchant()}`)).json()) as { nonce: string; message: string };
    const w = c.wallet(ROLE.carol);
    const signature = await w.signMessage({ account: w.account, message: n.message });
    const forged = await fetch(`${baseUrl}/v1/merchants/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchant: merchant(), nonce: n.nonce, signature, name: "Taken over" }) });
    expect(forged.status).toBe(400);
    expect((await api.merchant(merchant())).profile).toMatchObject({ name: "Weather API", url: "https://weather.example" });
    const dir = await api.directory();
    expect(dir.merchants.map((m) => m.name)).toEqual(["Weather API"]);
  });

  it("gives the merchant the same tier on chain as the API reads", async () => {
    expect(await read<number>(CHAIN_TIERS, feeTiersAbi, "discountBps", [merchant()])).toBe(2500);
    expect(await read<bigint>(CHAIN_TIERS, feeTiersAbi, "stakeUsd", [merchant()])).toBe(200n * USD);
  });

  it("keeps a profile saved before the indexer has recorded the payment address", async () => {
    const late = c.address(ROLE.operator);
    await send(c, ROLE.operator, factory, iMerchantSplitterFactoryAbi as Abi, "create", [late]);
    await api.saveProfile(c.wallet(ROLE.operator), late, { name: "Early Shop" });
    const [early] = await sql<{ created_block: string; name: string }[]>`select created_block::text, name from merchants where merchant = ${late.toLowerCase()}`;
    expect(early).toMatchObject({ created_block: "0", name: "Early Shop" });
    await catchUp();
    const [row] = await sql<{ created_block: string; created_tx: string; name: string }[]>`select created_block::text, created_tx, name from merchants where merchant = ${late.toLowerCase()}`;
    expect(BigInt(row!.created_block)).toBeGreaterThan(0n);
    expect(row!.created_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row!.name).toBe("Early Shop");
    // a wallet with no payment address on chain is still refused
    const n = (await (await fetch(`${baseUrl}/v1/merchants/profile/nonce?address=${c.address(ROLE.agentOwner2)}`)).json()) as { nonce: string; message: string };
    const w = c.wallet(ROLE.agentOwner2);
    const signature = await w.signMessage({ account: w.account, message: n.message });
    const none = await fetch(`${baseUrl}/v1/merchants/profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchant: c.address(ROLE.agentOwner2), nonce: n.nonce, signature, name: "Nobody" }) });
    expect(none.status).toBe(404);
  });

  it("adds included checks a month from the stake value", async () => {
    expect(await stakeQuota(cfg, makeChain(cfg), merchant())).toBe(10_000);
    expect(await stakeQuota(cfg, makeChain(cfg), other())).toBe(0);
  });

  it("answers 404 on every facilitator route while it is held", async () => {
    await setRelease(sql, "facilitator", null, "test");
    expect((await fetch(`${baseUrl}/v1/x402/supported`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/merchants/${merchant()}`)).status).toBe(404);
    await setRelease(sql, "facilitator", new Date(0), "test");
    expect((await fetch(`${baseUrl}/v1/x402/supported`)).status).toBe(200);
  });
});
