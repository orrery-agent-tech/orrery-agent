import { randomBytes } from "node:crypto";
import { getAddress, isAddress, parseAbi, parseEventLogs, parseSignature, recoverTypedDataAddress, toHex, verifyTypedData, type Abi, type Address, type Hex } from "viem";
import {
  caip2,
  devUSDGAbi,
  packCallsFor,
  permit2Domain,
  permit2WitnessTypes,
  transferWithAuthorizationTypes,
  x402Permit2ProxyAbi,
  type DataPaymentRequirements,
  type PublicPaymentPayload,
  type ReleaseFeature,
} from "@orrery/shared";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { quotePrice, orryForUsd } from "./orry-price.js";
import { stakeOf } from "./facilitator-public.js";

/**
 * Lane L2: data packs (D-2 to D-5). A pack is `packCalls` calls at `callUsd` each. USDG pays the full price to the
 * treasury by EIP-3009; ORRY pays 20% less (R-60) to `DataFeeSplitter` by a Permit2 witness transfer through
 * `X402Permit2Proxy`, at a stored quote. The API's relayer broadcasts; a payment counts only when its receipt holds the
 * asset's `Transfer(payer -> payTo, amount)`, and grants calls once.
 */

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const permit2Abi = parseAbi(["function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)"]);
const lower = (a: string) => a.toLowerCase();
const BPS = 10_000n;

export const packUsd = (cfg: Config): bigint => cfg.data!.callUsd * BigInt(cfg.data!.packCalls);
/** ORRY pays this USD (USDG base units): the pack price less the ORRY discount, rounded down. */
export const packUsdInOrry = (cfg: Config): bigint => (packUsd(cfg) * (BPS - BigInt(cfg.data!.orryDiscountBps))) / BPS;

/** ORRY payment is open when the splitter, the proxy and the ORRY contracts are configured and `orry-x402` is open. */
export async function orryPackOpen(cfg: Config, isOpen: (f: ReleaseFeature) => Promise<boolean>): Promise<boolean> {
  const d = cfg.data;
  return !!(d?.splitter && d.permit2Proxy && cfg.orry) && (await isOpen("orry-x402"));
}

export function usdgPackRequirement(cfg: Config): DataPaymentRequirements {
  return {
    scheme: "exact",
    network: caip2(cfg.chainId),
    amount: packUsd(cfg).toString(),
    asset: getAddress(cfg.addresses.usdg),
    payTo: getAddress(cfg.treasury),
    maxTimeoutSeconds: 300,
    extra: { name: cfg.usdgDomain.name, version: cfg.usdgDomain.version, assetTransferMethod: "eip3009", calls: cfg.data!.packCalls },
  };
}

export type OrryQuote = { ok: true; requirement: DataPaymentRequirements } | { ok: false; error: string };

/** A fresh ORRY requirement at a stored quote (D-4). */
export async function orryPackRequirement(cfg: Config, chain: Chain, sql: Sql): Promise<OrryQuote> {
  const d = cfg.data!;
  const price = await quotePrice(cfg, chain, sql).catch(() => null);
  if (!price || !price.ok) return { ok: false, error: "ORRY price readings are still being sampled. USDG works now, or retry ORRY in a few minutes." };
  const usd = packUsdInOrry(cfg);
  const amount = orryForUsd(usd, price.ratio);
  const quoteId = toHex(randomBytes(32));
  const block = await chain.public.getBlock();
  const expires = new Date(Number(block.timestamp + BigInt(d.quoteTtlSeconds)) * 1000);
  await sql`insert into data_orry_quotes (quote_id, amount, usd, expires_at) values (${quoteId}, ${amount.toString()}, ${usd.toString()}, ${expires})`;
  await sql`delete from data_orry_quotes where expires_at < now() - interval '1 day'`;
  return {
    ok: true,
    requirement: {
      scheme: "exact",
      network: caip2(cfg.chainId),
      amount: amount.toString(),
      asset: getAddress(cfg.orry!.token),
      payTo: getAddress(d.splitter!),
      maxTimeoutSeconds: d.quoteTtlSeconds,
      extra: { assetTransferMethod: "permit2", proxy: getAddress(d.permit2Proxy!), permit2: getAddress(d.permit2), quoteId, usd: usd.toString(), calls: d.packCalls },
    },
  };
}

async function chainNow(chain: Chain): Promise<bigint> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const block = await chain.public.getBlock();
  return block.timestamp > now ? block.timestamp : now;
}

type Fail = { ok: false; reason: string; payer?: Address };
type Pass = { ok: true; payer: Address; method: "eip3009" | "permit2"; nonce: string; amount: bigint; quoteId: Hex | null };

/** Every check of a pack payment that needs no chain write (DA-6). */
export async function verifyPackPayment(cfg: Config, chain: Chain, sql: Sql, p: PublicPaymentPayload | undefined, orryOpen: boolean): Promise<Pass | Fail> {
  const d = cfg.data!;
  const a = p?.accepted as DataPaymentRequirements | undefined;
  if (!p || p.x402Version !== 2 || !a) return { ok: false, reason: "unsupported_version" };
  if (a.scheme !== "exact" || a.network !== caip2(cfg.chainId)) return { ok: false, reason: "unsupported_scheme_or_network" };
  if (!isAddress(a.asset ?? "") || !isAddress(a.payTo ?? "") || !/^\d{1,78}$/.test(a.amount ?? "")) return { ok: false, reason: "invalid_requirements" };
  const sig = p.payload?.signature;
  if (!sig) return { ok: false, reason: "missing_signature" };
  const amount = BigInt(a.amount);
  const now = await chainNow(chain);

  if (lower(a.asset) === lower(cfg.addresses.usdg)) {
    if (lower(a.payTo) !== lower(cfg.treasury)) return { ok: false, reason: "wrong_pay_to" };
    if (amount !== packUsd(cfg)) return { ok: false, reason: "wrong_amount" };
    const auth = p.payload.authorization;
    if (!auth || !isAddress(auth.from)) return { ok: false, reason: "missing_authorization" };
    if (lower(auth.to) !== lower(cfg.treasury)) return { ok: false, reason: "wrong_recipient", payer: auth.from };
    if (auth.value !== a.amount) return { ok: false, reason: "wrong_amount", payer: auth.from };
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
    return { ok: true, payer: getAddress(auth.from), method: "eip3009", nonce: auth.nonce, amount, quoteId: null };
  }

  if (!orryOpen || !cfg.orry || lower(a.asset) !== lower(cfg.orry.token)) return { ok: false, reason: "unsupported_asset" };
  if (lower(a.payTo) !== lower(d.splitter!)) return { ok: false, reason: "wrong_pay_to" };
  const quoteId = a.extra?.quoteId;
  if (!quoteId || !/^0x[0-9a-f]{64}$/i.test(quoteId)) return { ok: false, reason: "missing_quote" };
  const [q] = await sql<{ amount: string; expires_at: Date; used_by: string | null }[]>`select amount::text as amount, expires_at, used_by from data_orry_quotes where quote_id = ${lower(quoteId)}`;
  if (!q) return { ok: false, reason: "unknown_quote" };
  if (q.expires_at.getTime() / 1000 < Number(now)) return { ok: false, reason: "quote_expired" };
  if (BigInt(q.amount) !== amount) return { ok: false, reason: "wrong_amount" };
  const pa = p.payload.permit2Authorization;
  if (!pa || !isAddress(pa.from)) return { ok: false, reason: "missing_authorization" };
  if (q.used_by && q.used_by !== lower(pa.from)) return { ok: false, reason: "quote_used", payer: pa.from };
  if (lower(pa.spender) !== lower(d.permit2Proxy!)) return { ok: false, reason: "wrong_spender", payer: pa.from };
  if (lower(pa.witness?.to ?? "") !== lower(d.splitter!)) return { ok: false, reason: "wrong_recipient", payer: pa.from };
  if (lower(pa.permitted.token) !== lower(a.asset) || pa.permitted.amount !== a.amount) return { ok: false, reason: "wrong_amount", payer: pa.from };
  if (BigInt(pa.deadline) < now + BigInt(cfg.minValiditySeconds)) return { ok: false, reason: "expires_too_soon", payer: pa.from };
  const signer = await recoverTypedDataAddress({
    domain: permit2Domain(cfg.chainId, d.permit2),
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: { permitted: { token: pa.permitted.token, amount }, spender: pa.spender, nonce: BigInt(pa.nonce), deadline: BigInt(pa.deadline), witness: { to: pa.witness.to } },
    signature: sig,
  }).catch(() => null);
  if (!signer || lower(signer) !== lower(pa.from)) return { ok: false, reason: "invalid_signature", payer: pa.from };
  const nonce = BigInt(pa.nonce);
  const [bitmap, allowance, balance] = await Promise.all([
    chain.public.readContract({ address: d.permit2, abi: permit2Abi, functionName: "nonceBitmap", args: [pa.from, nonce >> 8n] }),
    chain.public.readContract({ address: a.asset, abi: erc20Abi, functionName: "allowance", args: [pa.from, d.permit2] }),
    chain.public.readContract({ address: a.asset, abi: erc20Abi, functionName: "balanceOf", args: [pa.from] }),
  ]);
  if (((bitmap >> (nonce & 255n)) & 1n) === 1n) return { ok: false, reason: "nonce_already_used", payer: pa.from };
  if (allowance < amount) return { ok: false, reason: "permit2_not_approved", payer: pa.from };
  if (balance < amount) return { ok: false, reason: "insufficient_funds", payer: pa.from };
  return { ok: true, payer: getAddress(pa.from), method: "permit2", nonce: pa.nonce, amount, quoteId: lower(quoteId) as Hex };
}

export type PackOutcome =
  | { ok: true; payer: Address; calls: bigint; granted: bigint; txHash: Hex }
  | { ok: false; reason: string; payer?: Address; txHash?: Hex };

/** The calls this payer's pack grants now: the stake discount paid as calls (D-5). */
export async function callsForPayer(cfg: Config, chain: Chain, payer: Address): Promise<number> {
  const d = cfg.data!;
  let discount = 0;
  if (d.feeTiers) {
    const tiers = { ...cfg, facilitator: { ...(cfg.facilitator ?? {}), feeTiers: d.feeTiers } } as unknown as Config;
    discount = (await stakeOf(tiers, chain, payer).catch(() => ({ discount: 0 }))).discount;
  }
  return packCallsFor(d.packCalls, discount, d.maxStakeDiscountBps);
}

/**
 * Settles one pack payment: verify, write the row, broadcast once, wait for the receipt, check the asset's Transfer,
 * then grant the calls in the same transaction that marks the row settled (DA-5). A stored settlement answers the same
 * payment again without a second broadcast or grant.
 */
export async function settlePack(cfg: Config, chain: Chain, sql: Sql, p: PublicPaymentPayload | undefined, orryOpen: boolean): Promise<PackOutcome> {
  const d = cfg.data!;
  const pre = p?.payload;
  const payerHint = pre?.authorization?.from ?? pre?.permit2Authorization?.from;
  const nonceHint = pre?.authorization?.nonce ?? pre?.permit2Authorization?.nonce;
  const assetHint = p?.accepted?.asset;
  if (payerHint && nonceHint && assetHint) {
    const [row] = await sql<{ status: string; tx_hash: string | null; calls: string | null }[]>`select status, tx_hash, calls::text as calls from data_payments
      where asset = ${lower(assetHint)} and payer = ${lower(payerHint)} and nonce = ${String(nonceHint)}`;
    if (row?.status === "settled" && row.tx_hash) {
      const [acc] = await sql<{ calls: string }[]>`select calls::text as calls from data_accounts where address = ${lower(payerHint)}`;
      return { ok: true, payer: getAddress(payerHint), calls: BigInt(acc?.calls ?? 0), granted: 0n, txHash: row.tx_hash as Hex };
    }
    if (row?.status === "pending") return { ok: false, reason: "settlement_in_progress", payer: getAddress(payerHint) };
  }

  const v = await verifyPackPayment(cfg, chain, sql, p, orryOpen);
  if (!v.ok) return { ok: false, reason: v.reason, payer: v.payer };
  const a = p!.accepted;
  const assetKey = lower(a.asset);
  if (v.quoteId) {
    // claim the quote for this payer before the broadcast; a second payer of the same quote is refused
    const claimed = await sql`update data_orry_quotes set used_by = ${lower(v.payer)} where quote_id = ${v.quoteId} and (used_by is null or used_by = ${lower(v.payer)}) returning quote_id`;
    if (claimed.length === 0) return { ok: false, reason: "quote_used", payer: v.payer };
  }
  const inserted = await sql`insert into data_payments (asset, payer, nonce, pay_to, amount, method, quote_id, status)
    values (${assetKey}, ${lower(v.payer)}, ${v.nonce}, ${lower(a.payTo)}, ${v.amount.toString()}, ${v.method}, ${v.quoteId}, 'pending')
    on conflict (asset, payer, nonce) do update set status = 'pending', tx_hash = null, updated_at = now()
      where data_payments.status = 'failed'
    returning payer`;
  if (inserted.length === 0) return { ok: false, reason: "settlement_in_progress", payer: v.payer };

  const relayer = chain.wallet(cfg.relayerKey);
  const sig = p!.payload.signature;
  let hash: Hex;
  try {
    if (v.method === "eip3009") {
      const auth = p!.payload.authorization!;
      const { r, s, v: vv, yParity } = parseSignature(sig);
      hash = await relayer.writeContract({
        address: cfg.addresses.usdg,
        abi: devUSDGAbi,
        functionName: "transferWithAuthorization",
        args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, Number(vv ?? BigInt(yParity + 27)), r, s],
        chain: null,
        account: relayer.account,
      });
    } else {
      const pa = p!.payload.permit2Authorization!;
      hash = await relayer.writeContract({
        address: d.permit2Proxy!,
        abi: x402Permit2ProxyAbi as Abi,
        functionName: "settle",
        args: [{ permitted: { token: pa.permitted.token, amount: BigInt(pa.permitted.amount) }, nonce: BigInt(pa.nonce), deadline: BigInt(pa.deadline) }, pa.from, pa.witness.to, sig],
        chain: null,
        account: relayer.account,
      });
    }
  } catch {
    await sql`delete from data_payments where asset = ${assetKey} and payer = ${lower(v.payer)} and nonce = ${v.nonce} and tx_hash is null`;
    return { ok: false, reason: "broadcast_failed", payer: v.payer };
  }
  await sql`update data_payments set tx_hash = ${hash}, updated_at = now() where asset = ${assetKey} and payer = ${lower(v.payer)} and nonce = ${v.nonce}`;
  const receipt = await chain.public.waitForTransactionReceipt({ hash, timeout: cfg.receiptTimeoutMs }).catch(() => null);
  if (!receipt) return { ok: false, reason: "settlement_pending", payer: v.payer, txHash: hash };
  // the payment counts only when the asset moved exactly this amount from the payer to the payee (a USDG replay moves nothing)
  const moved =
    receipt.status === "success" &&
    parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).some(
      (l) => lower(l.address) === assetKey && lower(l.args.from) === lower(v.payer) && lower(l.args.to) === lower(a.payTo) && l.args.value === v.amount,
    );
  if (!moved) {
    await sql`update data_payments set status = 'failed', updated_at = now() where asset = ${assetKey} and payer = ${lower(v.payer)} and nonce = ${v.nonce}`;
    return { ok: false, reason: "transaction_failed", payer: v.payer, txHash: hash };
  }
  const granted = BigInt(await callsForPayer(cfg, chain, v.payer));
  const total = await sql.begin(async (tx) => {
    const marked = await tx`update data_payments set status = 'settled', calls = ${granted.toString()}, updated_at = now()
      where asset = ${assetKey} and payer = ${lower(v.payer)} and nonce = ${v.nonce} and status = 'pending' returning payer`;
    if (marked.length === 0) return null;
    const [acc] = await tx<{ calls: string }[]>`insert into data_accounts (address, calls) values (${lower(v.payer)}, ${granted.toString()})
      on conflict (address) do update set calls = data_accounts.calls + excluded.calls, updated_at = now() returning calls::text as calls`;
    return BigInt(acc!.calls);
  });
  if (total === null) return { ok: false, reason: "settlement_in_progress", payer: v.payer, txHash: hash };
  return { ok: true, payer: v.payer, calls: total, granted, txHash: hash };
}

/** Spends one call of `address` (DA-7): an atomic decrement that never goes below zero. Null when none is left. */
export async function spendDataCall(sql: Sql, address: Address): Promise<bigint | null> {
  const [row] = await sql<{ calls: string }[]>`update data_accounts set calls = calls - 1, updated_at = now()
    where address = ${lower(address)} and calls > 0 returning calls::text as calls`;
  return row ? BigInt(row.calls) : null;
}

/** Gives back a call spent on a request that failed before an answer was signed. */
export async function refundDataCall(sql: Sql, address: Address): Promise<void> {
  await sql`update data_accounts set calls = calls + 1, updated_at = now() where address = ${lower(address)}`;
}

export async function dataCallsOf(sql: Sql, address: Address): Promise<bigint> {
  const [row] = await sql<{ calls: string }[]>`select calls::text as calls from data_accounts where address = ${lower(address)}`;
  return BigInt(row?.calls ?? 0);
}
