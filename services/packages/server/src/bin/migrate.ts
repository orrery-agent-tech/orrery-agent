import { connect, loadConfig, migrate } from "../index.js";

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);
console.log("applied", await migrate(sql));
await sql.end();
