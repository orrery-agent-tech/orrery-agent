/**
 * The runtime release switch's only writer: there is no HTTP write route.
 *
 *   pnpm exec tsx scripts/releases.ts list
 *   pnpm exec tsx scripts/releases.ts set <feature> <time>      time: ISO 8601 with a zone (2026-11-09T13:00:00Z), now, or null
 *
 * `set` writes the row and an audit row in one transaction; null holds the feature again. The API reads the table per
 * request (cached for ORRERY_RELEASES_CACHE_MS), so no restart is needed. Reads ORRERY_DATABASE_URL; an empty table is
 * seeded first from ORRERY_ORRY_FEATURES or the chain default (ORRERY_CHAIN_ID: held on 4663, open elsewhere). The
 * audit names ORRERY_RELEASE_BY, else the OS user and host.
 */
import { hostname, userInfo } from "node:os";
import { RELEASE_FEATURES, parseOrryFeatures } from "@orrery/shared";
import { connect, migrate, seedReleases, setRelease } from "@orrery/server";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(raw: string): Date | null {
  if (raw === "null") return null;
  if (raw === "now") return new Date();
  if (!ISO_WITH_ZONE.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error(`"${raw}" is not a time: use ISO 8601 with a zone (2026-11-09T13:00:00Z), now, or null`);
  }
  return new Date(raw);
}

const usage = "usage: releases.ts list | releases.ts set <feature> <ISO time with zone|now|null>";

async function main(argv: string[]): Promise<number> {
  const [cmd, feature, time] = argv;
  if (cmd !== "list" && cmd !== "set") {
    console.error(usage);
    return 2;
  }
  if (cmd === "set") {
    if (!feature || time === undefined) {
      console.error(usage);
      return 2;
    }
    if (!(RELEASE_FEATURES as readonly string[]).includes(feature)) {
      console.error(`Unknown feature "${feature}". Use one of: ${RELEASE_FEATURES.join(", ")}.`);
      return 2;
    }
  }
  const opensAt = cmd === "set" ? parseTime(time!) : undefined;
  const url = process.env.ORRERY_DATABASE_URL;
  if (!url) {
    console.error("Set ORRERY_DATABASE_URL.");
    return 2;
  }
  const sql = connect(url);
  try {
    await migrate(sql);
    await seedReleases(sql, { chainId: Number(process.env.ORRERY_CHAIN_ID ?? 31337), explicit: parseOrryFeatures(process.env.ORRERY_ORRY_FEATURES) }, "seed (releases.ts)");
    if (cmd === "set") {
      const by = process.env.ORRERY_RELEASE_BY || `${userInfo().username}@${hostname()}`;
      await setRelease(sql, feature!, opensAt!, by);
    }
    const rows = await sql<{ feature: string; opens_at: Date | null; updated_by: string; updated_at: Date }[]>`select feature, opens_at,
      updated_by, updated_at from releases order by feature`;
    const now = Date.now();
    for (const r of rows) {
      const state = r.opens_at === null ? "held" : r.opens_at.getTime() <= now ? "open" : "scheduled";
      console.log(`${r.feature.padEnd(22)} ${state.padEnd(10)} ${(r.opens_at?.toISOString() ?? "null").padEnd(25)} ${r.updated_by}`);
    }
    return 0;
  } finally {
    await sql.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message.split("\n")[0] : String(e));
    process.exit(1);
  },
);
