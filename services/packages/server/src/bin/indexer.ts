import { createServer } from "node:http";
import { chainHead, connect, runFacilitatorIndexer, indexerHealth, lag, lagBehind, loadConfig, makeChain, marketsLag, migrate, orryLag, runIndexer, runMarketsIndexer, runOrryIndexer } from "../index.js";

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const chain = makeChain(cfg);
const maxLag = BigInt(process.env.ORRERY_INDEXER_MAX_LAG ?? 600); // blocks (about a minute at 101 ms)
// Health on lag against the live chain head, never on "backfill finished" and never on the head the indexer stored
// (it freezes with a stuck cursor). An unreadable head is unhealthy. The ORRY and markets cursors stay `confirmations`
// behind by design.
createServer(async (_req, res) => {
  const head = await chainHead(chain).catch(() => null);
  const l = await lag(sql);
  const r = cfg.orry ? await orryLag(sql) : null;
  const m = cfg.markets ? await marketsLag(sql) : null;
  const h = indexerHealth({ head, main: l, orry: r, orryOn: !!cfg.orry, maxLag, confirmations: cfg.confirmations });
  const marketsLagLive = lagBehind(m, head);
  const okMarkets = !cfg.markets || (marketsLagLive !== null && marketsLagLive <= maxLag + BigInt(cfg.confirmations));
  const ok = h.ok && okMarkets;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok,
      head: head?.toString() ?? null,
      last: l?.last.toString(),
      lag: h.mainLag?.toString() ?? null,
      orry: cfg.orry ? { ok: h.okOrry, last: r?.last.toString(), lag: h.orryLag?.toString() ?? null } : undefined,
      markets: cfg.markets ? { ok: okMarkets, last: m?.last.toString(), lag: marketsLagLive?.toString() ?? null } : undefined,
    }),
  );
}).listen(Number(process.env.ORRERY_INDEXER_HEALTH_PORT ?? 8788));
const runs = [runIndexer(cfg, chain, sql, { startBlock: BigInt(process.env.ORRERY_INDEXER_START_BLOCK ?? 0) })];
if (cfg.orry) runs.push(runOrryIndexer(cfg, chain, sql, undefined, (m) => console.error(m)));
if (cfg.markets) runs.push(runMarketsIndexer(cfg, chain, sql, undefined, (m) => console.error(m)));
if (cfg.facilitator) runs.push(runFacilitatorIndexer(cfg, chain, sql, undefined, (m) => console.error(m)));
await Promise.all(runs);
