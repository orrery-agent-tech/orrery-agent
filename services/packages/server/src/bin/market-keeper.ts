import { MarketKeeper, loadConfig, loadMarketKeeperKey, makeChain } from "../index.js";

/**
 * Market keeper process: clears every batch with revealed orders at the first block after its reveal window. Sleeps
 * until the next reveal window ends (by chain time), then polls the head every `ORRERY_MARKET_KEEPER_POLL_MS` (250)
 * until the clear goes through. `--once` runs one pass and exits, `--dry-run` simulates without sending. Gas key:
 * `ORRERY_MARKET_KEEPER_KEY_FILE` (`~/.secrets/orrery/<network>-market-keeper.json`, made only on the owner's word),
 * anvil key 7 on chain 31337. Logs one JSON line per pass that did something; never logs the key.
 */
const cfg = loadConfig();
if (!cfg.markets) throw new Error("Set ORRERY_MARKET_FACTORY to run the market keeper.");
const keeper = new MarketKeeper(cfg, makeChain(cfg), loadMarketKeeperKey());
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
const pollMs = Number(process.env.ORRERY_MARKET_KEEPER_POLL_MS ?? 250);

for (;;) {
  let wait = 30_000;
  try {
    const { now, steps } = await keeper.passOnce({ dryRun });
    if (steps.length || once) console.log(JSON.stringify({ at: new Date().toISOString(), chainId: cfg.chainId, steps }));
    const s = Number(keeper.secondsUntilNext(now));
    wait = s <= 0 ? pollMs : Math.min(Math.max(s * 1000 - 500, pollMs), 30_000);
  } catch (e) {
    console.log(JSON.stringify({ at: new Date().toISOString(), error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
  }
  if (once) break;
  await new Promise((res) => setTimeout(res, wait));
}
