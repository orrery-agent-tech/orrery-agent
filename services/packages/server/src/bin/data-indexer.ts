import { createServer } from "node:http";
import { chainHead, connect, loadConfig, makeChain, migrate } from "../index.js";
import { dataLag, runDataIndexer } from "../data-indexer.js";

/** Lane L2 data indexer. Health on lag against the live chain head; it stays `confirmations` behind by design. */
const cfg = loadConfig();
if (!cfg.data) throw new Error("Orrery Data needs ORRERY_DATA_SIGNER_KEY (or the local chain 31337)");
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const chain = makeChain(cfg);
const maxLag = BigInt(process.env.ORRERY_INDEXER_MAX_LAG ?? 600) + BigInt(cfg.confirmations);
createServer(async (_req, res) => {
  const head = await chainHead(chain).catch(() => null);
  const l = await dataLag(sql).catch(() => null);
  const lag = head !== null && l ? head - l.last : null;
  const ok = lag !== null && lag <= maxLag;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, head: head?.toString() ?? null, last: l?.last.toString() ?? null, lag: lag?.toString() ?? null }));
}).listen(Number(process.env.ORRERY_DATA_INDEXER_HEALTH_PORT ?? 8789));
await runDataIndexer(cfg, chain, sql, undefined, (m) => console.error(m));
