import { connect, loadConfig, makeChain, migrate } from "../index.js";
import { R2Keeper } from "../r2-keeper.js";
import { loadR2KeeperKey } from "../r2-config.js";

/**
 * Lane L3 keeper process: settles prediction markets after their close, fills stored limit orders whose simulation
 * passes, refreshes and flushes the paymasters. One pass every `ORRERY_R2_KEEPER_POLL_MS` (15,000). `--once` runs one
 * pass and exits, `--dry-run` simulates without sending. Logs one JSON line per pass that did something; never the key.
 */
const cfg = loadConfig();
if (!cfg.r2) throw new Error("Set ORRERY_PREDICT_FACTORY, ORRERY_LIMIT_BOOK or ORRERY_PAYMASTERS to run the R2 keeper.");
const sql = cfg.r2.limitBook ? connect(cfg.databaseUrl) : null;
if (sql) await migrate(sql);
const keeper = new R2Keeper(cfg.r2, makeChain(cfg), loadR2KeeperKey(), sql);
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
const pollMs = Number(process.env.ORRERY_R2_KEEPER_POLL_MS ?? 15_000);
for (;;) {
  try {
    const steps = await keeper.passOnce({ dryRun });
    const acted = steps.filter((s) => s.status !== "skipped");
    if (acted.length || once) console.log(JSON.stringify({ at: new Date().toISOString(), chainId: cfg.chainId, steps: once ? steps : acted }));
  } catch (e) {
    console.log(JSON.stringify({ at: new Date().toISOString(), error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
  }
  if (once) break;
  await new Promise((res) => setTimeout(res, pollMs));
}
await sql?.end();
