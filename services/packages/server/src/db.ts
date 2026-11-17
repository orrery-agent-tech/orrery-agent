import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

/** Advisory lock key for migrations (any fixed number; one per database). */
const MIGRATION_LOCK = 727_271_015;

/**
 * Applies the migrations not yet recorded, in file order. Every service migrates on start, so they take turns under one
 * transaction-scoped advisory lock: concurrent starts (API, indexer, keeper, ...) never race on the same `create table`.
 */
export async function migrate(sql: Sql): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const done: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      await tx.unsafe(readFileSync(join(dir, file), "utf8"));
      await tx`insert into schema_migrations (name) values (${file})`;
      done.push(file);
    }
    return done;
  });
}
