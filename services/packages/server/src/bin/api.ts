import { buildApi, connect, loadConfig, makeChain, migrate } from "../index.js";

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);
await migrate(sql);
const app = buildApi(cfg, makeChain(cfg), sql);
await app.listen({ port: cfg.port, host: "0.0.0.0" });
console.log(`orrery api on :${cfg.port}, chain ${cfg.chainId}`);
