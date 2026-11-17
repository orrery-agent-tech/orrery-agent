import { parseAbi, type Abi, type Address, type Hex } from "viem";
import { iDataFeeSplitterAbi, iMerchantSplitterAbi } from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";

/**
 * Lane L2 keeper (D-15, its own gas key): calls `DataFeeSplitter.split()` once enough ORRY arrived (or any after
 * `maxAgeHours`, or when a booking waits for a set pool), and forwards third-party providers' splitters as the wave 3
 * keeper forwards merchants'. Both calls are open to anyone; the keeper only saves people the trouble.
 */

const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface KeeperStep {
  target: string;
  action: string;
  status: string;
}

export async function dataKeeperOnce(cfg: Config, chain: Chain, sql: Sql, key: Hex, dryRun = false): Promise<KeeperStep[]> {
  const d = cfg.data!;
  const out: KeeperStep[] = [];
  const wallet = chain.wallet(key);
  const send = async (target: Address, abi: Abi, functionName: string, args: unknown[], action: string): Promise<boolean> => {
    if (dryRun) {
      out.push({ target, action, status: "due" });
      return false;
    }
    try {
      const hash = await wallet.writeContract({ address: target, abi, functionName, args, chain: null, account: wallet.account } as never);
      const rc = await chain.public.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs });
      out.push({ target, action, status: rc.status === "success" ? "sent" : "reverted" });
      return rc.status === "success";
    } catch (e) {
      out.push({ target, action, status: `failed: ${String(e).slice(0, 120)}` });
      return false;
    }
  };

  if (d.splitter) {
    const [received, , , owedAfter] = (await chain.public.readContract({ address: d.splitter, abi: iDataFeeSplitterAbi as Abi, functionName: "previewSplit" })) as bigint[];
    const [pool, owed] = await Promise.all([
      chain.public.readContract({ address: d.splitter, abi: iDataFeeSplitterAbi as Abi, functionName: "pool" }) as Promise<Address>,
      chain.public.readContract({ address: d.splitter, abi: iDataFeeSplitterAbi as Abi, functionName: "poolOwed" }) as Promise<bigint>,
    ]);
    const [last] = await sql<{ t: Date | null }[]>`select max(block_time) as t from data_events where source = 'splitter' and event = 'Split'`;
    const old = Date.now() - (last?.t?.getTime() ?? 0) > d.maxAgeHours * 3_600_000;
    const poolWaiting = !/^0x0{40}$/i.test(pool) && owed > 0n && owedAfter === 0n;
    if (received! >= d.splitMinOrry || (received! > 0n && old) || poolWaiting) await send(d.splitter, iDataFeeSplitterAbi as Abi, "split", [], "split");
  }

  const tokens = [cfg.addresses.usdg, ...(cfg.orry ? [cfg.orry.token] : [])];
  const rows = await sql<{ splitter: string; last_forward_at: Date | null; listed_at: Date }[]>`select splitter, last_forward_at, listed_at from data_providers`;
  for (const r of rows) {
    const since = (r.last_forward_at ?? r.listed_at).getTime();
    const old = Date.now() - since > d.maxAgeHours * 3_600_000;
    for (const token of tokens) {
      const bal = (await chain.public.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [r.splitter as Address] })) as bigint;
      const due = bal > 0n && (old || (token === cfg.addresses.usdg && bal >= d.forwardMinUsdg));
      if (!due) continue;
      if (await send(r.splitter as Address, iMerchantSplitterAbi as Abi, "forward", [token], `forward ${token}`)) {
        await sql`update data_providers set last_forward_at = now() where splitter = ${r.splitter}`;
      }
    }
  }
  return out;
}

export async function runDataKeeper(cfg: Config, chain: Chain, sql: Sql, key: Hex, everyMs = 300_000, signal?: AbortSignal, log: (m: string) => void = () => {}): Promise<void> {
  while (!signal?.aborted) {
    try {
      for (const s of await dataKeeperOnce(cfg, chain, sql, key)) log(`data keeper: ${s.action} ${s.target} ${s.status}`);
    } catch (e) {
      log(`data keeper step failed: ${String(e).slice(0, 200)}`);
    }
    await new Promise((res) => setTimeout(res, everyMs));
  }
}
