import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RELEASE_FEATURES, type ReleasesResponse } from "@orrery/shared";
import type { Sql } from "./db.js";

/**
 * Runtime release switch (launch plan prep item 3). The `releases` table says when each feature opens; null holds it,
 * and a feature with no row is held. Every request decides by the server clock against rows cached for at most
 * `cacheMs`, so a time that passes opens a feature, and a row set back to null holds it again, without a restart. The
 * table is written only by `scripts/releases.ts`; there is no HTTP write route. An empty table is seeded once from
 * `ORRERY_ORRY_FEATURES`, or the chain default (held on 4663, open elsewhere).
 */

export interface ReleaseSeed {
  chainId: number;
  /** The explicit `ORRERY_ORRY_FEATURES` list; undefined applies the chain default. */
  explicit: Set<string> | undefined;
}

/** Features open in a seed: the explicit list, else every known feature off 4663 and none on it. */
export const seedOpen = (seed: ReleaseSeed): Set<string> =>
  seed.explicit ?? (seed.chainId === 4663 ? new Set() : new Set<string>(RELEASE_FEATURES));

/** Fills an empty table: an open feature opens now, every other known feature is held. Returns the rows written. */
export async function seedReleases(sql: Sql, seed: ReleaseSeed, by = "seed"): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`lock table releases in share row exclusive mode`;
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from releases`;
    if (n!.n > 0) return 0;
    const open = seedOpen(seed);
    const now = new Date();
    for (const feature of RELEASE_FEATURES) {
      const opensAt = open.has(feature) ? now : null;
      await tx`insert into releases (feature, opens_at, updated_by) values (${feature}, ${opensAt}, ${by})`;
      await tx`insert into releases_audit (feature, opens_at, previous, had_row, changed_by) values (${feature}, ${opensAt}, null, false, ${by})`;
    }
    return RELEASE_FEATURES.length;
  });
}

/** Sets when `feature` opens (null holds it), with an audit row, in one transaction. Only known names. */
export async function setRelease(sql: Sql, feature: string, opensAt: Date | null, by: string): Promise<void> {
  if (!(RELEASE_FEATURES as readonly string[]).includes(feature)) {
    throw new Error(`Unknown feature "${feature}". Use one of: ${RELEASE_FEATURES.join(", ")}.`);
  }
  if (!by) throw new Error("updated_by is required");
  await sql.begin(async (tx) => {
    const [prev] = await tx<{ opens_at: Date | null }[]>`select opens_at from releases where feature = ${feature} for update`;
    await tx`insert into releases (feature, opens_at, updated_at, updated_by) values (${feature}, ${opensAt}, now(), ${by})
      on conflict (feature) do update set opens_at = excluded.opens_at, updated_at = now(), updated_by = excluded.updated_by`;
    await tx`insert into releases_audit (feature, opens_at, previous, had_row, changed_by)
      values (${feature}, ${opensAt}, ${prev?.opens_at ?? null}, ${prev !== undefined}, ${by})`;
  });
}

export class Releases {
  private cached: { at: number; rows: Map<string, Date | null> } | null = null;
  private loading: Promise<Map<string, Date | null>> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly seed: ReleaseSeed,
    private readonly cacheMs: number,
  ) {}

  /** Every row, seeding an empty table first; cached for `cacheMs`. */
  async rows(): Promise<Map<string, Date | null>> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.cacheMs) return this.cached.rows;
    this.loading ??= (async () => {
      try {
        let rows = await this.sql<{ feature: string; opens_at: Date | null }[]>`select feature, opens_at from releases`;
        if (rows.length === 0) {
          await seedReleases(this.sql, this.seed);
          rows = await this.sql<{ feature: string; opens_at: Date | null }[]>`select feature, opens_at from releases`;
        }
        const map = new Map(rows.map((r) => [r.feature, r.opens_at]));
        this.cached = { at: Date.now(), rows: map };
        return map;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Open when the feature has a row whose time is at or before `now` (the server clock, read per request after the rows,
   * so a table seeded by this very request counts as open). */
  async isOpen(feature: string, now?: Date): Promise<boolean> {
    const at = (await this.rows()).get(feature);
    return at !== undefined && at !== null && at.getTime() <= (now ?? new Date()).getTime();
  }
}

const registry = new WeakMap<object, Releases>();

/** One `Releases` per database handle, so every route and the check signer share one cache. */
export function releasesFor(sql: Sql, seed: ReleaseSeed, cacheMs: number): Releases {
  let r = registry.get(sql as unknown as object);
  if (!r) {
    r = new Releases(sql, seed, cacheMs);
    registry.set(sql as unknown as object, r);
  }
  return r;
}

/** GET /v1/releases: public, never held, rate-limited per IP, cached as the rows are. */
export function registerReleaseRoutes(app: FastifyInstance, releases: Releases, allowPublic: (ip: string) => boolean): void {
  const limit = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
  };
  app.get("/v1/releases", { preHandler: limit }, async (_req, reply) => {
    try {
      const rows = await releases.rows();
      const body: ReleasesResponse = {
        serverTime: new Date().toISOString(),
        releases: Object.fromEntries([...rows].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, at]) => [f, at ? at.toISOString() : null])),
      };
      return body;
    } catch {
      return reply.code(503).send({ error: "Release schedule read failed. Retry in a few seconds." });
    }
  });
}
