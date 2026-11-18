import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { decodeEventLog, getAddress, isAddress, parseAbi, parseSignature, recoverTypedDataAddress, verifyMessage, verifyTypedData, type Abi, type Address, type Hex, type Log } from "viem";
import {
  caip2,
  devUSDGAbi,
  iMerchantSplitterAbi,
  iMerchantSplitterFactoryAbi,
  permit2Domain,
  permit2WitnessTypes,
  transferWithAuthorizationTypes,
  x402Permit2ProxyAbi,
  type FacilitatorRequest,
  type PublicPaymentPayload,
  type PublicPaymentRequirements,
  type ReleaseFeature,
  type SettlementResponse,
  type VerifyResponse,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config, FacilitatorConfig } from "./config.js";
import type { Sql } from "./db.js";
import { blockTimes } from "./orry-indexer.js";
import { releasesFor } from "./releases.js";

/**
 * Wave 3: Orrery's public x402 facilitator on 4663 (R-57, utilities 1, 4, 6, 11). Any merchant settles x402 `exact`
 * payments through `/v1/x402/{supported,verify,settle}` as long as its `payTo` is its Orrery splitter
 * (`MerchantSplitterFactory`), which takes the 0.2% fee (less the merchant's stake discount) when it forwards. USDG
 * settles by EIP-3009; ORRY by a Permit2 witness transfer through `X402Permit2Proxy`. The relayer pays the gas.
 * Settlement is idempotent per (asset, payer, nonce): the row is written before the broadcast.
 */

const permit2Abi = parseAbi(["function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)"]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)"]);
const feeTiersAbi = parseAbi(["function stakeUsd(address account) view returns (uint256)", "function discountBps(address account) view returns (uint16)"]);
const lower = (a: string) => a.toLowerCase();
const STATE_ID = "facilitator";

type Fail = { ok: false; reason: string; payer?: Address };
type Pass = { ok: true; payer: Address; method: "eip3009" | "permit2"; nonce: string; amount: bigint };

/** In-memory, per process: the splitter check and a per-payee settlement rate. */
const splitterCache = new Map<string, boolean>();
const hits = new Map<string, number[]>();
function rateOk(payTo: string, perMinute: number): boolean {
  const now = Date.now();
  const list = (hits.get(payTo) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) return false;
  list.push(now);
  hits.set(payTo, list);
  return true;
}

async function isSplitter(chain: Chain, f: FacilitatorConfig, payTo: Address): Promise<boolean> {
  const k = lower(payTo);
  if (splitterCache.get(k)) return true;
  const ok = (await chain.public.readContract({ address: f.factory, abi: iMerchantSplitterFactoryAbi as Abi, functionName: "isSplitter", args: [payTo] })) as boolean;
  if (ok) splitterCache.set(k, true);
  return ok;
}

async function chainNow(chain: Chain): Promise<bigint> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const block = await chain.public.getBlock();
  return block.timestamp > now ? block.timestamp : now;
}

/** The asset paths open now: USDG always (with `facilitator`), ORRY with `orry-x402` and a configured proxy. */
async function assets(cfg: Config, isOpen: (f: ReleaseFeature) => Promise<boolean>) {
  const out: { asset: Address; method: "eip3009" | "permit2" }[] = [{ asset: cfg.addresses.usdg, method: "eip3009" }];
  if (cfg.orry && cfg.facilitator?.permit2Proxy && (await isOpen("orry-x402"))) out.push({ asset: cfg.orry.token, method: "permit2" });
  return out;
}

/** Phase 1 of x402: every check that needs no chain write. */
export async function verifyPublic(
  cfg: Config,
  chain: Chain,
  req: FacilitatorRequest,
  isOpen: (f: ReleaseFeature) => Promise<boolean>,
): Promise<Pass | Fail> {
  const f = cfg.facilitator!;
  const p = req?.paymentPayload as PublicPaymentPayload | undefined;
  const r = req?.paymentRequirements as PublicPaymentRequirements | undefined;
  if (!p || !r || p.x402Version !== 2) return { ok: false, reason: "unsupported_version" };
  if (r.scheme !== "exact" || r.network !== caip2(cfg.chainId)) return { ok: false, reason: "unsupported_scheme_or_network" };
  if (!isAddress(r.asset) || !isAddress(r.payTo) || !/^\d{1,78}$/.test(r.amount ?? "")) return { ok: false, reason: "invalid_requirements" };
  const a = p.accepted;
  if (!a || lower(a.asset) !== lower(r.asset) || lower(a.payTo) !== lower(r.payTo) || a.amount !== r.amount) return { ok: false, reason: "payload_does_not_match_requirements" };
  const amount = BigInt(r.amount);
  if (amount === 0n) return { ok: false, reason: "invalid_amount" };
  const path = (await assets(cfg, isOpen)).find((x) => lower(x.asset) === lower(r.asset));
  if (!path) return { ok: false, reason: "unsupported_asset" };
  if (!(await isSplitter(chain, f, r.payTo))) return { ok: false, reason: "pay_to_is_not_a_orrery_merchant" };
  const now = await chainNow(chain);
  const sig = p.payload?.signature;
  if (!sig) return { ok: false, reason: "missing_signature" };

  if (path.method === "eip3009") {
    if (amount < f.minAmountUsdg) return { ok: false, reason: "amount_below_minimum" };
    const auth = p.payload.authorization;
    if (!auth || !isAddress(auth.from)) return { ok: false, reason: "missing_authorization" };
    if (lower(auth.to) !== lower(r.payTo)) return { ok: false, reason: "wrong_recipient", payer: auth.from };
    if (auth.value !== r.amount) return { ok: false, reason: "wrong_amount", payer: auth.from };
    if (BigInt(auth.validAfter) >= now) return { ok: false, reason: "not_yet_valid", payer: auth.from };
    if (BigInt(auth.validBefore) < now + BigInt(cfg.minValiditySeconds)) return { ok: false, reason: "expires_too_soon", payer: auth.from };
    const valid = await verifyTypedData({
      address: auth.from,
      domain: { name: cfg.usdgDomain.name, version: cfg.usdgDomain.version, chainId: cfg.chainId, verifyingContract: cfg.addresses.usdg },
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: { from: auth.from, to: auth.to, value: amount, validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: sig,
    }).catch(() => false);
    if (!valid) return { ok: false, reason: "invalid_signature", payer: auth.from };
    const [used, balance] = await Promise.all([
      chain.public.readContract({ address: cfg.addresses.usdg, abi: devUSDGAbi, functionName: "authorizationState", args: [auth.from, auth.nonce] }),
      chain.public.readContract({ address: cfg.addresses.usdg, abi: devUSDGAbi, functionName: "balanceOf", args: [auth.from] }),
    ]);
    if (used) return { ok: false, reason: "nonce_already_used", payer: auth.from };
    if (balance < amount) return { ok: false, reason: "insufficient_funds", payer: auth.from };
    return { ok: true, payer: getAddress(auth.from), method: "eip3009", nonce: auth.nonce, amount };
  }

  const pa = p.payload.permit2Authorization;
  if (!pa || !isAddress(pa.from)) return { ok: false, reason: "missing_authorization" };
  const proxy = f.permit2Proxy!;
  if (lower(pa.spender) !== lower(proxy)) return { ok: false, reason: "wrong_spender", payer: pa.from };
  if (lower(pa.witness?.to ?? "") !== lower(r.payTo)) return { ok: false, reason: "wrong_recipient", payer: pa.from };
  if (lower(pa.permitted.token) !== lower(r.asset) || pa.permitted.amount !== r.amount) return { ok: false, reason: "wrong_amount", payer: pa.from };
  if (BigInt(pa.deadline) < now + BigInt(cfg.minValiditySeconds)) return { ok: false, reason: "expires_too_soon", payer: pa.from };
  const signer = await recoverTypedDataAddress({
    domain: permit2Domain(cfg.chainId, f.permit2),
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: { permitted: { token: pa.permitted.token, amount }, spender: pa.spender, nonce: BigInt(pa.nonce), deadline: BigInt(pa.deadline), witness: { to: pa.witness.to } },
    signature: sig,
  }).catch(() => null);
  if (!signer || lower(signer) !== lower(pa.from)) return { ok: false, reason: "invalid_signature", payer: pa.from };
  const nonce = BigInt(pa.nonce);
  const [bitmap, allowance, balance] = await Promise.all([
    chain.public.readContract({ address: f.permit2, abi: permit2Abi, functionName: "nonceBitmap", args: [pa.from, nonce >> 8n] }),
    chain.public.readContract({ address: r.asset, abi: erc20Abi, functionName: "allowance", args: [pa.from, f.permit2] }),
    chain.public.readContract({ address: r.asset, abi: erc20Abi, functionName: "balanceOf", args: [pa.from] }),
  ]);
  if (((bitmap >> (nonce & 255n)) & 1n) === 1n) return { ok: false, reason: "nonce_already_used", payer: pa.from };
  if (allowance < amount) return { ok: false, reason: "permit2_not_approved", payer: pa.from };
  if (balance < amount) return { ok: false, reason: "insufficient_funds", payer: pa.from };
  return { ok: true, payer: getAddress(pa.from), method: "permit2", nonce: pa.nonce, amount };
}

/** Phase 2: verify, then broadcast once and wait for the receipt. */
export async function settlePublic(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  req: FacilitatorRequest,
  isOpen: (f: ReleaseFeature) => Promise<boolean>,
): Promise<SettlementResponse> {
  const network = caip2(cfg.chainId);
  const f = cfg.facilitator!;
  const r = req?.paymentRequirements;
  const fail = (errorReason: string, payer?: Address): SettlementResponse => ({ success: false, transaction: "", network, payer: payer ?? "", errorReason });
  if (!r || !isAddress(r.asset ?? "")) return fail("invalid_requirements");
  const assetKey = lower(r.asset);

  // A stored settlement answers the same payment again without a second broadcast.
  // A failed one (the transaction reverted, so the authorization is still unused) may be sent again after a fresh verify.
  const pre = req.paymentPayload?.payload;
  const payerHint = pre?.authorization?.from ?? pre?.permit2Authorization?.from;
  const nonceHint = pre?.authorization?.nonce ?? pre?.permit2Authorization?.nonce;
  if (payerHint && nonceHint) {
    const [row] = await sql<{ status: string; tx_hash: string | null }[]>`select status, tx_hash from facilitator_payments
      where asset = ${assetKey} and payer = ${lower(payerHint)} and nonce = ${String(nonceHint)}`;
    if (row?.status === "settled" && row.tx_hash) return { success: true, transaction: row.tx_hash as Hex, network, payer: getAddress(payerHint) };
    if (row?.status === "pending") return fail("settlement_in_progress", getAddress(payerHint));
  }

  const v = await verifyPublic(cfg, chain, req, isOpen);
  if (!v.ok) return fail(v.reason, v.payer);
  if (!rateOk(lower(r.payTo), f.ratePerMinute)) return fail("rate_limited", v.payer);
  const inserted = await sql`insert into facilitator_payments (asset, payer, nonce, pay_to, amount, method, status)
    values (${assetKey}, ${lower(v.payer)}, ${v.nonce}, ${lower(r.payTo)}, ${v.amount.toString()}, ${v.method}, 'pending')
    on conflict (asset, payer, nonce) do update set status = 'pending', tx_hash = null, updated_at = now()
      where facilitator_payments.status = 'failed'
    returning payer`;
  if (inserted.length === 0) return fail("settlement_in_progress", v.payer);

  const relayer = chain.wallet(cfg.relayerKey);
  const p = req.paymentPayload.payload;
  let hash: Hex;
  try {
    if (v.method === "eip3009") {
      const auth = p.authorization!;
      const { r: rr, s, v: vv, yParity } = parseSignature(p.signature);
      hash = await relayer.writeContract({
        address: cfg.addresses.usdg,
        abi: devUSDGAbi,
        functionName: "transferWithAuthorization",
        args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, Number(vv ?? BigInt(yParity + 27)), rr, s],
        chain: null,
        account: relayer.account,
      });
    } else {
      const pa = p.permit2Authorization!;
      hash = await relayer.writeContract({
        address: f.permit2Proxy!,
        abi: x402Permit2ProxyAbi as Abi,
        functionName: "settle",
        args: [{ permitted: { token: pa.permitted.token, amount: BigInt(pa.permitted.amount) }, nonce: BigInt(pa.nonce), deadline: BigInt(pa.deadline) }, pa.from, pa.witness.to, p.signature],
        chain: null,
        account: relayer.account,
      });
    }
  } catch {
    await sql`delete from facilitator_payments where asset = ${assetKey} and payer = ${lower(v.payer)} and nonce = ${v.nonce} and tx_hash is null`;
    return fail("broadcast_failed", v.payer);
  }
  await sql`update facilitator_payments set tx_hash = ${hash}, updated_at = now() where asset = ${assetKey} and payer = ${lower(v.payer)} and nonce = ${v.nonce}`;
  const receipt = await chain.public.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs }).catch(() => null);
  if (!receipt) return fail("settlement_pending", v.payer);
  const ok = receipt.status === "success";
  await sql`update facilitator_payments set status = ${ok ? "settled" : "failed"}, updated_at = now()
    where asset = ${assetKey} and payer = ${lower(v.payer)} and nonce = ${v.nonce}`;
  if (!ok) return fail("transaction_failed", v.payer);
  return { success: true, transaction: hash, network, payer: v.payer };
}

// ------------------------------------------------------------------ merchants

const stakeCache = new Map<string, { at: number; usd: bigint; discount: number }>();
/** The merchant's stake value (USD, 6 decimals) and discount from FeeTiers, cached five minutes; zeros without it. */
export async function stakeOf(cfg: Config, chain: Chain, account: Address): Promise<{ usd: bigint; discount: number }> {
  const tiers = cfg.facilitator?.feeTiers;
  if (!tiers) return { usd: 0n, discount: 0 };
  const k = lower(account);
  const hit = stakeCache.get(k);
  if (hit && Date.now() - hit.at < 300_000) return hit;
  const [usd, discount] = await Promise.all([
    chain.public.readContract({ address: tiers, abi: feeTiersAbi, functionName: "stakeUsd", args: [account] }).catch(() => 0n),
    chain.public.readContract({ address: tiers, abi: feeTiersAbi, functionName: "discountBps", args: [account] }).catch(() => 0),
  ]);
  const v = { at: Date.now(), usd: usd as bigint, discount: Number(discount) };
  stakeCache.set(k, v);
  return v;
}

/** Utility 1: extra included checks a month from the stake value (`quotaTiers`). */
export async function stakeQuota(cfg: Config, chain: Chain, account: Address): Promise<number> {
  const f = cfg.facilitator;
  if (!f || !f.feeTiers || f.quotaTiers.length === 0) return 0;
  const { usd } = await stakeOf(cfg, chain, account);
  let extra = 0;
  for (const [min, checks] of f.quotaTiers) if (usd >= min) extra = checks;
  return extra;
}

export function profileMessage(cfg: Config, merchant: Address, nonce: string, expiresAt: Date): string {
  return [
    "Update the public profile of an Orrery merchant",
    `Merchant: ${getAddress(merchant)}`,
    `Chain: ${cfg.chainId}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}

// ------------------------------------------------------------------ routes

export interface FacilitatorRouteDeps {
  allowPublic: (ip: string) => boolean;
  makeLimiter: (perMinute: number) => (ip: string) => boolean;
}

export function registerFacilitatorRoutes(app: FastifyInstance, cfg: Config, chain: Chain, sql: Sql, deps: FacilitatorRouteDeps): void {
  const f = cfg.facilitator;
  if (!f) return;
  const releases = releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs);
  const isOpen = (feature: ReleaseFeature) => releases.isOpen(feature);
  const allowSettle = deps.makeLimiter(Math.max(f.ratePerMinute * 5, 60));
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

  app.get("/v1/x402/supported", { preHandler: gate("facilitator") }, async () => {
    const list = await assets(cfg, isOpen);
    return {
      kinds: list.map((x) => ({
        x402Version: 2,
        scheme: "exact",
        network,
        asset: x.asset,
        extra: x.method === "eip3009" ? { assetTransferMethod: "eip3009", name: cfg.usdgDomain.name, version: cfg.usdgDomain.version } : { assetTransferMethod: "permit2", proxy: f.permit2Proxy, permit2: f.permit2 },
      })),
      payTo: "Per merchant Orrery payment address, listed at GET /v1/merchants/<address>",
      feeBps: 20,
    };
  });

  app.post("/v1/x402/verify", { preHandler: gate("facilitator", allowSettle) }, async (req): Promise<VerifyResponse> => {
    const v = await verifyPublic(cfg, chain, req.body as FacilitatorRequest, isOpen).catch(() => ({ ok: false as const, reason: "verify_failed" }));
    return v.ok ? { isValid: true, payer: v.payer } : { isValid: false, invalidReason: v.reason, payer: (v as { payer?: Address }).payer };
  });

  app.post("/v1/x402/settle", { preHandler: gate("facilitator", allowSettle) }, async (req) => {
    return settlePublic(cfg, chain, sql, req.body as FacilitatorRequest, isOpen).catch(() => ({ success: false, transaction: "", network, payer: "", errorReason: "settle_failed" }));
  });

  // A merchant's page: its payment address (known before it exists), stake, discount, badge and volume.
  app.get<{ Params: { address: string } }>("/v1/merchants/:address", { preHandler: gate("facilitator") }, async (req, reply) => {
    if (!isAddress(req.params.address)) return reply.code(400).send({ error: "Expected a 0x address." });
    const merchant = getAddress(req.params.address);
    const [splitter, row, stake, volume] = await Promise.all([
      chain.public.readContract({ address: f.factory, abi: iMerchantSplitterFactoryAbi as Abi, functionName: "splitterOf", args: [merchant] }) as Promise<Address>,
      sql<{ splitter: string; created_at: Date; name: string | null; url: string | null; description: string | null; last_forward_at: Date | null }[]>`select splitter, created_at, name, url, description, last_forward_at from merchants where merchant = ${lower(merchant)}`,
      stakeOf(cfg, chain, merchant),
      sql<{ asset: string; n: string; amount: string }[]>`select asset, count(*)::text as n, sum(amount)::text as amount from facilitator_payments
        where pay_to = (select splitter from merchants where merchant = ${lower(merchant)}) and status = 'settled' and created_at > now() - interval '30 days' group by asset`,
    ]);
    const m = row[0];
    const created = m ? true : ((await chain.public.readContract({ address: f.factory, abi: iMerchantSplitterFactoryAbi as Abi, functionName: "isSplitter", args: [splitter] })) as boolean);
    return {
      merchant,
      splitter: getAddress(splitter),
      created,
      feeBps: 20,
      discountBps: stake.discount,
      stakeUsd: stake.usd.toString(),
      badge: stake.usd >= f.badgeMinStakeUsd,
      badgeMinStakeUsd: f.badgeMinStakeUsd.toString(),
      profile: m ? { name: m.name, url: m.url, description: m.description } : null,
      lastForwardAt: m?.last_forward_at ? Math.floor(m.last_forward_at.getTime() / 1000) : null,
      settled30d: volume.map((x) => ({ asset: getAddress(x.asset), payments: Number(x.n), amount: x.amount })),
    };
  });

  // Utility 6: the directory lists merchants whose stake reaches the badge level and who wrote a profile.
  app.get("/v1/merchants", { preHandler: gate("merchant-badge") }, async () => {
    const rows = await sql<{ merchant: string; splitter: string; name: string; url: string | null; description: string | null }[]>`select merchant, splitter, name, url, description
      from merchants where name is not null order by profile_updated_at desc limit 500`;
    const listed = [];
    for (const r of rows) {
      const s = await stakeOf(cfg, chain, getAddress(r.merchant));
      if (s.usd >= f.badgeMinStakeUsd) listed.push({ merchant: getAddress(r.merchant), splitter: getAddress(r.splitter), name: r.name, url: r.url, description: r.description, stakeUsd: s.usd.toString() });
    }
    listed.sort((a, b) => (BigInt(b.stakeUsd) > BigInt(a.stakeUsd) ? 1 : -1));
    return { merchants: listed, badgeMinStakeUsd: f.badgeMinStakeUsd.toString() };
  });

  app.get<{ Querystring: { address?: string } }>("/v1/merchants/profile/nonce", { preHandler: gate("facilitator") }, async (req, reply) => {
    if (!isAddress(req.query.address ?? "")) return reply.code(400).send({ error: "Add ?address=0x... to the request." });
    const merchant = getAddress(req.query.address!);
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await sql`insert into merchant_profile_nonces (merchant, nonce, expires_at) values (${lower(merchant)}, ${nonce}, ${expiresAt})
      on conflict (merchant) do update set nonce = excluded.nonce, expires_at = excluded.expires_at`;
    return { nonce, message: profileMessage(cfg, merchant, nonce, expiresAt), expiresAt: expiresAt.toISOString() };
  });

  app.post("/v1/merchants/profile", { preHandler: gate("facilitator") }, async (req, reply) => {
    const b = (req.body ?? {}) as { merchant?: string; nonce?: string; signature?: Hex; name?: string; url?: string; description?: string };
    if (!isAddress(b.merchant ?? "") || !b.nonce || !b.signature) return reply.code(400).send({ error: "Required fields: merchant, nonce, signature, name." });
    const name = (b.name ?? "").trim();
    const url = (b.url ?? "").trim();
    const description = (b.description ?? "").trim();
    if (name.length < 2 || name.length > 40) return reply.code(400).send({ error: "Name length must be 2 to 40 characters." });
    if (url && (!/^https:\/\/[^\s]{3,200}$/.test(url))) return reply.code(400).send({ error: "Link must begin with https:// and stay within 200 characters." });
    if (description.length > 200) return reply.code(400).send({ error: "Description must stay within 200 characters." });
    const merchant = getAddress(b.merchant!);
    const [n] = await sql<{ nonce: string; expires_at: Date }[]>`select nonce, expires_at from merchant_profile_nonces where merchant = ${lower(merchant)}`;
    if (!n || n.nonce !== b.nonce || n.expires_at.getTime() < Date.now()) return reply.code(400).send({ error: "This sign-in message is past its expiry. Request a fresh one." });
    const ok = await verifyMessage({ address: merchant, message: profileMessage(cfg, merchant, n.nonce, n.expires_at), signature: b.signature }).catch(() => false);
    if (!ok) return reply.code(400).send({ error: "Signature and address disagree." });
    await sql`delete from merchant_profile_nonces where merchant = ${lower(merchant)}`;
    const updated = await sql`update merchants set name = ${name}, url = ${url || null}, description = ${description || null}, profile_updated_at = now()
      where merchant = ${lower(merchant)} returning merchant`;
    if (updated.length === 0) {
      // Created on chain but not indexed yet (the indexer waits for confirmations): keep the profile now; the indexer
      // fills in the block and transaction when SplitterCreated reaches it.
      const splitter = (await chain.public.readContract({ address: f.factory, abi: iMerchantSplitterFactoryAbi as Abi, functionName: "splitterOf", args: [merchant] })) as Address;
      if (!(await isSplitter(chain, f, splitter))) return reply.code(404).send({ error: "Set up your payment address before adding a profile." });
      await sql`insert into merchants (merchant, splitter, created_block, created_tx, created_at, name, url, description, profile_updated_at)
        values (${lower(merchant)}, ${lower(splitter)}, 0, '', now(), ${name}, ${url || null}, ${description || null}, now())
        on conflict (merchant) do update set name = excluded.name, url = excluded.url, description = excluded.description, profile_updated_at = now()`;
    }
    return { ok: true };
  });
}

// ------------------------------------------------------------------ indexer

const EVENTS_ABI = [...(iMerchantSplitterFactoryAbi as Abi), ...(iMerchantSplitterAbi as Abi)] as Abi;

export async function indexFacilitatorOnce(cfg: Config, chain: Chain, sql: Sql, range = 10_000n): Promise<{ last: bigint; head: bigint }> {
  const f = cfg.facilitator!;
  const [state] = await sql<{ last_block: string }[]>`select last_block from indexer_state where id = ${STATE_ID}`;
  const from = state ? BigInt(state.last_block) + 1n : f.startBlock;
  const head = await chain.public.getBlockNumber();
  const safe = head > BigInt(cfg.confirmations) ? head - BigInt(cfg.confirmations) : 0n;
  if (from > safe) return { last: from - 1n, head };
  const to = from + range - 1n < safe ? from + range - 1n : safe;
  const factoryLogs = (await chain.public.getLogs({ address: f.factory, fromBlock: from, toBlock: to })) as Log[];
  const created = factoryLogs.map((l) => decodeEventLog({ abi: EVENTS_ABI, data: l.data, topics: l.topics })).filter((d) => d.eventName === "SplitterCreated");
  const known = (await sql<{ splitter: string }[]>`select splitter from merchants`).map((x) => x.splitter as Address);
  const splitters = [...known, ...created.map((d) => (d.args as unknown as { splitter: Address }).splitter)];
  const splitterLogs = splitters.length ? ((await chain.public.getLogs({ address: splitters, fromBlock: from, toBlock: to })) as Log[]) : [];
  const all = [...factoryLogs, ...splitterLogs].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex! - y.logIndex! : x.blockNumber! < y.blockNumber! ? -1 : 1));
  const times = await blockTimes(chain, all);
  await sql.begin(async (tx) => {
    for (const log of all) {
      let d: { eventName: string; args: Record<string, unknown> };
      try {
        d = decodeEventLog({ abi: EVENTS_ABI, data: log.data, topics: log.topics }) as never;
      } catch {
        continue;
      }
      const args = Object.fromEntries(Object.entries(d.args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v]));
      const time = times.get(log.blockNumber!)!;
      const ins = await tx`insert into facilitator_events (block_number, log_index, tx_hash, address, event, args, block_time)
        values (${log.blockNumber!.toString()}, ${log.logIndex!}, ${log.transactionHash!}, ${lower(log.address)}, ${d.eventName}, ${tx.json(args as never)}, ${time})
        on conflict do nothing returning log_index`;
      if (ins.length !== 1) continue;
      if (d.eventName === "SplitterCreated") {
        // a row written early by a profile save keeps its profile and gets the creation block and transaction here
        await tx`insert into merchants (merchant, splitter, created_block, created_tx, created_at)
          values (${String(args.merchant)}, ${String(args.splitter)}, ${log.blockNumber!.toString()}, ${log.transactionHash!}, ${time})
          on conflict (merchant) do update set created_block = excluded.created_block, created_tx = excluded.created_tx, created_at = excluded.created_at`;
      } else if (d.eventName === "Forwarded") {
        await tx`update merchants set last_forward_at = ${time} where splitter = ${lower(log.address)}`;
      }
    }
    await tx`insert into indexer_state (id, last_block, head_block) values (${STATE_ID}, ${to.toString()}, ${head.toString()})
      on conflict (id) do update set last_block = excluded.last_block, head_block = excluded.head_block, updated_at = now()`;
  });
  return { last: to, head };
}

export async function runFacilitatorIndexer(cfg: Config, chain: Chain, sql: Sql, signal?: AbortSignal, log: (m: string) => void = () => {}): Promise<void> {
  while (!signal?.aborted) {
    try {
      const r = await indexFacilitatorOnce(cfg, chain, sql);
      if (r.head - r.last > BigInt(cfg.confirmations) + 1n) continue;
    } catch (e) {
      log(`facilitator indexer step failed: ${String(e).slice(0, 300)}`);
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

// ------------------------------------------------------------------ keeper: forward what splitters hold

/** Forwards each splitter's USDG once it holds `forwardMinUsdg`, or any USDG or ORRY after `forwardMaxAgeHours`. */
export async function forwardDue(cfg: Config, chain: Chain, sql: Sql, key: Hex, dryRun = false): Promise<{ splitter: string; token: string; status: string }[]> {
  const f = cfg.facilitator!;
  const out: { splitter: string; token: string; status: string }[] = [];
  const rows = await sql<{ splitter: string; last_forward_at: Date | null; created_at: Date }[]>`select splitter, last_forward_at, created_at from merchants`;
  const wallet = chain.wallet(key);
  const tokens = [cfg.addresses.usdg, ...(cfg.orry ? [cfg.orry.token] : [])];
  for (const r of rows) {
    const since = (r.last_forward_at ?? r.created_at).getTime();
    const old = Date.now() - since > f.forwardMaxAgeHours * 3_600_000;
    for (const token of tokens) {
      const bal = (await chain.public.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [r.splitter as Address] })) as bigint;
      const due = bal > 0n && (old || (token === cfg.addresses.usdg && bal >= f.forwardMinUsdg));
      if (!due) continue;
      if (dryRun) {
        out.push({ splitter: r.splitter, token, status: "due" });
        continue;
      }
      try {
        const hash = await wallet.writeContract({ address: r.splitter as Address, abi: iMerchantSplitterAbi as Abi, functionName: "forward", args: [token], chain: null, account: wallet.account });
        const rc = await chain.public.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs });
        out.push({ splitter: r.splitter, token, status: rc.status === "success" ? "sent" : "reverted" });
      } catch (e) {
        out.push({ splitter: r.splitter, token, status: `failed: ${String(e).slice(0, 120)}` });
      }
    }
  }
  return out;
}
