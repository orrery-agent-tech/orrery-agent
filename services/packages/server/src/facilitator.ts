import { decodeEventLog, parseAbiItem, parseSignature, verifyTypedData, type Address, type Hex } from "viem";
import { devUSDGAbi, caip2, transferWithAuthorizationTypes, type PaymentPayload, type PaymentRequirements } from "@orrery/shared";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";

/**
 * Internal x402 facilitator for USDG (14 §2). Idempotent per (payer, nonce). USDG replays succeed silently and move
 * nothing, so a payment counts only when a receipt holds Transfer(payer -> treasury, price).
 */

export type SettleOutcome =
  | { ok: true; payer: Address; nonce: Hex; txHash: Hex; granted: boolean; product: Product }
  | { ok: false; reason: string; payer?: Address; nonce?: Hex; txHash?: Hex };

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const authorizationUsedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

/** What a USDG payment buys (R-58): a credit pack, or the platform plan. Told apart by the amount paid. */
export type Product = "pack" | "plan";

export const priceOf = (cfg: Config, product: Product): bigint => (product === "plan" ? cfg.pricing.planPrice : cfg.packPrice);

export function productFor(cfg: Config, amount: bigint): Product | null {
  if (amount === cfg.packPrice) return "pack";
  if (amount === cfg.pricing.planPrice) return "plan";
  return null;
}

/** Credits a product grants. */
export const creditsFor = (cfg: Config, product: Product): number => (product === "plan" ? cfg.pricing.planCredits : cfg.packSize);

export function requirements(cfg: Config, product: Product = "pack"): PaymentRequirements {
  return {
    scheme: "exact",
    network: caip2(cfg.chainId),
    amount: priceOf(cfg, product).toString(),
    asset: cfg.addresses.usdg,
    payTo: cfg.treasury,
    maxTimeoutSeconds: 300,
    extra: { name: cfg.usdgDomain.name, version: cfg.usdgDomain.version, assetTransferMethod: "eip3009" },
  };
}

/** Phase 1: checks that need no chain write. Returns a reason string on failure. */
export async function verifyPayment(cfg: Config, chain: Chain, p: PaymentPayload): Promise<string | null> {
  const req = requirements(cfg);
  if (p?.x402Version !== 2) return "unsupported_version";
  const a = p.accepted;
  if (!a || a.scheme !== "exact" || a.network !== req.network) return "unsupported_scheme_or_network";
  if (a.asset?.toLowerCase() !== req.asset.toLowerCase()) return "wrong_asset";
  if (a.payTo?.toLowerCase() !== req.payTo.toLowerCase()) return "wrong_pay_to";
  const auth = p.payload?.authorization;
  if (!auth || !p.payload.signature) return "missing_authorization";
  if (auth.to.toLowerCase() !== cfg.treasury.toLowerCase()) return "wrong_recipient";
  if (!productFor(cfg, BigInt(auth.value))) return "wrong_amount";
  const now = BigInt(Math.floor(Date.now() / 1000));
  const block = await chain.public.getBlock();
  const chainNow = block.timestamp > now ? block.timestamp : now;
  if (BigInt(auth.validAfter) >= chainNow) return "not_yet_valid";
  if (BigInt(auth.validBefore) < chainNow + BigInt(cfg.minValiditySeconds)) return "expires_too_soon";
  const valid = await verifyTypedData({
    address: auth.from,
    domain: { name: cfg.usdgDomain.name, version: cfg.usdgDomain.version, chainId: cfg.chainId, verifyingContract: cfg.addresses.usdg },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: p.payload.signature,
  });
  if (!valid) return "invalid_signature";
  return null;
}

async function grantOnce(cfg: Config, sql: Sql, payer: Address, nonce: Hex, product: Product): Promise<boolean> {
  const credits = creditsFor(cfg, product);
  return sql.begin(async (tx) => {
    const ins = await tx`insert into credit_grants (payer, nonce, credits, kind) values (${payer.toLowerCase()}, ${nonce}, ${credits}, ${product})
      on conflict do nothing returning payer`;
    if (ins.length === 0) return false;
    await tx`insert into credit_accounts (address, credits) values (${payer.toLowerCase()}, ${credits})
      on conflict (address) do update set credits = credit_accounts.credits + ${credits}`;
    // A plan bought while one runs extends it.
    if (product === "plan") {
      await tx`update credit_accounts set plan_until = greatest(coalesce(plan_until, now()), now()) + make_interval(days => ${cfg.pricing.planDays})
        where address = ${payer.toLowerCase()}`;
    }
    return true;
  });
}

/** True when the receipt of `txHash` holds Transfer(payer -> treasury, amount) emitted by USDG. */
async function receiptPays(cfg: Config, chain: Chain, txHash: Hex, payer: Address, amount: bigint): Promise<boolean | null> {
  let receipt;
  try {
    receipt = await chain.public.getTransactionReceipt({ hash: txHash });
  } catch {
    return null; // not mined (yet)
  }
  if (receipt.status !== "success") return false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.addresses.usdg.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
      if (
        ev.args.from.toLowerCase() === payer.toLowerCase() &&
        ev.args.to.toLowerCase() === cfg.treasury.toLowerCase() &&
        ev.args.value === amount
      ) {
        return true;
      }
    } catch {
      /* other event */
    }
  }
  return false;
}

async function findUsingTx(cfg: Config, chain: Chain, payer: Address, nonce: Hex): Promise<Hex | null> {
  const head = await chain.public.getBlockNumber();
  const from = head > 50_000n ? head - 50_000n : 0n;
  const logs = await chain.public.getLogs({
    address: cfg.addresses.usdg,
    event: authorizationUsedEvent,
    args: { authorizer: payer, nonce },
    fromBlock: from,
    toBlock: head,
  });
  return logs[0]?.transactionHash ?? null;
}

async function finish(cfg: Config, chain: Chain, sql: Sql, payer: Address, nonce: Hex, txHash: Hex, amount: bigint): Promise<SettleOutcome> {
  const product = productFor(cfg, amount);
  if (!product) return { ok: false, reason: "wrong_amount", payer, nonce, txHash };
  const pays = await receiptPays(cfg, chain, txHash, payer, amount);
  if (pays === null) return { ok: false, reason: "settlement_pending", payer, nonce, txHash };
  if (!pays) {
    await sql`update payments set status = 'failed', error = 'no_matching_transfer', updated_at = now()
      where payer = ${payer.toLowerCase()} and nonce = ${nonce}`;
    return { ok: false, reason: "no_matching_transfer", payer, nonce, txHash };
  }
  await sql`update payments set status = 'settled', tx_hash = ${txHash}, updated_at = now()
    where payer = ${payer.toLowerCase()} and nonce = ${nonce}`;
  const granted = await grantOnce(cfg, sql, payer, nonce, product);
  return { ok: true, payer, nonce, txHash, granted, product };
}

/** Phase 2: settle, idempotently. Safe to call again with the same payload after a timeout. */
export async function settlePayment(cfg: Config, chain: Chain, sql: Sql, p: PaymentPayload): Promise<SettleOutcome> {
  const reason = await verifyPayment(cfg, chain, p);
  if (reason) return { ok: false, reason };
  const auth = p.payload.authorization;
  const payer = auth.from;
  const nonce = auth.nonce;

  // Row before broadcast: the primary key stops a second worker.
  const inserted = await sql`insert into payments (payer, nonce, amount, status)
    values (${payer.toLowerCase()}, ${nonce}, ${auth.value}, 'pending') on conflict do nothing returning payer`;
  // The stored amount decides what a row settles, never a later payload reusing its nonce with another value.
  let amount = BigInt(auth.value);
  if (inserted.length === 0) {
    const [row] = await sql<{ status: string; tx_hash: string | null; amount: string }[]>`select status, tx_hash, amount from payments
      where payer = ${payer.toLowerCase()} and nonce = ${nonce}`;
    if (row) amount = BigInt(row.amount);
    const product = productFor(cfg, amount) ?? "pack";
    if (row?.status === "settled" && row.tx_hash) return { ok: true, payer, nonce, txHash: row.tx_hash as Hex, granted: false, product };
    if (row?.status === "failed") return { ok: false, reason: "payment_failed", payer, nonce };
    if (row?.tx_hash) return finish(cfg, chain, sql, payer, nonce, row.tx_hash as Hex, amount);
  }

  // A used nonce is never broadcast again: find the transaction that used it.
  const used = await chain.public.readContract({
    address: cfg.addresses.usdg,
    abi: devUSDGAbi,
    functionName: "authorizationState",
    args: [payer, nonce],
  });
  if (used) {
    const tx = await findUsingTx(cfg, chain, payer, nonce);
    if (!tx) return { ok: false, reason: "nonce_used_elsewhere", payer, nonce };
    await sql`update payments set tx_hash = ${tx}, updated_at = now() where payer = ${payer.toLowerCase()} and nonce = ${nonce}`;
    return finish(cfg, chain, sql, payer, nonce, tx, amount);
  }

  const balance = await chain.public.readContract({
    address: cfg.addresses.usdg,
    abi: devUSDGAbi,
    functionName: "balanceOf",
    args: [payer],
  });
  if (balance < BigInt(auth.value)) {
    await sql`delete from payments where payer = ${payer.toLowerCase()} and nonce = ${nonce} and tx_hash is null`;
    return { ok: false, reason: "insufficient_funds", payer, nonce };
  }

  const { r, s, v, yParity } = parseSignature(p.payload.signature);
  const vv = Number(v ?? BigInt(yParity + 27));
  const relayer = chain.wallet(cfg.relayerKey);
  let txHash: Hex;
  try {
    txHash = await relayer.writeContract({
      address: cfg.addresses.usdg,
      abi: devUSDGAbi,
      functionName: "transferWithAuthorization",
      args: [payer, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), nonce, vv, r, s],
      chain: null,
      account: relayer.account,
    });
  } catch {
    await sql`delete from payments where payer = ${payer.toLowerCase()} and nonce = ${nonce} and tx_hash is null`;
    return { ok: false, reason: "broadcast_failed", payer, nonce };
  }
  await sql`update payments set tx_hash = ${txHash}, updated_at = now() where payer = ${payer.toLowerCase()} and nonce = ${nonce}`;
  try {
    await chain.public.waitForTransactionReceipt({
      hash: txHash,
      confirmations: cfg.confirmations,
      timeout: cfg.receiptTimeoutMs,
    });
  } catch {
    return { ok: false, reason: "settlement_pending", payer, nonce, txHash };
  }
  return finish(cfg, chain, sql, payer, nonce, txHash, amount);
}
