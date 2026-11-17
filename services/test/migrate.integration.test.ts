import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { connect, migrate, type Sql } from "@orrery/server";
import { DATABASE_URL } from "./env.js";

/** Every service runs `migrate` on start; on a fresh database they start together (found on 46630, 2026-11-11). */
const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(join(here, "../packages/server/migrations")).filter((f) => f.endsWith(".sql"));
const pools: Sql[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe("migrations", () => {
  it("run once when six services start at the same time on a fresh database", async () => {
    const admin = connect(DATABASE_URL);
    pools.push(admin);
    await admin`drop schema public cascade`;
    await admin`create schema public`;
    for (let i = 0; i < 6; i++) pools.push(connect(DATABASE_URL));
    const results = await Promise.all(pools.slice(1).map((p) => migrate(p)));
    expect(results.flat().sort()).toEqual([...files].sort());
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from schema_migrations`;
    expect(row?.n).toBe(files.length);
    expect(await migrate(admin)).toEqual([]);
  });
});
