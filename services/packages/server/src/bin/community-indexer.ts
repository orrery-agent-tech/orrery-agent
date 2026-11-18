import { connect, loadConfig, makeChain, migrate } from "../index.js";
import { runCommunityIndexer } from "../community-indexer.js";

// Lane L1: the community indexer as its own process (the main indexer process is unchanged).
const cfg = loadConfig();
if (!cfg.community) {
  console.error("ORRERY_COMMUNITY_POOL is not set: nothing to index.");
  process.exit(0);
}
const sql = connect(cfg.databaseUrl);
await migrate(sql);
await runCommunityIndexer(cfg, makeChain(cfg), sql, undefined, (m) => console.error(m));
