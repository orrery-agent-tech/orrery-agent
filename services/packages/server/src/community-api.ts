import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress, type Abi, type Address } from "viem";
import {
  REWARD_KINDS,
  cashbackRewardsAbi,
  maskAddress,
  monthLabel,
  orryChatAbi,
  rewardPoolAbi,
  type CommunityAchievement,
  type CommunityMessage,
  type CommunityRewardEvent,
  type CommunityTemplate,
  type ReleaseFeature,
  type ReferralSummary,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { communityPrices } from "./community-indexer.js";
import { feeRows, mostActive, tierOf } from "./community-ledger.js";
import { releasesFor } from "./releases.js";

/**
 * Lane L1 read routes (`docs/updates/L1-COMMUNITY-SPEC.md`). Writes go from the wallet to the contracts; these routes
 * serve the indexed state. Each route belongs to one release feature (`COMMUNITY_ROUTE_FEATURE`); a held feature's
 * routes answer the 404 of an unknown route. `GET /v1/community/config` is never held: it carries only addresses and
 * constructor values.
 */

export interface CommunityRouteDeps {
  allowPublic: (ip: string) => boolean;
}

const READ_FAILED = "This read failed. Retry in a few seconds.";
const DAY = 86_400_000;

function addr(raw: string): string | null {
  return isAddress(raw) ? raw.toLowerCase() : null;
}

export function registerCommunityRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: CommunityRouteDeps): void {
  const c = cfg.community;
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  const gate = (feature: ReleaseFeature) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!c) return reply.callNotFound();
    let open = false;
    try {
      open = await releases.isOpen(feature);
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
    if (!open) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
  };
  async function guarded<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch {
      return reply.code(503).send({ error: READ_FAILED });
    }
  }
  /** The later of the server clock and the chain head's time (equal on a live chain; a local chain may run ahead). */
  const chainNow = async () => {
    const head = await chain.public.getBlock().catch(() => null);
    return Math.max(Date.now(), head ? Number(head.timestamp) * 1000 : 0);
  };
  const nameMap = async (addresses: string[]) => {
    if (addresses.length === 0) return new Map<string, string>();
    const rows = await sql<{ address: string; name: string }[]>`select address, name from community_names where address in ${sql(addresses)}`;
    return new Map(rows.map((r) => [r.address, r.name]));
  };

  // ---------------------------------------------------------------- config (never held)
  let configCache: { at: number; body: unknown } | null = null;
  app.get("/v1/community/config", async (req, reply) => {
    if (!c) return reply.callNotFound();
    if (!deps.allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
    return guarded(reply, async () => {
      if (configCache && Date.now() - configCache.at < 60_000) return configCache.body;
      const p = await communityPrices(c, chain);
      const read = async <T>(address: Address | null, abi: Abi, fn: string): Promise<T | null> =>
        address ? ((await chain.public.readContract({ address, abi, functionName: fn })) as T) : null;
      const [tipCutBps, reportMinStake, hideThreshold, maxTextBytes, checkWindow] = await Promise.all([
        read<number>(c.chat, orryChatAbi as Abi, "tipCutBps"),
        read<bigint>(c.chat, orryChatAbi as Abi, "reportMinStake"),
        read<number>(c.chat, orryChatAbi as Abi, "hideThreshold"),
        read<bigint>(c.chat, orryChatAbi as Abi, "maxTextBytes"),
        read<bigint>(c.pool, rewardPoolAbi as Abi, "CHECK_WINDOW"),
      ]);
      const body = {
        chainId: cfg.chainId,
        addresses: {
          pool: c.pool,
          achievements: c.achievements,
          chat: c.chat,
          names: c.names,
          boost: c.boost,
          passes: c.passes,
          templates: c.templates,
          referrals: c.referrals,
          cashback: c.cashback,
          orry: c.orry ?? cfg.orry?.token ?? null,
          staking: c.staking ?? cfg.orry?.staking ?? null,
          priceOracle: c.priceOracle,
        },
        postFeeUsd: p.postFeeUsd.toString(),
        nameFeeUsd: p.nameFeeUsd.toString(),
        boostUsdPerDay: { post: p.boostUsd[1]!.toString(), agent: p.boostUsd[2]!.toString(), template: p.boostUsd[3]!.toString() },
        passUsd: { day: p.passUsd[1]!.toString(), week: p.passUsd[2]!.toString() },
        tipCutBps,
        reportMinStake: reportMinStake?.toString() ?? null,
        hideThreshold,
        maxTextBytes: maxTextBytes === null ? null : Number(maxTextBytes),
        templateBurnBps: Number(p.templateBurnBps),
        checkWindowSeconds: checkWindow === null ? null : Number(checkWindow),
        referral: { shareBps: c.referralBps, days: c.referralDays, refereeDiscountBps: c.refereeDiscountBps, monthlyCapUsd: c.monthlyCapUsd.toString() },
        cashbackBps: c.cashbackBps,
      };
      configCache = { at: Date.now(), body };
      return body;
    });
  });

  // ---------------------------------------------------------------- chat
  app.get("/v1/community/rooms", { preHandler: gate("chat") }, async (_req, reply) =>
    guarded(reply, async () => {
      const rows = await sql<{ id: number; name: string; min_stake_usd: string }[]>`select id, name, min_stake_usd from community_rooms order by id`;
      return { rooms: rows.map((r) => ({ id: r.id, name: r.name, minStakeUsd: r.min_stake_usd })) };
    }),
  );

  app.get<{ Querystring: { room?: string; before?: string; limit?: string } }>("/v1/community/messages", { preHandler: gate("chat") }, async (req, reply) => {
    const room = Number(req.query.room ?? 0);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
    const before = req.query.before && /^\d{1,30}$/.test(req.query.before) ? req.query.before : null;
    if (!Number.isInteger(room) || room < 0) return reply.code(400).send({ error: "room expects a whole room number" });
    return guarded(reply, async () => {
      const rows = await sql<{ id: string; room: number; author: string; reply_to: string | null; text: string; fee: string; tips: string; reports: number; hidden: boolean; block_time: Date; tx_hash: string; until: Date | null }[]>`
        select m.*, b.until from community_messages m
        left join community_boosts b on b.kind = 1 and b.target = m.id and b.until > now()
        where m.room = ${room} and (${before}::numeric is null or m.id < ${before}::numeric)
        order by m.id desc limit ${limit}`;
      const names = await nameMap([...new Set(rows.map((r) => r.author))]);
      const messages: CommunityMessage[] = rows.map((r) => ({
        id: r.id,
        room: r.room,
        author: getAddress(r.author),
        authorName: names.get(r.author) ?? null,
        replyTo: r.reply_to,
        text: r.hidden ? null : r.text,
        hidden: r.hidden,
        fee: r.fee,
        tips: r.tips,
        reports: r.reports,
        boostedUntil: r.until ? r.until.toISOString() : null,
        time: r.block_time.toISOString(),
        txHash: r.tx_hash,
      }));
      return { messages };
    });
  });

  app.get<{ Params: { address: string } }>("/v1/community/names/:address", { preHandler: gate("chat") }, async (req, reply) => {
    const a = addr(req.params.address);
    if (!a) return reply.code(400).send({ error: "address expects a 0x address" });
    return guarded(reply, async () => {
      const [r] = await sql<{ name: string }[]>`select name from community_names where address = ${a}`;
      return { address: getAddress(a), name: r?.name ?? null };
    });
  });

  // ---------------------------------------------------------------- rewards: pool, events, achievements, most active
  app.get("/v1/community/rewards", { preHandler: gate("achievements") }, async (_req, reply) =>
    guarded(reply, async () => {
      const ev = await sql<{ id: number; asset: string; kind: number; amount: string; deadline: Date; rules_hash: string; status: "open" | "published" | "expired"; payable_at: Date | null; winners: { address: string; amount: string; paid: boolean }[] }[]>`
        select * from community_pool_events order by id desc limit 100`;
      const ach = await sql<{ id: number; asset: string; kind: number; verifier: string | null; reward_per_user: string; deadline: Date; rules_hash: string; closed: boolean }[]>`
        select * from community_achievements order by id desc limit 100`;
      // USDG always (USDG-only mode funds the pool in USDG), ORRY once its block is configured, then the assets of
      // admin-made events and achievements. Tokens anyone sent to the pool are never listed.
      const assets = [...new Set([cfg.addresses.usdg?.toLowerCase(), (c!.orry ?? cfg.orry?.token)?.toLowerCase(), ...ev.map((e) => e.asset), ...ach.map((a) => a.asset)].filter(Boolean) as string[])];
      const pool = await Promise.all(
        assets.map(async (asset) => {
          const [free, locked] = await Promise.all([
            chain.public.readContract({ address: c!.pool, abi: rewardPoolAbi as Abi, functionName: "freeBalance", args: [asset as Address] }) as Promise<bigint>,
            chain.public.readContract({ address: c!.pool, abi: rewardPoolAbi as Abi, functionName: "lockedBalance", args: [asset as Address] }) as Promise<bigint>,
          ]);
          return { asset: getAddress(asset), free: free.toString(), locked: locked.toString() };
        }),
      );
      const events: CommunityRewardEvent[] = ev.map((e) => ({
        id: e.id,
        asset: getAddress(e.asset),
        kind: e.kind,
        kindName: REWARD_KINDS[e.kind] ?? "Event",
        amount: e.amount,
        deadline: e.deadline.toISOString(),
        rulesHash: e.rules_hash,
        status: e.status,
        payableAt: e.payable_at ? e.payable_at.toISOString() : null,
        winners: e.winners.map((w) => ({ address: w.address, amount: w.amount, paid: w.paid })),
      }));
      const achievements: CommunityAchievement[] = ach.map((a) => ({
        id: a.id,
        asset: getAddress(a.asset),
        kind: a.kind,
        kindName: REWARD_KINDS[a.kind] ?? "Achievement",
        onchain: a.verifier !== null,
        verifier: a.verifier ? getAddress(a.verifier) : null,
        rewardPerUser: a.reward_per_user,
        deadline: a.deadline.toISOString(),
        rulesHash: a.rules_hash,
        closed: a.closed,
      }));
      return { pool, events, achievements };
    }),
  );

  /** R-40: the recipients' leaderboard by completion time, masked (R-5); no remaining-slot count. */
  app.get<{ Params: { id: string } }>("/v1/community/achievements/:id/recipients", { preHandler: gate("achievements") }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "id expects an achievement number" });
    return guarded(reply, async () => {
      const rows = await sql<{ account: string; completed_at: Date; amount: string }[]>`
        select account, completed_at, amount from community_achievement_claims where id = ${id} order by completed_at, rank limit 500`;
      return { recipients: rows.map((r, i) => ({ rank: i + 1, address: maskAddress(r.account), completedAt: r.completed_at.toISOString(), amount: r.amount })) };
    });
  });

  /** R-34: addresses ranked by protocol fees paid in USD over the last `days` (7 by default), with the rule text. */
  app.get<{ Querystring: { days?: string } }>("/v1/community/most-active", { preHandler: gate("achievements") }, async (req, reply) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 30);
    return guarded(reply, async () => {
      const to = new Date(Math.ceil((await chainNow()) / 3_600_000) * 3_600_000); // whole hours: the hash holds for an hour
      const from = new Date(to.getTime() - days * DAY);
      return mostActive(sql, cfg, from, to);
    });
  });

  // ---------------------------------------------------------------- boosts and passes
  app.get("/v1/community/boosts", { preHandler: gate("burn-to-boost") }, async (_req, reply) =>
    guarded(reply, async () => {
      const rows = await sql<{ kind: number; target: string; until: Date }[]>`select kind, target, until from community_boosts where until > now() order by until desc limit 200`;
      return { boosts: rows.map((r) => ({ kind: r.kind, target: r.target, until: r.until.toISOString() })) };
    }),
  );

  app.get<{ Params: { address: string } }>("/v1/community/passes/:address", { preHandler: gate("passes") }, async (req, reply) => {
    const a = addr(req.params.address);
    if (!a) return reply.code(400).send({ error: "address expects a 0x address" });
    return guarded(reply, async () => {
      const [r] = await sql<{ until: Date }[]>`select until from community_passes where account = ${a}`;
      return { address: getAddress(a), until: r ? r.until.toISOString() : null, active: !!r && r.until.getTime() > Date.now() };
    });
  });

  // ---------------------------------------------------------------- template market
  app.get("/v1/community/templates", { preHandler: gate("template-market") }, async (_req, reply) =>
    guarded(reply, async () => {
      const rows = await sql<{ id: number; creator: string; price_usd: string; content_hash: string; uri: string; listed: boolean; sales: number; until: Date | null }[]>`
        select t.*, b.until from community_templates t
        left join community_boosts b on b.kind = 3 and b.target = t.id and b.until > now()
        order by (b.until is not null) desc, t.sales desc, t.id desc limit 200`;
      const templates: CommunityTemplate[] = rows.map((r) => ({
        id: r.id,
        creator: getAddress(r.creator),
        priceUsd: r.price_usd,
        contentHash: r.content_hash,
        uri: r.uri,
        listed: r.listed,
        sales: r.sales,
        boostedUntil: r.until ? r.until.toISOString() : null,
      }));
      return { templates };
    }),
  );

  // ---------------------------------------------------------------- referrals and cashback
  const months = async (account: string, kind: number | null) => {
    const rows = await sql<{ month: number; owed: string; total_usd: string | null; reserve: string | null; opened_at: Date | null; closed: boolean | null; claimed: boolean }[]>`
      select a.month, sum(a.reward_usd)::text as owed, p.total_usd, p.reserve, p.opened_at, p.closed,
        exists(select 1 from community_claims cl where cl.account = ${account} and cl.month = a.month) as claimed
      from community_accruals a left join community_periods p on p.month = a.month
      where a.account = ${account} and (${kind}::int is null or a.kind = ${kind})
      group by a.month, p.total_usd, p.reserve, p.opened_at, p.closed order by a.month desc limit 24`;
    // what the sink pays is per account and month across both kinds: owed (both kinds) x reserve / month total
    return Promise.all(
      rows.map(async (r) => {
        const openable = c!.cashback
          ? ((await chain.public.readContract({ address: c!.cashback, abi: cashbackRewardsAbi as Abi, functionName: "openableAt", args: [BigInt(r.month)] })) as bigint)
          : 0n;
        let claimable = "0";
        if (c!.cashback && r.opened_at && !r.closed && !r.claimed) {
          claimable = ((await chain.public.readContract({ address: c!.cashback, abi: cashbackRewardsAbi as Abi, functionName: "claimable", args: [account as Address, BigInt(r.month)] })) as bigint).toString();
        }
        return { month: r.month, label: monthLabel(r.month), owedUsd: r.owed, openableAt: new Date(Number(openable) * 1000).toISOString(), claimable, claimed: r.claimed };
      }),
    );
  };

  app.get("/v1/community/referrals/leaderboard", { preHandler: gate("referrals") }, async (_req, reply) =>
    guarded(reply, async () => {
      const nowMs = await chainNow();
      const since = new Date(nowMs - c!.referralDays * DAY);
      const refs = await sql<{ referrer: string; referees: number }[]>`
        select referrer, count(*)::int as referees from community_referrals group by referrer order by referees desc limit 200`;
      const links = new Map(
        (await sql<{ referee: string; referrer: string }[]>`select referee, referrer from community_referrals`).map((x) => [x.referee, x.referrer]),
      );
      const volume = new Map<string, bigint>();
      for (const f of await feeRows(sql, cfg, since, new Date(nowMs + 1000))) {
        const referrer = links.get(f.account);
        if (referrer) volume.set(referrer, (volume.get(referrer) ?? 0n) + f.usd);
      }
      const rows = refs
        .map((r) => ({ referrer: r.referrer, referees: r.referees, volume: volume.get(r.referrer) ?? 0n }))
        .sort((a, b) => (a.volume === b.volume ? b.referees - a.referees : a.volume > b.volume ? -1 : 1))
        .slice(0, 50)
        .map((r, i) => ({ rank: i + 1, address: maskAddress(r.referrer), referees: r.referees, volumeUsd: r.volume.toString(), tier: tierOf(r.volume, c!.tiersUsd) }));
      return { rows };
    }),
  );

  app.get<{ Params: { address: string } }>("/v1/community/referrals/:address", { preHandler: gate("referrals") }, async (req, reply) => {
    const a = addr(req.params.address);
    if (!a) return reply.code(400).send({ error: "address expects a 0x address" });
    return guarded(reply, async () => {
      const [link] = await sql<{ referrer: string; linked_at: Date }[]>`select referrer, linked_at from community_referrals where referee = ${a}`;
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from community_referrals where referrer = ${a}`;
      const body: ReferralSummary = {
        referrer: link ? getAddress(link.referrer) : null,
        linkedAt: link ? link.linked_at.toISOString() : null,
        referees: n?.n ?? 0,
        months: await months(a, null),
        discountUntil: link ? new Date(link.linked_at.getTime() + c!.referralDays * DAY).toISOString() : null,
      };
      return body;
    });
  });

  app.get<{ Params: { address: string } }>("/v1/community/cashback/:address", { preHandler: gate("cashback") }, async (req, reply) => {
    const a = addr(req.params.address);
    if (!a) return reply.code(400).send({ error: "address expects a 0x address" });
    return guarded(reply, async () => {
      const records = await sql<{ fee_usd: string; reward_usd: string; fee_paid_at: Date; kind: number }[]>`
        select fee_usd, reward_usd, fee_paid_at, kind from community_accruals where account = ${a} and kind = 1 order by fee_paid_at desc limit 100`;
      return {
        months: await months(a, 1),
        records: records.map((r) => ({ feeUsd: r.fee_usd, rewardUsd: r.reward_usd, feePaidAt: r.fee_paid_at.toISOString(), kind: r.kind })),
      };
    });
  });
}
