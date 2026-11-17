import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  X402_VERSION,
  caip2,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "@orrery/shared";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import { creditsFor, requirements, settlePayment, type Product } from "./facilitator.js";
import { addressForKey, addressForReader, canCheck, checkAccount, closeSession, issueKeyIfNone, newRotationNonce, newSessionNonce, openSession, rotateKey, spendCheck } from "./credits.js";
import { buildCheck, readLens, toJson } from "./check.js";
import { registerOrryRoutes } from "./orry-api.js";
import { registerReleaseRoutes, releasesFor } from "./releases.js";
import { logLine } from "./log.js";
import { registerMarketRoutes } from "./markets-api.js";
import { registerFacilitatorRoutes, stakeQuota } from "./facilitator-public.js";
import { registerCommunityRoutes } from "./community-api.js";
import { registerDataRoutes } from "./data-api.js";
import { registerR2Routes } from "./r2-api.js";
import { registerCreditRoutes } from "./credit-api.js";
import { registerLaunchRoutes } from "./launch-api.js";

/** HTTP API (14 §3). Errors are short, calm and actionable. */

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

function paymentRequired(cfg: Config, url: string, error: string, product: Product = "pack"): PaymentRequired {
  const description =
    product === "plan"
      ? `Orrery plan · ${cfg.pricing.planDays} days · ${cfg.pricing.planCredits} check credits`
      : `Orrery credit pack · ${cfg.packSize} check credits`;
  return {
    x402Version: X402_VERSION,
    error,
    resource: { url, description, mimeType: "application/json" },
    accepts: [requirements(cfg, product)],
  };
}

/** `?product=plan` buys the platform plan; anything else a credit pack. */
const productOf = (q: unknown): Product => ((q as { product?: string } | undefined)?.product === "plan" ? "plan" : "pack");

/**
 * Small per-IP token bucket for the public endpoints. A bucket idle for a minute has refilled, so it is forgotten; the map
 * never holds more than `maxEntries` addresses, and the least recently seen one goes first.
 */
export function limiter(perMinute: number, maxEntries = 50_000, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  let swept = now();
  return (ip: string): boolean => {
    const t = now();
    if (t - swept >= 60_000) {
      for (const [k, v] of buckets) if (t - v.at >= 60_000) buckets.delete(k);
      swept = t;
    }
    const b = buckets.get(ip) ?? { tokens: perMinute, at: t };
    buckets.delete(ip);
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    if (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value as string);
    buckets.set(ip, b);
    return ok;
  };
}

const CLIENT_ERRORS: Record<number, string> = {
  413: "Request body exceeds the 64 KB limit.",
  415: "Use Content-Type application/json for the body.",
};

export function buildApi(cfg: Config, chain: Chain, sql: Sql): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: cfg.trustProxy });
  const allowPublic = limiter(cfg.publicRatePerMinute);
  // Utility 1: stake buys extra included checks a month once `stake-quota` is open.
  const quotaReleases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  const extraFree = async (a: Address) => (cfg.facilitator && (await quotaReleases.isOpen("stake-quota").catch(() => false)) ? stakeQuota(cfg, chain, a).catch(() => 0) : 0);

  // An internal error's text never reaches a visitor: a viem error carries the RPC URL, and a keyed URL would leak.
  app.setErrorHandler((err, req, reply) => {
    const code = (err as { statusCode?: number }).statusCode;
    if (code && code >= 400 && code < 500) {
      return reply.code(code).send({ error: CLIENT_ERRORS[code] ?? "Malformed request. Fix the fields and resend." });
    }
    console.error(`api ${req.method} ${req.routeOptions.url ?? "unknown route"}: ${logLine(err)}`);
    return reply.code(500).send({ error: "Unexpected server error. Please retry in a few seconds." });
  });

  // CORS for the web app: the x402 headers must be readable and sendable from the browser.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && (cfg.corsOrigins.includes("*") || cfg.corsOrigins.includes(origin))) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
      reply.header("access-control-allow-headers", `authorization, content-type, ${HEADER_SIGNATURE}`);
      reply.header("access-control-expose-headers", `${HEADER_REQUIRED}, ${HEADER_RESPONSE}`);
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  app.get("/health", async () => ({ ok: true, chainId: cfg.chainId }));

  const p = cfg.pricing;
  app.get("/v1/pricing", async () => ({
    packPrice: cfg.packPrice.toString(),
    packSize: cfg.packSize,
    freeChecksPerMonth: p.freeChecksPerMonth,
    creditsPerCheck: p.creditsPerCheck,
    volumeCreditsPerCheck: p.volumeCreditsPerCheck,
    volumeChecks: p.volumeChecks,
    checksPerMinute: p.checksPerMinute,
    plan: { price: p.planPrice.toString(), credits: p.planCredits, days: p.planDays, checksPerMinute: p.planChecksPerMinute },
    asset: cfg.addresses.usdg,
    network: caip2(cfg.chainId),
  }));

  // ---------------------------------------------------------------- credits over x402
  app.post("/v1/credits", async (req, reply) => {
    const product = productOf(req.query);
    const url = `${cfg.publicUrl}/v1/credits${product === "plan" ? "?product=plan" : ""}`;
    const header = req.headers[HEADER_SIGNATURE.toLowerCase()];
    if (!header || Array.isArray(header)) {
      return reply.code(402).header(HEADER_REQUIRED, encodeHeader(paymentRequired(cfg, url, `Attach the ${HEADER_SIGNATURE} header to pay`, product))).send({});
    }
    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(header);
    } catch {
      return reply.code(400).send({ error: "Payment header is not valid base64 JSON." });
    }
    const out = await settlePayment(cfg, chain, sql, payload);
    if (!out.ok) {
      const settlement: SettlementResponse = {
        success: false,
        errorReason: out.reason,
        transaction: out.txHash ?? "",
        network: caip2(cfg.chainId),
        payer: out.payer ?? "",
      };
      const status = out.reason === "settlement_pending" ? 202 : 402;
      reply.header(HEADER_RESPONSE, encodeHeader(settlement));
      if (status === 402) reply.header(HEADER_REQUIRED, encodeHeader(paymentRequired(cfg, url, out.reason, product)));
      return reply.code(status).send({
        error: out.reason === "settlement_pending" ? "Payment awaiting confirmation. Repeat this exact request in a few seconds." : `Payment refused (${out.reason}).`,
      });
    }
    const key = await issueKeyIfNone(sql, out.payer);
    const settlement: SettlementResponse = { success: true, transaction: out.txHash, network: caip2(cfg.chainId), payer: out.payer };
    const acct = await checkAccount(p, sql, out.payer, new Date(), await extraFree(out.payer));
    return reply.header(HEADER_RESPONSE, encodeHeader(settlement)).send({
      credits: acct.credits.toString(),
      granted: out.granted ? creditsFor(cfg, out.product) : 0,
      product: out.product,
      planUntil: acct.planUntil?.toISOString() ?? null,
      apiKey: key ?? undefined,
    });
  });

  app.get("/v1/credits", async (req, reply) => {
    const address = await addressForKey(sql, bearer(req));
    if (!address) return reply.code(401).send({ error: "Missing API key. Use an Authorization: Bearer header." });
    const history = await sql`select g.nonce, g.credits, g.kind, g.created_at, p.tx_hash from credit_grants g
      left join payments p on p.payer = g.payer and p.nonce = g.nonce where g.payer = ${address.toLowerCase()} order by g.created_at desc limit 50`;
    const acct = await checkAccount(p, sql, address, new Date(), await extraFree(address));
    return {
      address,
      credits: acct.credits.toString(),
      checkCost: acct.checkCost,
      planUntil: acct.planActive ? acct.planUntil!.toISOString() : null,
      month: { checks: acct.checks, freeChecks: acct.freeChecks, freeChecksLeft: acct.freeChecksLeft },
      purchases: history,
    };
  });

  // ---------------------------------------------------------------- key rotation
  app.get<{ Querystring: { address?: string } }>("/v1/keys/nonce", async (req, reply) => {
    const a = req.query.address;
    if (!a || !isAddress(a)) return reply.code(400).send({ error: "Pass ?address=0x..." });
    return newRotationNonce(cfg, sql, getAddress(a));
  });

  app.post<{ Body: { address?: string; nonce?: string; signature?: string } }>("/v1/keys/rotate", async (req, reply) => {
    const { address, nonce, signature } = req.body ?? {};
    if (!address || !isAddress(address) || !nonce || !signature) return reply.code(400).send({ error: "Required fields: address, nonce, signature." });
    const key = await rotateKey(cfg, chain, sql, getAddress(address), nonce, signature as Hex);
    if (!key) return reply.code(401).send({ error: "Signature check failed. Fetch a fresh nonce and sign that one." });
    return { apiKey: key };
  });

  // ---------------------------------------------------------------- dashboard: wallet read sessions
  // One signed message opens a 24 hour read session for the dashboard: credits, purchases, usage, key status. A session
  // never spends a check, issues a key or moves funds; the API key stays the only way to call a check.
  app.get<{ Querystring: { address?: string } }>("/v1/account/nonce", async (req, reply) => {
    if (!allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
    const a = req.query.address;
    if (!a || !isAddress(a)) return reply.code(400).send({ error: "Pass ?address=0x..." });
    return newSessionNonce(cfg, sql, getAddress(a));
  });

  app.post<{ Body: { address?: string; nonce?: string; signature?: string } }>("/v1/account/session", async (req, reply) => {
    if (!allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
    const { address, nonce, signature } = req.body ?? {};
    if (!address || !isAddress(address) || !nonce || !signature) return reply.code(400).send({ error: "Required fields: address, nonce, signature." });
    const s = await openSession(cfg, chain, sql, getAddress(address), nonce, signature as Hex);
    if (!s) return reply.code(401).send({ error: "Signature check failed. Fetch a fresh nonce and sign that one." });
    return { token: s.token, expiresAt: s.expiresAt.toISOString() };
  });

  // POST, since the API allows only GET and POST across origins.
  app.post("/v1/account/session/close", async (req) => {
    await closeSession(sql, bearer(req));
    return { ok: true };
  });

  app.get("/v1/account", async (req, reply) => {
    const address = await addressForReader(sql, bearer(req));
    if (!address) return reply.code(401).send({ error: "Connect and sign in with your wallet to view credits." });
    const a = address.toLowerCase();
    const acct = await checkAccount(p, sql, address, new Date(), await extraFree(address));
    const [key] = await sql<{ created_at: Date }[]>`select created_at from api_keys where address = ${a} and active`;
    const usdgBuys = await sql<{ kind: string | null; credits: number; amount: string | null; created_at: Date; tx_hash: string | null }[]>`
      select g.kind, g.credits, p.amount::text as amount, g.created_at, p.tx_hash from credit_grants g
      left join payments p on p.payer = g.payer and p.nonce = g.nonce where g.payer = ${a} order by g.created_at desc limit 100`;
    const orryBuys = await sql<{ credits: string; orry_amount: string; created_at: Date; tx_hash: string }[]>`
      select credits::text as credits, orry_amount::text as orry_amount, created_at, tx_hash from orry_credit_grants
      where lower(buyer) = ${a} order by created_at desc limit 100`;
    const daily = await sql<{ day: Date; checks: string; free_checks: string; credits_spent: string }[]>`
      select day, checks, free_checks, credits_spent from check_usage_daily
      where address = ${a} and day > (now() at time zone 'utc')::date - 31 order by day desc`;
    const monthly = await sql<{ month: Date; checks: string; free_checks: string }[]>`
      select month, checks, free_checks from check_usage where address = ${a} order by month desc limit 12`;
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const purchases = [
      ...usdgBuys.map((r) => ({ at: r.created_at.toISOString(), product: r.kind ?? "pack", paidIn: "USDG", amount: r.amount, credits: String(r.credits), tx: r.tx_hash })),
      ...orryBuys.map((r) => ({ at: r.created_at.toISOString(), product: "pack", paidIn: "ORRY", amount: r.orry_amount, credits: r.credits, tx: r.tx_hash })),
    ].sort((x, y) => (x.at < y.at ? 1 : -1));
    return {
      address,
      credits: acct.credits.toString(),
      checkCost: acct.checkCost,
      planUntil: acct.planActive ? acct.planUntil!.toISOString() : null,
      month: { checks: acct.checks, freeChecks: acct.freeChecks, freeChecksLeft: acct.freeChecksLeft },
      apiKey: key ? { active: true, createdAt: key.created_at.toISOString() } : { active: false, createdAt: null },
      purchases,
      usage: {
        daily: daily.map((d) => ({ day: iso(d.day), checks: Number(d.checks), freeChecks: Number(d.free_checks), creditsSpent: d.credits_spent })),
        monthly: monthly.map((m) => ({ month: iso(m.month).slice(0, 7), checks: Number(m.checks), freeChecks: Number(m.free_checks), paidChecks: Number(m.checks) - Number(m.free_checks) })),
      },
    };
  });

  // ---------------------------------------------------------------- signed checks (free allowance, then credits)
  const allowChecks = limiter(p.checksPerMinute);
  const allowPlanChecks = limiter(p.planChecksPerMinute);
  const noCredits = (reply: FastifyReply) =>
    reply
      .code(402)
      .header(HEADER_REQUIRED, encodeHeader(paymentRequired(cfg, `${cfg.publicUrl}/v1/credits`, "Credits used up")))
      .send({ error: "Included checks and credits are used up. POST /v1/credits buys more." });

  async function paidCheck(req: FastifyRequest, reply: FastifyReply, by: { signer: Address } | { agentId: bigint; account: Address }) {
    const address = await addressForKey(sql, bearer(req));
    if (!address) return reply.code(401).send({ error: "Missing API key. Use an Authorization: Bearer header." });
    const acct = await checkAccount(p, sql, address, new Date(), await extraFree(address));
    if (!(acct.planActive ? allowPlanChecks : allowChecks)(address.toLowerCase())) {
      return reply.code(429).send({ error: "This key reached its per minute check limit. Retry next minute." });
    }
    if (!canCheck(acct)) return noCredits(reply);
    let signed;
    try {
      signed = await buildCheck(cfg, chain, sql, by);
    } catch {
      return reply.code(503).send({ error: "Reading not produced, and no credit was charged. Retry in a few seconds." });
    }
    const spent = await spendCheck(p, sql, address, new Date(), await extraFree(address));
    if (!spent.ok) return noCredits(reply);
    reply.header("x-orrery-check-credits", String(spent.credits));
    return toJson(signed);
  }

  app.get<{ Params: { address: string } }>("/v1/check/by-signer/:address", async (req, reply) => {
    if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Expected a 0x address." });
    return paidCheck(req, reply, { signer: getAddress(req.params.address) });
  });

  app.get<{ Params: { agentId: string }; Querystring: { account?: string } }>("/v1/check/by-agent/:agentId", async (req, reply) => {
    const acc = req.query.account;
    if (!/^\d+$/.test(req.params.agentId) || !acc || !isAddress(acc)) return reply.code(400).send({ error: "Expected a numeric agentId plus ?account=0x..." });
    return paidCheck(req, reply, { agentId: BigInt(req.params.agentId), account: getAddress(acc) });
  });

  // ---------------------------------------------------------------- public reads (no probe, no signature)
  async function publicRead(reply: FastifyReply, by: { signer: Address } | { agentId: bigint; account: Address }) {
    try {
      return toJson(await readLens(cfg, chain, by));
    } catch (err) {
      console.error(`api public read: ${logLine(err)}`);
      return reply.code(503).send({ error: "Chain read failed. Retry in a few seconds." });
    }
  }

  app.get<{ Params: { address: string } }>("/v1/signers/:address", async (req, reply) => {
    if (!allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
    if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Expected a 0x address." });
    return publicRead(reply, { signer: getAddress(req.params.address) });
  });

  app.get<{ Params: { agentId: string }; Querystring: { account?: string } }>("/v1/agents/:agentId", async (req, reply) => {
    if (!allowPublic(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
    const acc = req.query.account;
    if (!/^\d+$/.test(req.params.agentId) || !acc || !isAddress(acc)) return reply.code(400).send({ error: "Expected a numeric agentId plus ?account=0x..." });
    return publicRead(reply, { agentId: BigInt(req.params.agentId), account: getAddress(acc) });
  });

  // ---------------------------------------------------------------- ORRY (build spec §5), behind ORRERY_ORRY_FEATURES
  registerOrryRoutes(app, cfg, chain, sql, { allowPublic, makeLimiter: limiter });
  registerReleaseRoutes(app, releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs), allowPublic);
  registerMarketRoutes(app, cfg, chain, sql, { allowPublic, makeLimiter: limiter });
  registerFacilitatorRoutes(app, cfg, chain, sql, { allowPublic, makeLimiter: limiter });
  registerCommunityRoutes(app, cfg, chain, sql, { allowPublic });
  registerDataRoutes(app, cfg, chain, sql, { allowPublic, makeLimiter: limiter });
  registerR2Routes(app, cfg, chain, sql, { allowPublic, makeLimiter: limiter });
  registerCreditRoutes(app, cfg, chain, sql, { allowPublic });
  registerLaunchRoutes(app, cfg, chain, sql, { allowPublic, makeLimiter: limiter });

  return app;
}
