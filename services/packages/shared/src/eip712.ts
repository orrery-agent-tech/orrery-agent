import type { Address, Hex } from "viem";

/** Check result versions: "1" (14 §4) and "2" (ORRY build spec §5, adds the agent's ORRY stake). */
export type CheckVersion = "1" | "2";
export const CHECK_VERSIONS: readonly CheckVersion[] = ["1", "2"];

/** EIP-712 domain of the signed check result (14 §4): bound to the chain and the attestor; the version picks the type. */
export const checkDomain = <V extends CheckVersion = "1">(chainId: number, attestor: Address, version: V = "1" as V) =>
  ({ name: "Orrery Check", version, chainId, verifyingContract: attestor }) as const;

export const checkResultTypes = {
  TokenView: [
    { name: "token", type: "address" },
    { name: "perTx", type: "uint128" },
    { name: "perDay", type: "uint128" },
    { name: "floatMax", type: "uint128" },
    { name: "spentToday", type: "uint256" },
  ],
  CheckResult: [
    { name: "signer", type: "address" },
    { name: "account", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "sessionEpoch", type: "uint64" },
    { name: "sessionCreatedAt", type: "uint64" },
    { name: "owner", type: "address" },
    { name: "bound", type: "bool" },
    { name: "installed", type: "bool" },
    { name: "status", type: "uint8" },
    { name: "accountKind", type: "uint8" },
    { name: "signerIsAccountOwner", type: "bool" },
    { name: "otherAccountModules", type: "bool" },
    { name: "signerHasCode", type: "bool" },
    { name: "paidAt", type: "uint64" },
    { name: "policyHash", type: "bytes32" },
    { name: "caps", type: "TokenView[]" },
    { name: "targetsHash", type: "bytes32" },
    { name: "policyValidUntil", type: "uint64" },
    { name: "increaseDelay", type: "uint32" },
    { name: "pendingHash", type: "bytes32" },
    { name: "pendingReadyAt", type: "uint64" },
    { name: "validFor", type: "uint64" },
    { name: "verified", type: "bool" },
    { name: "probedAt", type: "uint64" },
    { name: "endpointsLive", type: "bool" },
    { name: "registrationValid", type: "bool" },
    { name: "domainVerified", type: "bool" },
    { name: "issuedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "blockNumber", type: "uint64" },
  ],
} as const;

/** Version 2: the v1 fields, then the agent position reported by `OrryStaking.agentStake(agentId)`. */
export const checkResultTypesV2 = {
  TokenView: checkResultTypes.TokenView,
  CheckResult: [
    ...checkResultTypes.CheckResult,
    { name: "stakeActive", type: "uint128" },
    { name: "stakeLeaving", type: "uint128" },
    { name: "stakeLeavingAt", type: "uint64" },
    { name: "stakeLockedUntil", type: "uint64" },
    { name: "stakedBy", type: "address" },
  ],
} as const;

export interface TokenView {
  token: Address;
  perTx: bigint;
  perDay: bigint;
  floatMax: bigint;
  spentToday: bigint;
}

export interface CheckResult {
  signer: Address;
  account: Address;
  agentId: bigint;
  sessionEpoch: bigint;
  sessionCreatedAt: bigint;
  owner: Address;
  bound: boolean;
  installed: boolean;
  status: number;
  accountKind: number;
  signerIsAccountOwner: boolean;
  otherAccountModules: boolean;
  signerHasCode: boolean;
  paidAt: bigint;
  policyHash: Hex;
  caps: TokenView[];
  targetsHash: Hex;
  policyValidUntil: bigint;
  increaseDelay: number;
  pendingHash: Hex;
  pendingReadyAt: bigint;
  validFor: bigint;
  verified: boolean;
  probedAt: bigint;
  endpointsLive: boolean;
  registrationValid: boolean;
  domainVerified: boolean;
  issuedAt: bigint;
  validUntil: bigint;
  blockNumber: bigint;
}

export interface CheckResultV2 extends CheckResult {
  stakeActive: bigint;
  stakeLeaving: bigint;
  stakeLeavingAt: bigint;
  stakeLockedUntil: bigint;
  stakedBy: Address;
}

/** Typed-data types for a check of the given version. */
export const checkTypesFor = (version: CheckVersion) => (version === "2" ? checkResultTypesV2 : checkResultTypes);

/**
 * EIP-712 quotes accepted by `OrreryTreasury` (frozen in `IOrreryTreasury`): domain {name "Orrery Treasury",
 * version "1", chainId, verifyingContract: treasury}. The buyer or payer is the address that sends the transaction.
 */
export const treasuryDomain = (chainId: number, treasury: Address) =>
  ({ name: "Orrery Treasury", version: "1", chainId, verifyingContract: treasury }) as const;

export const creditsQuoteTypes = {
  CreditsQuote: [
    { name: "buyer", type: "address" },
    { name: "packs", type: "uint32" },
    { name: "orryAmount", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const verificationQuoteTypes = {
  VerificationQuote: [
    { name: "payer", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "orryAmount", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export interface CreditsQuote {
  buyer: Address;
  packs: number;
  orryAmount: bigint;
  quoteId: Hex;
  expiry: bigint;
}

export interface VerificationQuote {
  payer: Address;
  agentId: bigint;
  orryAmount: bigint;
  quoteId: Hex;
  expiry: bigint;
}

/** Lens status values (OrreryLens.EffectiveStatus). */
export const SessionStatus = { None: 0, Active: 1, Paused: 2, Revoked: 3, Expired: 4 } as const;
/** Lens account kinds (OrreryLens.AccountKind). */
export const AccountKind = { Unknown: 0, Safe7579: 1 } as const;

/** Signer consent for `openSession` (08 §5.2). */
export const consentDomain = (chainId: number, module: Address) =>
  ({ name: "Orrery Policy Module", version: "1", chainId, verifyingContract: module }) as const;
export const consentTypes = {
  SessionConsent: [
    { name: "account", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
  ],
} as const;

/** EIP-3009 transfer authorization, as used by the x402 `exact` scheme. */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
