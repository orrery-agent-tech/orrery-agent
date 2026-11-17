import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { ANVIL_PORT, PG_NAME, PG_PORT, RPC } from "./env.js";

/** Starts anvil and Postgres in Docker (ports in ./env.ts) for the integration tests, and stops both afterwards. */
let anvil: ChildProcess | undefined;
const PG = PG_NAME;

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("service did not start in time");
}

export async function setup(): Promise<void> {
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  try {
    execFileSync("docker", ["rm", "-f", PG], { stdio: "ignore" });
  } catch {}
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", PG, "-e", "POSTGRES_USER=orrery", "-e", "POSTGRES_PASSWORD=orrery",
    "-e", "POSTGRES_DB=orrery", "-p", `127.0.0.1:${PG_PORT}:5432`, "postgres:17-alpine",
  ], { stdio: "ignore" });
  await waitFor(async () => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  }, 20_000);
  await waitFor(async () => {
    execFileSync("docker", ["exec", PG, "pg_isready", "-U", "orrery", "-d", "orrery"], { stdio: "ignore" });
    return true;
  }, 60_000);
  await new Promise((r) => setTimeout(r, 1_000));
}

export async function teardown(): Promise<void> {
  anvil?.kill("SIGTERM");
  try {
    execFileSync("docker", ["stop", PG], { stdio: "ignore" });
  } catch {}
}
