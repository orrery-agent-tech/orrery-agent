import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  checkDomain,
  checkTypesFor,
  iOrryStakingAbi,
  orreryLensAbi,
  AccountKind,
  SessionStatus,
  type CheckResult,
  type CheckResultV2,
  type CheckVersion,
} from "@orrery/shared";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { Sql } from "./db.js";
import { attestIfNeeded, loadProbe, probeAgent, storeProbe } from "./prober.js";
import { releasesFor } from "./releases.js";

/**
 * Builds and signs the check result of 14 §4 from the on-chain OrreryLens view plus a fresh probe. While the ORRY stake
 * feature is open, the result is version 2 (domain version "2"): the v1 fields plus the agent's position (active,
 * leaving, leavingAt, lockedUntil, staker) from
 * `OrryStaking.agentStake(agentId)`. Version 1 results stay verifiable by the SDK.
 */
/** Version 2 (stake fields) while the `stake` release is open, by the runtime switch; version 1 otherwise. */
export const checkVersionOf = async (cfg: Config, sql: Sql): Promise<CheckVersion> =>
  cfg.orry && (await releasesFor(sql, cfg.releaseSeed, cfg.releasesCacheMs).isOpen("stake")) ? "2" : "1";

export type LensView = Awaited<ReturnType<typeof readLens>>;

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export async function readLens(cfg: Config, chain: Chain, by: { signer: Address } | { agentId: bigint; account: Address }) {
  if ("signer" in by) {
    return chain.public.readContract({ address: cfg.addresses.lens, abi: orreryLensAbi, functionName: "checkBySigner", args: [by.signer] });
  }
  return chain.public.readContract({ address: cfg.addresses.lens, abi: orreryLensAbi, functionName: "checkByAgent", args: [by.agentId, by.account] });
}

export function targetsHash(targets: readonly { target: Address; selector: Hex }[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "tuple[]", components: [{ type: "address", name: "target" }, { type: "bytes4", name: "selector" }] }],
      [targets.map((t) => ({ target: t.target, selector: t.selector }))],
    ),
  );
}

export interface SignedCheck {
  result: CheckResult | CheckResultV2;
  signature: Hex;
  checkSigner: Address;
  domain: ReturnType<typeof checkDomain<CheckVersion>>;
  extras: {
    targets: { target: Address; selector: Hex }[];
    coverage: string;
    probe: { probedAt: number; fresh: boolean } | null;
  };
}

export async function buildCheck(
  cfg: Config,
  chain: Chain,
  sql: Sql,
  by: { signer: Address } | { agentId: bigint; account: Address },
): Promise<SignedCheck> {
  const [view, blockNumber, block] = await Promise.all([readLens(cfg, chain, by), chain.public.getBlockNumber(), chain.public.getBlock()]);
  const now = block.timestamp;

  // Fresh probe for verified agents (cached up to probeFreshSeconds).
  let probe = view.verified ? await loadProbe(sql, view.agentId) : null;
  let fresh = false;
  if (view.verified && (!probe || Number(now) - probe.probedAt > cfg.probeFreshSeconds)) {
    const r = await probeAgent(cfg, chain, view.agentId);
    await storeProbe(sql, r);
    await attestIfNeeded(cfg, chain, sql, r, probe).catch(() => null);
    probe = await loadProbe(sql, view.agentId);
    fresh = true;
  } else if (probe) {
    fresh = Number(now) - probe.probedAt <= cfg.probeFreshSeconds;
  }

  const noWindow =
    view.status !== SessionStatus.Active ||
    !view.installed ||
    !view.bound ||
    view.accountKind === AccountKind.Unknown ||
    view.signerIsAccountOwner ||
    view.otherAccountModules ||
    view.signerHasCode;
  const probedAt = BigInt(probe?.probedAt ?? 0);
  let validUntil = view.validFor;
  if (probe && probedAt + BigInt(cfg.probeFreshSeconds) < validUntil) validUntil = probedAt + BigInt(cfg.probeFreshSeconds);
  if (noWindow || validUntil < now) validUntil = now;

  const result: CheckResult = {
    signer: view.signer,
    account: view.account,
    agentId: view.agentId,
    sessionEpoch: view.sessionEpoch,
    sessionCreatedAt: view.sessionCreatedAt,
    owner: view.owner,
    bound: view.bound,
    installed: view.installed,
    status: view.status,
    accountKind: view.accountKind,
    signerIsAccountOwner: view.signerIsAccountOwner,
    otherAccountModules: view.otherAccountModules,
    signerHasCode: view.signerHasCode,
    paidAt: view.paidAt,
    policyHash: view.policyHash,
    caps: view.caps.map((c) => ({ token: c.token, perTx: c.perTx, perDay: c.perDay, floatMax: c.floatMax, spentToday: c.spentToday })),
    targetsHash: targetsHash(view.targets),
    policyValidUntil: view.policyValidUntil,
    increaseDelay: view.increaseDelay,
    pendingHash: view.pendingHash,
    pendingReadyAt: view.pendingReadyAt,
    validFor: view.validFor,
    verified: view.verified,
    probedAt,
    endpointsLive: probe?.endpointsLive ?? false,
    registrationValid: probe?.registrationValid ?? false,
    domainVerified: probe?.domainVerified ?? false,
    issuedAt: now,
    validUntil,
    blockNumber,
  };
  const version = await checkVersionOf(cfg, sql);
  let signed: CheckResult | CheckResultV2 = result;
  if (version === "2") {
    const stake =
      view.agentId === 0n
        ? { staker: ZERO, active: 0n, leaving: 0n, leavingAt: 0n, lockedUntil: 0n }
        : await chain.public.readContract({ address: cfg.orry!.staking, abi: iOrryStakingAbi, functionName: "agentStake", args: [view.agentId], blockNumber });
    signed = {
      ...result,
      stakeActive: stake.active,
      stakeLeaving: stake.leaving,
      stakeLeavingAt: stake.leavingAt,
      stakeLockedUntil: stake.lockedUntil,
      stakedBy: stake.staker,
    };
  }
  const signerAccount = privateKeyToAccount(cfg.checkSignerKey);
  const domain = checkDomain(cfg.chainId, cfg.addresses.attestor, version);
  const signature = await signerAccount.signTypedData({ domain, types: checkTypesFor(version), primaryType: "CheckResult", message: signed as never });
  return {
    result: signed,
    signature,
    checkSigner: signerAccount.address,
    domain,
    extras: {
      targets: view.targets.map((t) => ({ target: t.target, selector: t.selector })),
      coverage: "caps cover outflows of the listed tokens and native ETH from this account, made by this signer",
      probe: probe ? { probedAt: probe.probedAt, fresh } : null,
    },
  };
}

/** JSON-safe form: bigints as decimal strings. */
export function toJson<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
