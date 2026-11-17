// Lane L2 local walk: anvil with the data contracts, Postgres, the API with Orrery Data open, and a little real activity
// (a USDG pack, an ORRY pack split by the keeper, a listed provider paid once). Prints the web settings.
// Needs Postgres on ORRERY_DATABASE_URL (the walk uses the orrery-pg-l2 container). Stop with Ctrl+C.
//   npx tsx scripts/data-local-stack.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeFunctionResult, getAbiItem, keccak256, maxUint256, toFunctionSelector, toHex, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import {
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  decodeHeader,
  devUSDGAbi,
  encodeHeader,
  iDataProviderRegistryAbi,
  iOrreryHookAbi,
  poolManagerAbi,
  poolStateSlot,
  signPermit2Payment,
  transferWithAuthorizationTypes,
  type DataPaymentRequirements,
  type PaymentRequired,
  type PublicPaymentRequirements,
} from "@orrery/sdk";
import { buildApi, connect, loadConfig, makeChain, migrate, setRelease } from "@orrery/server";
import { devUSDGBytecode } from "../test/generated/bytecode.js";
import { merchantSplitterFactoryAbi, merchantSplitterFactoryBytecode, mockOrryAbi, mockOrryBytecode, x402Permit2ProxyAbi, x402Permit2ProxyBytecode } from "../test/generated/orry.js";
import { orryStandInAbi, orryStandInBytecode } from "../test/generated/standins.js";
import { dataFeeSplitterAbi, dataFeeSplitterBytecode, dataProviderRegistryAbi, dataProviderRegistryBytecode, dataStakeValueAbi, dataStakeValueBytecode, dataTreasuryAbi, dataTreasuryBytecode } from "../test/generated/data.js";
import { ROLE, anvilKey, clients, mine, send, startAnvil } from "../test/orry-system.js";
import { dataKeeperOnce } from "../packages/server/src/data-keeper.js";
import { indexDataOnce, resolvePaymentBlocks } from "../packages/server/src/data-indexer.js";

const here = dirname(fileURLToPath(import.meta.url));
const ANVIL = Number(process.env.WALK_ANVIL_PORT ?? 18629);
const API = Number(process.env.WALK_API_PORT ?? 18628);
const RPC = `http://127.0.0.1:${ANVIL}`;
const DB = process.env.ORRERY_DATABASE_URL ?? "postgres://orrery:orrery@127.0.0.1:55441/orrery";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USD = 1_000_000n;
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const HUB_POOL_ID: Hex = keccak256(toHex("walk-usdg-hub"));

const anvil = await startAnvil(ANVIL);
const c = clients(RPC);
const deploy = async (abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> => {
  const w = c.wallet(ROLE.deployer);
  const hash = await w.deployContract({ abi, bytecode, args, chain: foundry, account: w.account });
  return (await c.pub.waitForTransactionReceipt({ hash })).contractAddress!;
};
const answer = (to: Address, abi: Abi, fn: string, result: unknown) =>
  send(c, ROLE.deployer, to, orryStandInAbi as Abi, "setResponse", [toFunctionSelector(getAbiItem({ abi, name: fn }) as never), encodeFunctionResult({ abi, functionName: fn, result } as never)]);
const answerFor = (to: Address, abi: Abi, fn: string, args: unknown[], result: unknown) =>
  send(c, ROLE.deployer, to, orryStandInAbi as Abi, "setResponseFor", [
    (toFunctionSelector(getAbiItem({ abi, name: fn }) as never) + encodeAbiParameters((getAbiItem({ abi, name: fn }) as unknown as { inputs: never[] }).inputs, args as never).slice(2)) as Hex,
    encodeFunctionResult({ abi, functionName: fn, result } as never),
  ]);

const permit2Runtime = readFileSync(join(here, "../../contracts/test/facilitator/Permit2Code.sol"), "utf8").match(/hex"([0-9a-f]+)"/)![1]!;
await c.pub.request({ method: "anvil_setCode" as never, params: [PERMIT2, `0x${permit2Runtime}`] as never });
const treasury = c.address(ROLE.quoteSigner);
const usdg = await deploy(devUSDGAbi as Abi, devUSDGBytecode as Hex, [c.address(ROLE.deployer)]);
const orry = await deploy(mockOrryAbi as Abi, mockOrryBytecode as Hex);
const proxy = await deploy(x402Permit2ProxyAbi as Abi, x402Permit2ProxyBytecode as Hex, [PERMIT2]);
const dataTreasury = await deploy(dataTreasuryAbi as Abi, dataTreasuryBytecode as Hex, [c.address(ROLE.deployer)]);
const splitter = await deploy(dataFeeSplitterAbi as Abi, dataFeeSplitterBytecode as Hex, [orry, dataTreasury]);
const stakeValue = await deploy(dataStakeValueAbi as Abi, dataStakeValueBytecode as Hex);
const factory = await deploy(merchantSplitterFactoryAbi as Abi, merchantSplitterFactoryBytecode as Hex, [100, usdg, orry, treasury, "0x0000000000000000000000000000000000000000"]);
const registry = await deploy(dataProviderRegistryAbi as Abi, dataProviderRegistryBytecode as Hex, [stakeValue, factory, 100n * USD]);
const standIn = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
const hook = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
const pm = await deploy(orryStandInAbi as Abi, orryStandInBytecode as Hex);
await answer(hook, iOrreryHookAbi as Abi, "pairCount", 1n);
await answer(hook, iOrreryHookAbi as Abi, "pairAt", { quote: usdg, usdFeed: usdg, poolId: HUB_POOL_ID, orryIsCurrency0: false, initialized: true, registeredAt: 1n });
await answerFor(pm, poolManagerAbi as Abi, "extsload", [poolStateSlot(HUB_POOL_ID)], toHex(10_000_000n * Q96, { size: 32 }));
for (const r of [ROLE.alice, ROLE.bob, ROLE.carol]) await send(c, ROLE.deployer, usdg, devUSDGAbi as Abi, "mint", [c.address(r), 100n * USD]);
await send(c, ROLE.deployer, orry, mockOrryAbi as Abi, "transfer", [c.address(ROLE.carol), 10_000n * E18]);
await send(c, ROLE.carol, orry, mockOrryAbi as Abi, "approve", [PERMIT2, maxUint256]);

const env = {
  ORRERY_CHAIN_ID: "31337",
  ORRERY_RPC_URL: RPC,
  ORRERY_DATABASE_URL: DB,
  ORRERY_PORT: String(API),
  ORRERY_PUBLIC_URL: `http://127.0.0.1:${API}`,
  ORRERY_CORS_ORIGINS: "http://localhost:3202,http://127.0.0.1:3202",
  ORRERY_MODULE: standIn,
  ORRERY_ATTESTOR: standIn,
  ORRERY_LENS: standIn,
  ORRERY_REGISTRY: standIn,
  ORRERY_USDG: usdg,
  ORRERY_TREASURY: treasury,
  ORRERY_CONFIRMATIONS: "1",
  ORRERY_ORRY_TOKEN: orry,
  ORRERY_ORRY_HOOK: hook,
  ORRERY_ORRY_EARN_FACTORY: standIn,
  ORRERY_ORRY_STAKING: standIn,
  ORRERY_ORRY_ROUTER: standIn,
  ORRERY_ORRY_BUYBACK: standIn,
  ORRERY_ORRY_LENS: standIn,
  ORRERY_POOL_MANAGER: pm,
  ORRERY_ORRY_MIN_SAMPLES: "1",
  ORRERY_ORRY_FEATURES: "",
  ORRERY_SPLITTER_FACTORY: factory,
  ORRERY_X402_PERMIT2_PROXY: proxy,
  ORRERY_PERMIT2: PERMIT2,
  ORRERY_DATA_SPLITTER: splitter,
  ORRERY_DATA_REGISTRY: registry,
  ORRERY_DATA_PROVIDER_FACTORY: factory,
  ORRERY_DATA_SPLIT_MIN: "0",
};
const cfg = loadConfig(env);
const sql = connect(DB);
await sql`drop schema public cascade`;
await sql`create schema public`;
await migrate(sql);
const past = new Date(Date.now() - 1000);
for (const f of ["data", "data-providers", "mcp", "orry-x402", "facilitator"]) await setRelease(sql, f, past, "walk");
await sql`insert into orry_price_samples (sampled_at, block_number, hub_sqrt, usd_sqrt, ratio_num, ratio_den)
  values (now(), 1, ${(10_000_000n * Q96).toString()}, 0, ${((10_000_000n * Q96) ** 2n).toString()}, ${(1n << 192n).toString()})`;
const app = buildApi(cfg, makeChain(cfg), sql);
await app.listen({ port: API, host: "127.0.0.1" });
const base = `http://127.0.0.1:${API}`;

// activity: alice buys a USDG pack, carol an ORRY pack, bob lists as a provider and alice pays him once
const accepts = decodeHeader<PaymentRequired>((await fetch(`${base}/v1/data/packs`, { method: "POST" })).headers.get(HEADER_REQUIRED)!).accepts as unknown as DataPaymentRequirements[];
const now = (await c.pub.getBlock()).timestamp;
async function eip3009(role: number, payTo: Address, amount: bigint) {
  const w = c.wallet(role);
  const auth = { from: w.account.address, to: payTo, value: amount, validAfter: now - 60n, validBefore: now + 3600n, nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  const signature = await w.signTypedData({ account: w.account, domain: { name: "Global Dollar", version: "1", chainId: 31337, verifyingContract: usdg }, types: transferWithAuthorizationTypes, primaryType: "TransferWithAuthorization", message: auth });
  return { signature, authorization: { ...auth, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } };
}
const usdgReq = accepts.find((a) => a.extra.assetTransferMethod === "eip3009")!;
const bought = (await (await fetch(`${base}/v1/data/packs`, { method: "POST", headers: { [HEADER_SIGNATURE]: encodeHeader({ x402Version: 2, accepted: usdgReq, payload: await eip3009(ROLE.alice, usdgReq.payTo, BigInt(usdgReq.amount)) }) } })).json()) as { account: { apiKey: string; calls: string } };
const orryReq = accepts.find((a) => a.extra.assetTransferMethod === "permit2")!;
await fetch(`${base}/v1/data/packs`, { method: "POST", headers: { [HEADER_SIGNATURE]: encodeHeader(await signPermit2Payment(c.wallet(ROLE.carol), { chainId: 31337, requirements: orryReq as unknown as PublicPaymentRequirements, permit2: PERMIT2, proxy, deadline: now + 3600n })) } });
await send(c, ROLE.deployer, stakeValue, dataStakeValueAbi as Abi, "set", [c.address(ROLE.bob), 250n * USD]);
await send(c, ROLE.bob, registry, iDataProviderRegistryAbi as Abi, "list", ["https://feeds.example.org/v1/gas", "Gas Lens", "Per-block gas and fee curves for Robinhood Chain, refreshed every block.", 2000n]);
const bobSplitter = (await c.pub.readContract({ address: registry, abi: iDataProviderRegistryAbi as Abi, functionName: "splitterOf", args: [c.address(ROLE.bob)] })) as Address;
const chain = makeChain(cfg);
const catchUp = async () => {
  await mine({ pub: c.pub }, 2);
  await new Promise((r) => setTimeout(r, 4_500)); // viem caches the block number for 4 s
  for (let i = 0; i < 10; i++) await indexDataOnce(cfg, chain, sql);
  await resolvePaymentBlocks(chain, sql);
};
console.error("walk: provider listed and indexed");
await catchUp();
const preq = { scheme: "exact", network: "eip155:31337", amount: (3n * USD).toString(), asset: usdg, payTo: bobSplitter, maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" } };
await fetch(`${base}/v1/data/x402/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentRequirements: preq, paymentPayload: { x402Version: 2, accepted: preq, payload: await eip3009(ROLE.alice, bobSplitter, 3n * USD) } }) });
console.error("walk: provider paid");
console.error("walk: keeper", JSON.stringify(await dataKeeperOnce(cfg, chain, sql, anvilKey(ROLE.keeper))));
await catchUp();
console.error("walk: indexed");

console.log(`\nAPI ${base}  (anvil ${RPC}, Postgres ${DB.replace(/:[^:@/]+@/, ":***@")})`);
console.log(`API key of the walk payer (local anvil only): ${bought.account.apiKey}`);
console.log("web settings:");
console.log(`NEXT_PUBLIC_API_URL=${base} NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_RPC_URL=${RPC} NEXT_PUBLIC_USDG=${usdg} NEXT_PUBLIC_DATA_REGISTRY=${registry}`);
process.on("SIGINT", async () => {
  await app.close();
  await sql.end();
  anvil.kill("SIGTERM");
  process.exit(0);
});
