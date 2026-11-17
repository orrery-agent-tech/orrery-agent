import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress, type Abi, type Address } from "viem";
import {
  DATA_CATALOG,
  DATA_DATASETS,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  X402_VERSION,
  caip2,
  dataDomain,
  dataResponseTypes,
  decodeHeader,
  encodeHeader,
  iDataProviderRegistryAbi,
  type DataCatalogResponse,
  type DataPaymentRequirements,
  type DataPricing,
  type DataProviderView,
  type DataProvidersResponse,
  type DatasetId,
  type FacilitatorRequest,
  type PublicPaymentPayload,
  type ReleaseFeature,
  type SettlementResponse,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { addressForKey, issueKeyIfNone } from "./credits.js";
import { releasesFor } from "./releases.js";
import { settlePublic, verifyPublic } from "./facilitator-public.js";
import { dataCallsOf, packUsd, orryPackOpen, orryPackRequirement, refundDataCall, settlePack, spendDataCall, usdgPackRequirement } from "./data-packs.js";
import { DatasetUnavailable, datasetCounts, parseDatasetQuery, runDataset } from "./data-datasets.js";
import { dataSignerAddress, signDataResponse } from "./data-sign.js";

/**
 * Lane L2 routes (`docs/updates/L2-DATA-MCP-SPEC.md` 5). Official data behind `data`; third-party providers and their
 * settlement behind `data-providers`. A held feature answers 404 like an unknown route (DA-9).
 */

export interface DataRouteDeps {
  allowPublic: (ip: string) => boolean;
  makeLimiter: (perMinute: number) => (ip: string) => boolean;
}

const lower = (a: string) => a.toLowerCase();

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

export function registerDataRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: DataRouteDeps): void {
  const d = cfg.data;
  if (!d) return;
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  const isOpen = (feature: ReleaseFeature) => releases.isOpen(feature);
  const allowPay = deps.makeLimiter(30);
  const allowData = deps.makeLimiter(600);
  const gate = (feature: ReleaseFeature, limit = deps.allowPublic) => async (req: FastifyRequest, reply: FastifyReply) => {
    let open = false;
    try {
      open = await isOpen(feature);
    } catch {
      return reply.code(503).send({ error: "Retry in a few seconds." });
    }
    if (!open) return reply.callNotFound();
    if (!limit(req.ip)) return reply.code(429).send({ error: "Rate limit reached. Wait a minute, then retry." });
  };
  const network = caip2(cfg.chainId);
  const signer = dataSignerAddress(cfg);
  const ctx = { cfg, chain, sql };

  const cache = new Map<string, { at: number; value: unknown }>();
  async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < d!.cacheMs) return hit.value as T;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  const pricing = async (): Promise<DataPricing> => {
    const orryOpen = await orryPackOpen(cfg, isOpen);
    return {
      callUsd: d.callUsd.toString(),
      packCalls: d.packCalls,
      packUsd: packUsd(cfg).toString(),
      orryDiscountBps: d.orryDiscountBps,
      usdg: getAddress(cfg.addresses.usdg),
      orryPayTo: orryOpen ? getAddress(d.splitter!) : null,
      orry: orryOpen ? getAddress(cfg.orry!.token) : null,
      treasury: getAddress(cfg.treasury),
      network,
      signer,
      maxStakeDiscountBps: d.maxStakeDiscountBps,
    };
  };

  /** The 402 a data route answers with: a USDG pack, and an ORRY pack at a fresh quote when that path is open. */
  async function paymentRequired(url: string, error: string) {
    const accepts: DataPaymentRequirements[] = [usdgPackRequirement(cfg)];
    if (await orryPackOpen(cfg, isOpen)) {
      const q = await orryPackRequirement(cfg, chain, sql);
      if (q.ok) accepts.push(q.requirement);
    }
    return {
      x402Version: X402_VERSION,
      error,
      resource: { url, description: `Orrery Data pack · ${d!.packCalls} calls`, mimeType: "application/json" },
      accepts,
    };
  }

  /** Settles the pack in the request's payment header. Null when there is none; an error reply when it fails. */
  async function payFromHeader(req: FastifyRequest, reply: FastifyReply, url: string) {
    const header = req.headers[HEADER_SIGNATURE.toLowerCase()];
    if (!header || Array.isArray(header)) return null;
    let payload: PublicPaymentPayload;
    try {
      payload = decodeHeader<PublicPaymentPayload>(header);
    } catch {
      return reply.code(400).send({ error: "Payment header is not valid base64 JSON." });
    }
    const out = await settlePack(cfg, chain, sql, payload, await orryPackOpen(cfg, isOpen));
    if (!out.ok) {
      const settlement: SettlementResponse = { success: false, errorReason: out.reason, transaction: out.txHash ?? "", network, payer: out.payer ?? "" };
      const status = out.reason === "settlement_pending" || out.reason === "settlement_in_progress" ? 202 : 402;
      return reply
        .code(status)
        .header(HEADER_REQUIRED, encodeHeader(await paymentRequired(url, out.reason)))
        .header(HEADER_RESPONSE, encodeHeader(settlement))
        .send({ error: status === 202 ? "Payment awaiting confirmation. Repeat this exact request in a few seconds." : `Payment refused (${out.reason}).` });
    }
    reply.header(HEADER_RESPONSE, encodeHeader({ success: true, transaction: out.txHash, network, payer: out.payer } satisfies SettlementResponse));
    // api_keys references credit_accounts: a buyer of data alone gets an account row (no credits) so its key can be issued
    await sql`insert into credit_accounts (address) values (${lower(out.payer)}) on conflict do nothing`;
    const apiKey = await issueKeyIfNone(sql, out.payer);
    return { payer: out.payer, calls: out.calls, granted: out.granted, apiKey, transaction: out.txHash };
  }

  // ---------------------------------------------------------------- catalogue, signer, account

  app.get("/v1/data", { preHandler: gate("data") }, async (): Promise<DataCatalogResponse> =>
    cached("catalog", async () => {
      const counts = await datasetCounts(ctx);
      return { datasets: DATA_DATASETS.map((id) => ({ ...DATA_CATALOG[id], records: counts[id] })), pricing: await pricing() };
    }),
  );

  app.get("/v1/data/signer", { preHandler: gate("data") }, async () => ({
    signer,
    chainId: cfg.chainId,
    domain: dataDomain(cfg.chainId),
    types: dataResponseTypes,
    primaryType: "DataResponse",
  }));

  app.get("/v1/data/account", { preHandler: gate("data") }, async (req, reply) => {
    const address = await addressForKey(sql, bearer(req));
    if (!address) return reply.code(401).send({ error: "Missing Orrery API key. Use an Authorization: Bearer header." });
    const calls = await dataCallsOf(sql, address);
    return { address, calls: calls.toString(), packCalls: d.packCalls, low: calls * 5n < BigInt(d.packCalls) };
  });

  // ---------------------------------------------------------------- packs over x402

  app.post("/v1/data/packs", { preHandler: gate("data", allowPay) }, async (req, reply) => {
    const url = `${cfg.publicUrl}/v1/data/packs`;
    const paid = await payFromHeader(req, reply, url);
    if (paid === null) {
      return reply.code(402).header(HEADER_REQUIRED, encodeHeader(await paymentRequired(url, `Attach the ${HEADER_SIGNATURE} header to pay`))).send({});
    }
    if (reply.sent) return reply;
    const p = paid as Exclude<typeof paid, FastifyReply>;
    return { account: { address: p.payer, calls: p.calls.toString(), ...(p.apiKey ? { apiKey: p.apiKey } : {}) }, granted: p.granted.toString(), transaction: p.transaction };
  });

  // ---------------------------------------------------------------- datasets

  app.get<{ Params: { id: string } }>("/v1/data/datasets/:id", { preHandler: gate("data", allowData) }, async (req, reply) => {
    const id = req.params.id as DatasetId;
    if (!(DATA_DATASETS as readonly string[]).includes(id)) return reply.code(404).send({ error: `No such dataset. Available: ${DATA_DATASETS.join(", ")}.` });
    const q = parseDatasetQuery(cfg, id, (req.query ?? {}) as Record<string, unknown>);
    if ("error" in q) return reply.code(400).send({ error: q.error });
    const url = `${cfg.publicUrl}${req.url}`;

    let address = await addressForKey(sql, bearer(req));
    let apiKey: string | null = null;
    if (!address) {
      const paid = await payFromHeader(req, reply, url);
      if (paid === null) {
        return reply.code(402).header(HEADER_REQUIRED, encodeHeader(await paymentRequired(url, "An Orrery API key or a data pack payment is required"))).send({});
      }
      if (reply.sent) return reply;
      const p = paid as Exclude<typeof paid, FastifyReply>;
      address = p.payer;
      apiKey = p.apiKey;
    }

    let result;
    try {
      result = await runDataset(ctx, id, q);
    } catch (e) {
      if (e instanceof DatasetUnavailable) return reply.code(409).send({ error: e.message });
      throw e;
    }
    // the call is spent only for an answer, and no answer goes out without a call (DA-7)
    const left = await spendDataCall(sql, address);
    if (left === null) {
      return reply.code(402).header(HEADER_REQUIRED, encodeHeader(await paymentRequired(url, "Data calls used up. A new pack adds more."))).send({ error: "Data calls used up. A new pack adds more." });
    }
    try {
      const signed = await signDataResponse(cfg, { dataset: id, view: q.view, query: { ...q.filters, limit: q.limit, before: q.before }, records: result.records, asOfBlock: result.asOfBlock, next: result.next });
      return { ...signed, account: { address, calls: left.toString(), ...(apiKey ? { apiKey } : {}), ...(left * 5n < BigInt(d.packCalls) ? { low: true } : {}) } };
    } catch (e) {
      await refundDataCall(sql, address);
      throw e;
    }
  });

  // ---------------------------------------------------------------- third-party providers (R-51)

  const registry = d.registry;
  const providerFactory = d.providerFactory;
  if (!registry || !providerFactory) return;

  async function providerView(row: {
    provider: string;
    splitter: string;
    endpoint: string;
    name: string;
    description: string;
    price_usdg: string;
    listed_block: string;
    listed_tx: string;
    listed_at: Date;
    updated_at: Date;
  }): Promise<DataProviderView> {
    const provider = getAddress(row.provider);
    const [active, stakeUsd, volume] = await Promise.all([
      chain.public.readContract({ address: registry!, abi: iDataProviderRegistryAbi as Abi, functionName: "isActive", args: [provider] }).catch(() => false) as Promise<boolean>,
      chain.public.readContract({ address: registry!, abi: iDataProviderRegistryAbi as Abi, functionName: "stakeUsdOf", args: [provider] }).catch(() => 0n) as Promise<bigint>,
      sql<{ asset: string; n: string; amount: string }[]>`select asset, count(*)::text as n, sum(amount)::text as amount from facilitator_payments
        where pay_to = ${row.splitter} and status = 'settled' and created_at > now() - interval '30 days' group by asset`,
    ]);
    return {
      provider,
      splitter: getAddress(row.splitter),
      endpoint: row.endpoint,
      name: row.name,
      description: row.description,
      priceUsdg: row.price_usdg,
      listedAt: Math.floor(row.listed_at.getTime() / 1000),
      updatedAt: Math.floor(row.updated_at.getTime() / 1000),
      listedBlock: row.listed_block,
      listedTx: row.listed_tx as `0x${string}`,
      active,
      stakeUsd: stakeUsd.toString(),
      settled30d: volume.map((v) => ({ asset: getAddress(v.asset), payments: Number(v.n), amount: v.amount })),
    };
  }

  const minStake = () =>
    cached("minStake", async () => (await chain.public.readContract({ address: registry, abi: iDataProviderRegistryAbi as Abi, functionName: "minStakeUsd" })) as bigint);

  app.get("/v1/data/providers", { preHandler: gate("data-providers") }, async (): Promise<DataProvidersResponse> =>
    cached("providers", async () => {
      const rows = await sql<Parameters<typeof providerView>[0][]>`select provider, splitter, endpoint, name, description, price_usdg::text as price_usdg,
        listed_block::text as listed_block, listed_tx, listed_at, updated_at from data_providers order by listed_at desc limit 500`;
      const providers = await Promise.all(rows.map(providerView));
      providers.sort((a, b) => Number(b.active) - Number(a.active) || (BigInt(b.stakeUsd) > BigInt(a.stakeUsd) ? 1 : BigInt(b.stakeUsd) < BigInt(a.stakeUsd) ? -1 : 0));
      return { providers, minStakeUsd: (await minStake()).toString(), feeBps: 100, registry: getAddress(registry) };
    }),
  );

  app.get<{ Params: { address: string } }>("/v1/data/providers/:address", { preHandler: gate("data-providers") }, async (req, reply) => {
    if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Expected a 0x address." });
    const [row] = await sql<Parameters<typeof providerView>[0][]>`select provider, splitter, endpoint, name, description, price_usdg::text as price_usdg,
      listed_block::text as listed_block, listed_tx, listed_at, updated_at from data_providers where provider = ${lower(req.params.address)}`;
    if (!row) return reply.code(404).send({ error: "No provider listing exists for this address." });
    return providerView(row);
  });

  // Provider settlement (D-7): the payee must be the splitter of a listed, active provider; the wave 3 facilitator code
  // then verifies and settles with the 1% factory in place of the 0.2% one.
  const f = cfg.facilitator;
  if (!f) return;
  const providerCfg: Config = { ...cfg, facilitator: { ...f, factory: providerFactory } };
  const allowSettle = deps.makeLimiter(Math.max(f.ratePerMinute * 5, 60));

  async function activeProviderOf(payTo: string | undefined): Promise<Address | null> {
    if (!payTo || !isAddress(payTo)) return null;
    const [row] = await sql<{ provider: string }[]>`select provider from data_providers where splitter = ${lower(payTo)}`;
    if (!row) return null;
    const provider = getAddress(row.provider);
    const [splitter, active] = await Promise.all([
      chain.public.readContract({ address: registry!, abi: iDataProviderRegistryAbi as Abi, functionName: "splitterOf", args: [provider] }) as Promise<Address>,
      chain.public.readContract({ address: registry!, abi: iDataProviderRegistryAbi as Abi, functionName: "isActive", args: [provider] }) as Promise<boolean>,
    ]);
    return active && lower(splitter) === lower(payTo) ? provider : null;
  }

  app.get("/v1/data/x402/supported", { preHandler: gate("data-providers") }, async () => ({
    kinds: [
      { x402Version: 2, scheme: "exact", network, asset: getAddress(cfg.addresses.usdg), extra: { assetTransferMethod: "eip3009", name: cfg.usdgDomain.name, version: cfg.usdgDomain.version } },
      ...(cfg.orry && f.permit2Proxy && (await isOpen("orry-x402"))
        ? [{ x402Version: 2, scheme: "exact", network, asset: getAddress(cfg.orry.token), extra: { assetTransferMethod: "permit2", proxy: f.permit2Proxy, permit2: f.permit2 } }]
        : []),
    ],
    payTo: "Per provider Orrery payment address, listed at GET /v1/data/providers/<address>",
    feeBps: 100,
  }));

  app.post("/v1/data/x402/verify", { preHandler: gate("data-providers", allowSettle) }, async (req) => {
    const body = req.body as FacilitatorRequest;
    if (!(await activeProviderOf(body?.paymentRequirements?.payTo).catch(() => null))) return { isValid: false, invalidReason: "pay_to_is_not_an_active_data_provider" };
    const v = await verifyPublic(providerCfg, chain, body, isOpen).catch(() => ({ ok: false as const, reason: "verify_failed" }));
    return v.ok ? { isValid: true, payer: v.payer } : { isValid: false, invalidReason: v.reason, payer: (v as { payer?: Address }).payer };
  });

  app.post("/v1/data/x402/settle", { preHandler: gate("data-providers", allowSettle) }, async (req): Promise<SettlementResponse> => {
    const body = req.body as FacilitatorRequest;
    if (!(await activeProviderOf(body?.paymentRequirements?.payTo).catch(() => null))) {
      return { success: false, transaction: "", network, payer: "", errorReason: "pay_to_is_not_an_active_data_provider" };
    }
    return settlePublic(providerCfg, chain, sql, body, isOpen).catch(() => ({ success: false, transaction: "", network, payer: "", errorReason: "settle_failed" }));
  });
}
