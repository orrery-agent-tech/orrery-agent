import { MarketRelay, connect, loadConfig, loadRelayKey, makeChain, migrate } from "../index.js";

/**
 * Reveal relay process: sends `revealFor` for every order a trader queued through the API, in its batch's reveal
 * window. Sleeps until the next queued window opens (by chain time), then polls every `ORRERY_MARKET_KEEPER_POLL_MS`
 * (250). `--once` runs one pass, `--dry-run` simulates. Gas key: `ORRERY_RELAY_KEY_FILE`
 * (`~/.secrets/orrery/<network>-reveal-relay.json`, made only on the owner's word), anvil key 8 on chain 31337. Logs one
 * JSON line per pass that did something; never logs a key, an order or a salt.
 */
const cfg = loadConfig();
if (!cfg.markets) throw new Error("Set ORRERY_MARKET_FACTORY to run the reveal relay.");
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const relay = new MarketRelay(cfg, makeChain(cfg), sql, loadRelayKey());
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
const pollMs = Number(process.env.ORRERY_MARKET_KEEPER_POLL_MS ?? 250);

for (;;) {
  let wait = 30_000;
  try {
    const { now, steps } = await relay.passOnce({ dryRun });
    const shown = steps.map(({ market, batch, account, status, reason, txHash }) => ({ market, batch, account, status, reason, txHash }));
    if (shown.length || once) console.log(JSON.stringify({ at: new Date().toISOString(), chainId: cfg.chainId, steps: shown }));
    const s = Number(await relay.secondsUntilNext(now));
    wait = s <= 0 ? pollMs : Math.min(Math.max(s * 1000 - 500, pollMs), 30_000);
  } catch (e) {
    console.log(JSON.stringify({ at: new Date().toISOString(), error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
  }
  if (once) break;
  await new Promise((res) => setTimeout(res, wait));
}
await sql.end();
