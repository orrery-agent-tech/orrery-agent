/**
 * Local development stack: deploys the contracts to anvil (ORRERY_SEED_RPC, default :8546), registers one agent,
 * binds a development account to it, opens a session for a fresh signer, mints DevUSDG, and writes the env files for the
 * API (.local/api.env) and the web app (packages/web/.env.local). Development only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseEther, type Abi, type Account, type Address, type Hex, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { devUSDGAbi, orreryAttestorAbi, orreryLensAbi, orreryPolicyModuleAbi, mockAccount7579Abi, mockIdentityRegistryAbi } from "@orrery/shared";
import { operatorCalls, signSessionConsent, type Policy } from "@orrery/sdk";
import * as bytecode from "../test/generated/bytecode.js";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.ORRERY_SEED_RPC ?? "http://127.0.0.1:8546";
const KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const w = (k: Hex) => createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(k) }) as WalletClient & { account: Account };
const deployer = w(KEYS[0]!);
const operator = w(KEYS[3]!);
const merchant = privateKeyToAccount(KEYS[4]!).address;
const treasury = privateKeyToAccount(KEYS[5]!).address;

async function send(wallet: WalletClient & { account: Account }, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, chain: foundry, account: wallet.account } as never);
  await pub.waitForTransactionReceipt({ hash });
}
async function deploy(abi: Abi, code: Hex, args: unknown[] = []): Promise<Address> {
  const hash = await deployer.deployContract({ abi, bytecode: code, args, chain: foundry, account: deployer.account });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}

const registry = await deploy(mockIdentityRegistryAbi as Abi, bytecode.mockIdentityRegistryBytecode);
const usdg = await deploy(devUSDGAbi as Abi, bytecode.devUSDGBytecode, [deployer.account.address]);
const attestor = await deploy(orreryAttestorAbi as Abi, bytecode.orreryAttestorBytecode, [registry, usdg, deployer.account.address, treasury, 5_000_000n]);
const adapter = "0x7579EE8307284F293B1927136486880611F20002";
const module = await deploy(orreryPolicyModuleAbi as Abi, bytecode.orreryPolicyModuleBytecode, [
  registry, attestor, "0x000000000022D473030F116dDEE9F6B43aC78BA3", "0x0000000071727De22E5E9d8BAf0edAc6f37da032", "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", adapter,
]);
const lens = await deploy(orreryLensAbi as Abi, bytecode.orreryLensBytecode, [module, attestor, adapter, [], []]);
const account = await deploy(mockAccount7579Abi as Abi, bytecode.mockAccount7579Bytecode, [operator.account.address]);

await send(deployer, attestor, orreryAttestorAbi as Abi, "setCheckSigner", [privateKeyToAccount(KEYS[1]!).address, true]);
await send(deployer, attestor, orreryAttestorAbi as Abi, "setAttester", [privateKeyToAccount(KEYS[2]!).address, true]);
await send(operator, registry, mockIdentityRegistryAbi as Abi, "register", [operator.account.address]);
await send(operator, registry, mockIdentityRegistryAbi as Abi, "setAgentWallet", [1n, account]);
await send(operator, account, mockAccount7579Abi as Abi, "execute", [account, 0n, encodeFunctionData({ abi: mockAccount7579Abi, functionName: "installModule", args: [2n, module, "0x"] })]);
for (const [to, amt] of [[account, 1_000_000_000n], [merchant, 100_000_000n], [operator.account.address, 100_000_000n]] as const) {
  await send(deployer, usdg, devUSDGAbi as Abi, "mint", [to, amt]);
}

const signerKey = generatePrivateKey();
const signer = privateKeyToAccount(signerKey);
await deployer.sendTransaction({ to: signer.address, value: parseEther("1"), chain: foundry, account: deployer.account });
const now = (await pub.getBlock()).timestamp;
const policy: Policy = { caps: [{ token: usdg, perTx: 10_000_000n, perDay: 50_000_000n, floatMax: 20_000_000n }], targets: [], validUntil: now + 30n * 86400n, increaseDelay: 3600 };
const consent = await signSessionConsent(signer, { chainId: 31337, module, account, agentId: 1n, policy });
await send(operator, account, mockAccount7579Abi as Abi, "execute", [module, 0n, operatorCalls.openSession(1n, signer.address, policy, consent)]);
// one top-up so the record shows spend today
const agentWallet = w(signerKey);
await send(agentWallet, module, orreryPolicyModuleAbi as Abi, "topUp", [usdg, 3_500_000n]);

mkdirSync(join(here, "../.local"), { recursive: true });
writeFileSync(
  join(here, "../.local/api.env"),
  [
    "ORRERY_CHAIN_ID=31337", `ORRERY_RPC_URL=${RPC}`, `ORRERY_MODULE=${module}`, `ORRERY_ATTESTOR=${attestor}`, `ORRERY_LENS=${lens}`,
    `ORRERY_REGISTRY=${registry}`, `ORRERY_USDG=${usdg}`, `ORRERY_TREASURY=${treasury}`, "ORRERY_CONFIRMATIONS=1", "ORRERY_PORT=8787",
    "ORRERY_PUBLIC_URL=http://127.0.0.1:8787",
  ].join("\n") + "\n",
);
writeFileSync(
  join(here, "../packages/web/.env.local"),
  [
    "NEXT_PUBLIC_CHAIN_ID=31337", `NEXT_PUBLIC_RPC_URL=${RPC}`, "NEXT_PUBLIC_API_URL=http://127.0.0.1:8787", `NEXT_PUBLIC_MODULE=${module}`,
    `NEXT_PUBLIC_ATTESTOR=${attestor}`, `NEXT_PUBLIC_LENS=${lens}`, `NEXT_PUBLIC_REGISTRY=${registry}`, `NEXT_PUBLIC_USDG=${usdg}`,
  ].join("\n") + "\n",
);
writeFileSync(join(here, "../.local/seed.json"), JSON.stringify({ module, attestor, lens, registry, usdg, account, signer: signer.address, signerKey, operator: operator.account.address, merchant, treasury }, null, 2));
console.log(JSON.stringify({ module, lens, account, signer: signer.address, operator: operator.account.address, merchant }, null, 2));
