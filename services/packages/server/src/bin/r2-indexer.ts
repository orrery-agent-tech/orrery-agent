import { createServer } from "node:http";
import { chainHead, connect, lagBehind, loadConfig, makeChain, migrate } from "../index.js";
import { runR2Indexer } from "../r2-indexer.js";

/**
 * Lane L3 indexer process (prediction markets, limit order book, paymasters). Health keys on lag against the live chain
 * head (workspace rule 7), never on "backfill finished"; the cursor stays `confirmations` behind by design.
 */
const cfg = loadConfig();
if (!cfg.r2) throw new Error("Set ORRERY_PREDICT_FACTORY, ORRERY_LIMIT_BOOK or ORRERY_PAYMASTERS to run the R2 indexer.");
const r2 = cfg.r2;
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const chain = makeChain(cfg);
const maxLag = BigInt(process.env.ORRERY_INDEXER_MAX_LAG ?? 600);
createServer(async (_req, res) => {
  const head = await chainHead(chain).catch(() => null);
  const [s] = await sql<{ last_block: string; head_block: string }[]>`select last_block, head_block from indexer_state where id = 'r2'`;
  const lag = lagBehind(s ? { last: BigInt(s.last_block) } : null, head);
  const ok = lag !== null && lag <= maxLag + BigInt(cfg.confirmations);
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, head: head?.toString() ?? null, last: s?.last_block ?? null, lag: lag?.toString() ?? null }));
}).listen(Number(process.env.ORRERY_R2_INDEXER_HEALTH_PORT ?? 8791));
await runR2Indexer(r2, chain, sql, cfg.confirmations, undefined, (m) => console.error(m));
