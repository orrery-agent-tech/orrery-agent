import { connect, forwardDue, loadConfig, loadKeeperKey, makeChain, runKeeperOnce } from "../index.js";

/**
 * ORRY keeper process, and the merchant forwarder: with the facilitator set and no ORRY yet (USDG-only, 2026-11-17)
 * it runs only the forward pass. Hourly by default (`ORRERY_KEEPER_EVERY_MS`); `--once` runs one pass and exits, `--dry-run`
 * simulates without sending. Gas key: `ORRERY_KEEPER_KEY_FILE` (`~/.secrets/orrery/<network>-keeper.json`, made only
 * on the owner's word), anvil key 6 on chain 31337. Logs one JSON line per pass; never logs the key.
 */
const cfg = loadConfig();
if (!cfg.orry && !cfg.facilitator) throw new Error("Set the ORRY contract addresses (ORRERY_ORRY_TOKEN and the rest) or the facilitator (ORRERY_SPLITTER_FACTORY) to run the keeper.");
const key = loadKeeperKey();
const chain = makeChain(cfg);
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
const everyMs = Number(process.env.ORRERY_KEEPER_EVERY_MS ?? 3_600_000);

// Wave 3: the same pass forwards what merchants' splitters hold (facilitator-public.ts), when the facilitator is set.
const sql = cfg.facilitator ? connect(cfg.databaseUrl) : null;

for (;;) {
  const steps = !cfg.orry ? undefined : await runKeeperOnce(cfg, chain, key, { dryRun }).catch((e: unknown) => [{ error: e instanceof Error ? e.message.split("\n")[0] : String(e) }]);
  const forwards = sql ? await forwardDue(cfg, chain, sql, key, dryRun).catch((e: unknown) => [{ error: e instanceof Error ? e.message.split("\n")[0] : String(e) }]) : undefined;
  console.log(JSON.stringify({ at: new Date().toISOString(), chainId: cfg.chainId, steps, forwards }));
  if (once) break;
  await new Promise((res) => setTimeout(res, everyMs));
}
