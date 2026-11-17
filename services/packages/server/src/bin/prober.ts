import { attestIfNeeded, connect, loadConfig, loadProbe, makeChain, migrate, probeAgent, storeProbe } from "../index.js";

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const chain = makeChain(cfg);
const everyMs = Number(process.env.ORRERY_PROBE_EVERY_MS ?? 6 * 3600_000);

/** Every 6 hours: probe every agent that paid verification (from the indexer's VerificationPaid events). */
for (;;) {
  const rows = await sql<{ agent_id: string }[]>`select distinct (args->>'agentId') as agent_id from chain_events where event = 'VerificationPaid'`;
  for (const r of rows) {
    const id = BigInt(r.agent_id);
    try {
      const prev = await loadProbe(sql, id);
      const p = await probeAgent(cfg, chain, id);
      await storeProbe(sql, p);
      await attestIfNeeded(cfg, chain, sql, p, prev);
    } catch (e) {
      console.error("probe failed", r.agent_id, e instanceof Error ? e.message : e);
    }
  }
  await new Promise((res) => setTimeout(res, everyMs));
}
