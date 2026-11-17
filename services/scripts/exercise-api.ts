/**
 * Exercises a running Orrery API against a 46630 deployment (live or fork):
 *   tsx scripts/exercise-api.ts --deployment ../deployments/46630.json --rpc <url> --api http://127.0.0.1:8787
 * Merchant buys a pack over x402, the agent pays from its float, the merchant checks the agent's paying address and
 * verifies the signature, and the indexer catches up from the deployment block.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentClient, OrreryApi, verifyCheck } from "@orrery/sdk";
import { connect, indexOnce, lag, loadConfig, makeChain, migrate } from "@orrery/server";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1]! : d!;
};
const dep = JSON.parse(readFileSync(arg("--deployment"), "utf8")) as Record<string, string>;
const RPC = arg("--rpc", dep.rpc);
const API = arg("--api", "http://127.0.0.1:8787");
const chain = defineChain({ id: 46630, name: "46630", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
const key = (role: string) => (JSON.parse(readFileSync(join(homedir(), ".secrets/orrery", `46630-${role}.json`), "utf8")) as { privateKey: Hex }).privateKey;
const w = (role: string) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(key(role)) }) as WalletClient & { account: Account };

const step = (s: string) => console.log(`\n== ${s}`);

step("merchant buys a pack over x402");
const bought = await OrreryApi.buyCredits(API, w("merchant"), pub);
console.log(`credits ${bought.credits}, key issued ${bought.apiKey ? "yes" : "no (existing key)"}`);
const apiKey = bought.apiKey ?? process.env.ORRERY_API_KEY;
if (!apiKey) throw new Error("No API key: set ORRERY_API_KEY from the first purchase.");

step("agent pays over x402 from its float");
const agent = new AgentClient(w("agent-signer"), pub, dep.module as Address);
const res = await agent.x402Fetch(`${API}/v1/credits`, { method: "POST" });
console.log(`agent purchase HTTP ${res.status}; allowance ${JSON.stringify((await agent.getAllowance()).map((a) => ({ remainingToday: a.remainingToday.toString(), float: a.floatHeadroom.toString() })))}`);

step("merchant checks the paying address and verifies the signature");
const api = new OrreryApi(API, apiKey);
const check = await api.checkPayer(agent.signer);
const v = await verifyCheck(pub, dep.attestor as Address, check, { now: BigInt(check.result.issuedAt as string), payer: agent.signer });
console.log(`signature ok ${v.ok}; status ${v.result.status}; verified ${v.result.verified}; registrationValid ${v.result.registrationValid}; endpointsLive ${v.result.endpointsLive}; spent today ${v.result.caps[0]?.spentToday}`);

step("indexer catches up from the deployment block");
const cfg = loadConfig(process.env);
const sql = connect(cfg.databaseUrl);
await migrate(sql);
let r;
let rounds = 0;
do {
  r = await indexOnce(cfg, makeChain(cfg), sql, { startBlock: BigInt(dep.deployBlock!), range: 10_000n, includeRegistry: false });
  rounds++;
} while (r.lag > 0n && rounds < 200);
const events = await sql<{ event: string; n: string }[]>`select event, count(*)::text as n from chain_events group by event order by event`;
console.log(`lag ${(await lag(sql))?.lag}; events ${events.map((e) => `${e.event}:${e.n}`).join(", ")}`);
await sql.end();
