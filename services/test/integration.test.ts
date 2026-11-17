import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  AgentClient,
  OrreryApi,
  operatorCalls,
  policyHash,
  signSessionConsent,
  verifyCheck,
  devUSDGAbi,
  orreryAttestorAbi,
  orreryLensAbi,
  orreryPolicyModuleAbi,
  mockAccount7579Abi,
  mockIdentityRegistryAbi,
  type Policy,
} from "@orrery/sdk";
import {
  buildApi,
  connect,
  indexOnce,
  lag,
  loadConfig,
  makeChain,
  migrate,
  safeFetch,
  settlePayment,
  resetHostLimiter,
  type Config,
  type Sql,
} from "@orrery/server";
import * as bytecode from "./generated/bytecode.js";
import { DATABASE_URL, RPC } from "./env.js";

const KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const pub = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
const w = (k: Hex) => createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(k) }) as WalletClient & { account: Account };
const deployer = w(KEYS[0]!);
const checkSignerAddr = privateKeyToAccount(KEYS[1]!).address;
const attesterAddr = privateKeyToAccount(KEYS[2]!).address;
const operator = w(KEYS[3]!);
const merchant = w(KEYS[4]!);
const treasury = privateKeyToAccount(KEYS[5]!).address;

async function send(wallet: WalletClient & { account: Account }, args: { address: Address; abi: Abi; functionName: string; args?: unknown[]; value?: bigint }) {
  const hash = await wallet.writeContract({ ...(args as object), chain: foundry, account: wallet.account } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return r;
}

async function deploy(abi: Abi, code: Hex, args: unknown[] = []): Promise<Address> {
  const hash = await deployer.deployContract({ abi, bytecode: code, args, chain: foundry, account: deployer.account });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
}

let registry: Address, usdg: Address, attestor: Address, moduleAddr: Address, lens: Address, account: Address;
let cfg: Config;
let sql: Sql;
let baseUrl: string;
let app: ReturnType<typeof buildApi>;
let agentKey: Hex;
let agent: AgentClient;
let site: Server;
let sitePort: number;
const agentId = 1n;

/** Operator acts through its account (MockAccount7579.execute). */
async function viaAccount(target: Address, data: Hex) {
  return send(operator, { address: account, abi: mockAccount7579Abi as Abi, functionName: "execute", args: [target, 0n, data] });
}

beforeAll(async () => {
  registry = await deploy(mockIdentityRegistryAbi as Abi, bytecode.mockIdentityRegistryBytecode);
  usdg = await deploy(devUSDGAbi as Abi, bytecode.devUSDGBytecode, [deployer.account.address]);
  attestor = await deploy(orreryAttestorAbi as Abi, bytecode.orreryAttestorBytecode, [registry, usdg, deployer.account.address, treasury, 5_000_000n]);
  moduleAddr = await deploy(orreryPolicyModuleAbi as Abi, bytecode.orreryPolicyModuleBytecode, [
    registry, attestor, "0x000000000022D473030F116dDEE9F6B43aC78BA3", "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", "0x7579EE8307284F293B1927136486880611F20002",
  ]);
  lens = await deploy(orreryLensAbi as Abi, bytecode.orreryLensBytecode, [moduleAddr, attestor, "0x7579EE8307284F293B1927136486880611F20002", [], []]);
  account = await deploy(mockAccount7579Abi as Abi, bytecode.mockAccount7579Bytecode, [operator.account.address]);

  await send(deployer, { address: attestor, abi: orreryAttestorAbi as Abi, functionName: "setCheckSigner", args: [checkSignerAddr, true] });
  await send(deployer, { address: attestor, abi: orreryAttestorAbi as Abi, functionName: "setAttester", args: [attesterAddr, true] });
  await send(operator, { address: registry, abi: mockIdentityRegistryAbi as Abi, functionName: "register", args: [operator.account.address] });
  await send(operator, { address: registry, abi: mockIdentityRegistryAbi as Abi, functionName: "setAgentWallet", args: [agentId, account] });
  await viaAccount(account, encodeFunctionData({ abi: mockAccount7579Abi, functionName: "installModule", args: [2n, moduleAddr, "0x"] }));
  for (const [to, amt] of [[account, 1_000_000_000n], [merchant.account.address, 100_000_000n], [operator.account.address, 100_000_000n]] as const) {
    await send(deployer, { address: usdg, abi: devUSDGAbi as Abi, functionName: "mint", args: [to, amt] });
  }

  agentKey = generatePrivateKey();
  const agentWallet = w(agentKey);
  await deployer.sendTransaction({ to: agentWallet.account.address, value: parseEther("1"), chain: foundry, account: deployer.account });
  agent = new AgentClient(agentWallet, pub, moduleAddr);

  const block = await pub.getBlock();
  const policy: Policy = {
    caps: [{ token: usdg, perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }],
    targets: [],
    validUntil: block.timestamp + 30n * 86400n,
    increaseDelay: 3600,
  };
  const consent = await signSessionConsent(agentWallet.account, { chainId: 31337, module: moduleAddr, account, agentId, policy });
  await viaAccount(moduleAddr, operatorCalls.openSession(agentId, agentWallet.account.address, policy, consent));
  const onchainHash = (await pub.readContract({ address: moduleAddr, abi: orreryPolicyModuleAbi, functionName: "getSession", args: [account, agentId] })).policyHash;
  expect(onchainHash).toBe(policyHash(policy));

  // a local site the prober can reach in this test (private addresses are only allowed on chain 31337)
  site = createServer((req, res) => {
    if (req.url === "/agent.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: "test agent",
        services: [{ name: "web", endpoint: `http://127.0.0.1:${sitePort}/svc` }],
        registrations: [{ agentRegistry: `eip155:31337:${registry}`, agentId: 1 }],
      }));
    } else if (req.url === "/svc") {
      res.writeHead(200).end("ok");
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  sitePort = (site.address() as AddressInfo).port;

  cfg = loadConfig({
    ORRERY_CHAIN_ID: "31337",
    ORRERY_RPC_URL: RPC,
    ORRERY_DATABASE_URL: DATABASE_URL,
    ORRERY_MODULE: moduleAddr,
    ORRERY_ATTESTOR: attestor,
    ORRERY_LENS: lens,
    ORRERY_REGISTRY: registry,
    ORRERY_USDG: usdg,
    ORRERY_TREASURY: treasury,
    ORRERY_CONFIRMATIONS: "1",
    ORRERY_PROBE_ALLOW_PRIVATE: "1",
    ORRERY_PUBLIC_URL: "http://127.0.0.1",
    // the first suite counts plain credits; "check pricing" below runs the R-58 tiers on its own config
    ORRERY_FREE_CHECKS_PER_MONTH: "0",
    ORRERY_CREDITS_PER_CHECK: "1",
  });
  sql = connect(cfg.databaseUrl);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrate(sql);
  app = buildApi(cfg, makeChain(cfg), sql);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
  site?.close();
});

describe("x402 credits", () => {
  let merchantKey: string | undefined;

  it("sells a pack over x402 and issues one API key", async () => {
    const r = await OrreryApi.buyCredits(baseUrl, merchant, pub);
    expect(r.credits).toBe("500");
    expect(r.apiKey).toMatch(/^or_/);
    merchantKey = r.apiKey;
    expect(await pub.readContract({ address: usdg, abi: devUSDGAbi, functionName: "balanceOf", args: [treasury] })).toBe(1_000_000n);
    const second = await OrreryApi.buyCredits(baseUrl, merchant, pub);
    expect(second.credits).toBe("1000");
    expect(second.apiKey).toBeUndefined();
  });

  it("an agent pays from its float, topped up within the caps", async () => {
    const res = await agent.x402Fetch(`${baseUrl}/v1/credits`, { method: "POST" });
    expect(res.status).toBe(200);
    const spent = await pub.readContract({ address: moduleAddr, abi: orreryPolicyModuleAbi, functionName: "spentToday", args: [account, agentId, usdg] });
    expect(spent).toBe(1_000_000n);
  });

  it("a replayed payment never grants twice", async () => {
    const chain = makeChain(cfg);
    const payer = new AgentClient(merchant, pub, ZERO);
    const req = (await import("@orrery/server")).requirements(cfg);
    const payload = await payer.signPayment(req, 31337);
    const a = await settlePayment(cfg, chain, sql, payload);
    const b = await settlePayment(cfg, chain, sql, payload);
    expect(a.ok && a.granted).toBe(true);
    expect(b.ok && !b.granted).toBe(true);
    const balance = await pub.readContract({ address: usdg, abi: devUSDGAbi, functionName: "balanceOf", args: [treasury] });
    expect(balance).toBe(4_000_000n); // 2 merchant packs + 1 agent pack + this one, charged once
  });

  it("a nonce already used on-chain is found and granted once", async () => {
    const chain = makeChain(cfg);
    const payer = new AgentClient(merchant, pub, ZERO);
    const req = (await import("@orrery/server")).requirements(cfg);
    const payload = await payer.signPayment(req, 31337);
    const a = payload.payload.authorization;
    const sig = payload.payload.signature;
    await send(deployer, {
      address: usdg,
      abi: devUSDGAbi as Abi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sig],
    });
    const out = await settlePayment(cfg, chain, sql, payload);
    expect(out.ok && out.granted).toBe(true);
  });

  it("checks the paying address and the signature verifies", async () => {
    const api = new OrreryApi(baseUrl, merchantKey);
    const res = await api.checkPayer(agent.signer);
    expect(res.extras.coverage).toContain("listed tokens");
    const v = await verifyCheck(pub, attestor, res, { now: BigInt(res.result.issuedAt as string), payer: agent.signer });
    expect(v.ok).toBe(true);
    expect(v.result.status).toBe(1);
    expect(v.result.caps[0]!.perDay).toBe(50_000_000n);
    // an unknown account kind gives no validity window
    expect(v.result.validUntil).toBe(v.result.issuedAt);
    const later = await verifyCheck(pub, attestor, res, { now: v.result.issuedAt + 1n });
    expect(later.ok).toBe(false);
    const wrongPayer = await verifyCheck(pub, attestor, res, { now: v.result.issuedAt, payer: merchant.account.address });
    expect(wrongPayer.reason).toBe("check names a different address");
  });

  it("credits never go below zero under parallel requests", async () => {
    await sql`update credit_accounts set credits = 3 where address = ${merchant.account.address.toLowerCase()}`;
    const api = new OrreryApi(baseUrl, merchantKey);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => api.checkPayer(agent.signer)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(3);
    const [row] = await sql`select credits from credit_accounts where address = ${merchant.account.address.toLowerCase()}`;
    expect(Number(row!.credits)).toBe(0);
  });

  it("rotates the key with a signed, single-use message", async () => {
    const n = (await (await fetch(`${baseUrl}/v1/keys/nonce?address=${merchant.account.address}`)).json()) as { nonce: string; message: string };
    const signature = await merchant.signMessage({ account: merchant.account, message: n.message });
    const r = await fetch(`${baseUrl}/v1/keys/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: merchant.account.address, nonce: n.nonce, signature }) });
    const body = (await r.json()) as { apiKey: string };
    expect(body.apiKey).toMatch(/^or_/);
    const replay = await fetch(`${baseUrl}/v1/keys/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: merchant.account.address, nonce: n.nonce, signature }) });
    expect(replay.status).toBe(401);
    const old = await fetch(`${baseUrl}/v1/credits`, { headers: { authorization: `Bearer ${merchantKey}` } });
    expect(old.status).toBe(401);
    merchantKey = body.apiKey;
    await sql`update credit_accounts set credits = 10 where address = ${merchant.account.address.toLowerCase()}`;
  });

  it("a signed sign-in opens a read session for the dashboard that reads the account and never checks", async () => {
    const who = merchant.account.address;
    const post = (path: string, body: unknown, auth?: string) =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    const n = (await (await fetch(`${baseUrl}/v1/account/nonce?address=${who}`)).json()) as { nonce: string; message: string };
    expect(n.message).toContain("spends no credits");
    const signature = await merchant.signMessage({ account: merchant.account, message: n.message });
    // a sign-in signature cannot rotate the key
    expect((await post("/v1/keys/rotate", { address: who, nonce: n.nonce, signature })).status).toBe(401);
    const opened = await post("/v1/account/session", { address: who, nonce: n.nonce, signature });
    const s = (await opened.json()) as { token: string; expiresAt: string };
    expect(opened.status).toBe(200);
    expect(s.token).toMatch(/^rcs_/);
    expect((await post("/v1/account/session", { address: who, nonce: n.nonce, signature })).status).toBe(401);
    const acct = (await (await fetch(`${baseUrl}/v1/account`, { headers: { authorization: `Bearer ${s.token}` } })).json()) as {
      address: string; credits: string; apiKey: { active: boolean }; purchases: { paidIn: string; credits: string; tx: string | null }[];
      usage: { daily: { checks: number }[]; monthly: { checks: number }[] };
    };
    expect(acct.address).toBe(who);
    expect(acct.credits).toBe("10");
    expect(acct.apiKey.active).toBe(true);
    expect(acct.purchases.length).toBeGreaterThan(0);
    expect(acct.purchases[0]!.paidIn).toBe("USDG");
    expect(acct.usage.monthly[0]!.checks).toBeGreaterThan(0);
    expect(acct.usage.daily[0]!.checks).toBeGreaterThan(0);
    // the API key reads the same account; the session cannot call a check
    expect((await fetch(`${baseUrl}/v1/account`, { headers: { authorization: `Bearer ${merchantKey}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/check/by-signer/${agent.signer}`, { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(401);
    await post("/v1/account/session/close", {}, s.token);
    expect((await fetch(`${baseUrl}/v1/account`, { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(401);
  });

  it("probes a verified agent, attests on-chain, and the check carries the probe", async () => {
    await send(operator, { address: registry, abi: mockIdentityRegistryAbi as Abi, functionName: "setTokenURI", args: [agentId, `http://127.0.0.1:${sitePort}/agent.json`] });
    await send(operator, { address: usdg, abi: devUSDGAbi as Abi, functionName: "approve", args: [attestor, 5_000_000n] });
    await send(operator, { address: attestor, abi: orreryAttestorAbi as Abi, functionName: "payVerification", args: [agentId, operator.account.address, 5_000_000n] });
    resetHostLimiter();
    const api = new OrreryApi(baseUrl, merchantKey);
    const res = await api.checkPayer(agent.signer);
    const v = await verifyCheck(pub, attestor, res, { now: BigInt(res.result.issuedAt as string) });
    expect(v.ok).toBe(true);
    expect(v.result.verified).toBe(true);
    expect(v.result.registrationValid).toBe(true);
    expect(v.result.endpointsLive).toBe(true);
    expect(v.result.domainVerified).toBe(true);
    const att = await pub.readContract({ address: attestor, abi: orreryAttestorAbi, functionName: "getAttestation", args: [agentId] });
    expect(att.endpointsLive).toBe(true);
    expect(att.attester).toBe(attesterAddr);
  });

  it("the prober refuses private addresses outside the local test chain", async () => {
    await expect(safeFetch(`http://127.0.0.1:${sitePort}/agent.json`)).rejects.toThrow(/https only/);
    await expect(safeFetch(`https://127.0.0.1:${sitePort}/agent.json`)).rejects.toThrow();
    await expect(safeFetch("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/non-public/);
    await expect(safeFetch("https://[::ffff:127.0.0.1]/")).rejects.toThrow(/non-public/);
    await expect(safeFetch("https://user:pw@example.com/")).rejects.toThrow(/credentials/);
  });

  it("indexes the module and attestor events with lag against the head", async () => {
    const chain = makeChain(cfg);
    let r;
    do r = await indexOnce(cfg, chain, sql, { startBlock: 0n, range: 50n });
    while (r.lag > 0n);
    const events = await sql<{ event: string }[]>`select distinct event from chain_events`;
    const names = events.map((e) => e.event);
    for (const e of ["SessionOpened", "PolicySet", "ToppedUp", "VerificationPaid", "Attested", "CheckSignerSet"]) expect(names).toContain(e);
    const l = await lag(sql);
    expect(l?.lag).toBe(0n);
  });
});

describe("check pricing (R-58)", () => {
  let api2: ReturnType<typeof buildApi>;
  let url2: string;
  let cfg2: Config;
  const buyer = w(generatePrivateKey());
  const platform = w(generatePrivateKey());
  const keys: Record<string, string> = {};

  beforeAll(async () => {
    cfg2 = loadConfig({
      ORRERY_CHAIN_ID: "31337",
      ORRERY_RPC_URL: RPC,
      ORRERY_DATABASE_URL: DATABASE_URL,
      ORRERY_MODULE: moduleAddr,
      ORRERY_ATTESTOR: attestor,
      ORRERY_LENS: lens,
      ORRERY_REGISTRY: registry,
      ORRERY_USDG: usdg,
      ORRERY_TREASURY: treasury,
      ORRERY_CONFIRMATIONS: "1",
      ORRERY_PUBLIC_URL: "http://127.0.0.1",
      ORRERY_FREE_CHECKS_PER_MONTH: "2",
      ORRERY_VOLUME_CHECKS: "4",
      ORRERY_PLAN_PRICE: "3000000",
      ORRERY_PLAN_CREDITS: "7",
    });
    api2 = buildApi(cfg2, makeChain(cfg2), sql);
    await api2.listen({ port: 0, host: "127.0.0.1" });
    url2 = `http://127.0.0.1:${(api2.server.address() as AddressInfo).port}`;
    for (const who of [buyer, platform]) await send(deployer, { address: usdg, abi: devUSDGAbi as Abi, functionName: "mint", args: [who.account.address, 20_000_000n] });
  });
  afterAll(async () => {
    await api2?.close();
  });

  async function signIn(who: WalletClient & { account: Account }): Promise<string> {
    const n = (await (await fetch(`${url2}/v1/keys/nonce?address=${who.account.address}`)).json()) as { nonce: string; message: string };
    const signature = await who.signMessage({ account: who.account, message: n.message });
    const r = await fetch(`${url2}/v1/keys/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: who.account.address, nonce: n.nonce, signature }) });
    return ((await r.json()) as { apiKey: string }).apiKey;
  }
  const check = (key: string) => fetch(`${url2}/v1/check/by-signer/${agent.signer}`, { headers: { authorization: `Bearer ${key}` } });
  const account2 = async (key: string) =>
    (await (await fetch(`${url2}/v1/credits`, { headers: { authorization: `Bearer ${key}` } })).json()) as {
      credits: string; checkCost: number; planUntil: string | null; month: { checks: number; freeChecks: number; freeChecksLeft: number };
    };

  it("publishes the tiers", async () => {
    const p = (await (await fetch(`${url2}/v1/pricing`)).json()) as Record<string, unknown>;
    expect(p).toMatchObject({ packPrice: "1000000", packSize: 500, freeChecksPerMonth: 2, creditsPerCheck: 2, volumeCreditsPerCheck: 1, volumeChecks: 4, checksPerMinute: 120 });
    expect(p.plan).toEqual({ price: "3000000", credits: 7, days: 30, checksPerMinute: 1200 });
  });

  it("a new address signs in for a free key and uses its monthly allowance first", async () => {
    keys.buyer = await signIn(buyer);
    expect(keys.buyer).toMatch(/^or_/);
    expect(await account2(keys.buyer)).toMatchObject({ credits: "0", checkCost: 2, planUntil: null, month: { checks: 0, freeChecks: 0, freeChecksLeft: 2 } });
    for (let i = 0; i < 2; i++) {
      const r = await check(keys.buyer);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-orrery-check-credits")).toBe("0");
    }
    const out = await check(keys.buyer);
    expect(out.status).toBe(402);
    expect(((await out.json()) as { error: string }).error).toMatch(/Included checks and credits are used up/);
  });

  it("credits pay 2 a check, 1 past the monthly volume", async () => {
    const bought = await OrreryApi.buyCredits(url2, buyer, pub);
    expect(bought.credits).toBe("500");
    const costs = [];
    for (let i = 0; i < 3; i++) {
      const r = await check(keys.buyer!);
      expect(r.status).toBe(200);
      costs.push(r.headers.get("x-orrery-check-credits"));
    }
    expect(costs).toEqual(["2", "2", "1"]); // checks 3 and 4 of the month at 2, check 5 past the volume of 4 at 1
    expect(await account2(keys.buyer!)).toMatchObject({ credits: "495", checkCost: 1, month: { checks: 5, freeChecks: 2, freeChecksLeft: 0 } });
  });

  it("the plan costs its price, adds its credits, makes every check 1 credit, and a second plan extends it", async () => {
    keys.platform = await signIn(platform);
    const before = await pub.readContract({ address: usdg, abi: devUSDGAbi, functionName: "balanceOf", args: [treasury] });
    const plan = await OrreryApi.buyCredits(url2, platform, pub, "plan");
    expect(plan.credits).toBe("7");
    const until = Date.parse(plan.planUntil!);
    expect(Math.abs(until - (Date.now() + 30 * 86_400_000))).toBeLessThan(120_000);
    expect(await pub.readContract({ address: usdg, abi: devUSDGAbi, functionName: "balanceOf", args: [treasury] })).toBe(before + 3_000_000n);
    for (let i = 0; i < 2; i++) expect((await check(keys.platform)).headers.get("x-orrery-check-credits")).toBe("0");
    const paid = await check(keys.platform);
    expect(paid.headers.get("x-orrery-check-credits")).toBe("1"); // 2 checks this month, under the volume, still 1 with the plan
    expect(await account2(keys.platform)).toMatchObject({ credits: "6", checkCost: 1 });
    const again = await OrreryApi.buyCredits(url2, platform, pub, "plan");
    expect(Date.parse(again.planUntil!) - until).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(again.credits).toBe("13");
  });

  it("the daily cap on free checks moves them to credits, and a key with neither gets 402", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fresh = w(generatePrivateKey());
    const key = await signIn(fresh);
    await sql`update check_days set free_checks = ${cfg2.pricing.freeChecksPerDay} where day = ${today}`;
    try {
      expect((await check(key)).status).toBe(402);
      await sql`update credit_accounts set credits = 2 where address = ${fresh.account.address.toLowerCase()}`;
      const r = await check(key);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-orrery-check-credits")).toBe("2");
    } finally {
      await sql`update check_days set free_checks = 0 where day = ${today}`;
    }
  });

  it("parallel checks never spend more than the free allowance plus the credits", async () => {
    const fresh = w(generatePrivateKey());
    const key = await signIn(fresh);
    await sql`update credit_accounts set credits = 5 where address = ${fresh.account.address.toLowerCase()}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => check(key)));
    // 2 free, then 2 + 2 credits for checks 3 and 4, then 1 credit for check 5 past the volume of 4: 5 checks, 0 credits
    expect(results.filter((r) => r.status === 200).length).toBe(5);
    expect(results.filter((r) => r.status === 402).length).toBe(5);
    expect(await account2(key)).toMatchObject({ credits: "0", month: { checks: 5, freeChecks: 2 } });
  });
});
