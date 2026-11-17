import { connect, loadConfig, makeChain, migrate } from "../index.js";
import { loadDataKeeperKey } from "../data-config.js";
import { runDataKeeper } from "../data-keeper.js";

/** Lane L2 data keeper: `split()` and provider forwards, with its own gas key (ORRERY_DATA_KEEPER_KEY). */
const cfg = loadConfig();
if (!cfg.data) throw new Error("Orrery Data needs ORRERY_DATA_SIGNER_KEY (or the local chain 31337)");
const sql = connect(cfg.databaseUrl);
await migrate(sql);
await runDataKeeper(cfg, makeChain(cfg), sql, loadDataKeeperKey(), Number(process.env.ORRERY_DATA_KEEPER_EVERY_MS ?? 300_000), undefined, (m) => console.error(m));
