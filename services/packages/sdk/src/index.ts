import {
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  iMerchantSplitterAbi,
  iMerchantSplitterFactoryAbi,
  permit2Domain,
  permit2WitnessTypes,
  type FacilitatorRequest,
  type Permit2Authorization,
  type PublicPaymentPayload,
  type PublicPaymentRequirements,
  type VerifyResponse,
} from "@orrery/shared";
import {
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  X402_VERSION,
  CHECK_VERSIONS,
  checkDomain,
  checkTypesFor,
  consentDomain,
  creditsQuoteTypes,
  iClaimAllAbi,
  iEarnVaultAbi,
  iEarnVaultFactoryAbi,
  iOrryStakingAbi,
  iOrryTokenAbi,
  iOrreryTreasuryAbi,
  iSealedBatchMarketAbi,
  ORDER_MODES,
  treasuryDomain,
  verificationQuoteTypes,
  consentTypes,
  decodeHeader,
  devUSDGAbi,
  encodeHeader,
  orreryAttestorAbi,
  orreryLensAbi,
  orreryPolicyModuleAbi,
  transferWithAuthorizationTypes,
  type CheckResult,
  type CheckResultV2,
  type CheckVersion,
  type OrryAccountResponse,
  type OrryBurnsResponse,
  type OrryChecksQuoteResponse,
  type OrryCreditsQuoteResponse,
  type OrryEarnResponse,
  type OrryLeaderboardResponse,
  type OrryStakeResponse,
  type OrryVerificationQuoteResponse,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type BatchView,
  type BatchesResponse,
  type FeeTiersResponse,
  type MarketResponse,
  type MarketsResponse,
  type OrderMode,
  type RelayRevealRequest,
  type RelayRevealResponse,
  type WalletOrdersResponse,
} from "@orrery/shared";

export * from "@orrery/shared";
export * from "./quick";

// ------------------------------------------------------------------ policy

export interface TokenCap {
  token: Address;
  perTx: bigint;
  perDay: bigint;
  floatMax: bigint;
}
export interface Target {
  target: Address;
  selector: Hex;
}
export interface Policy {
  caps: TokenCap[];
  targets: Target[];
  validUntil: bigint;
  increaseDelay: number;
}

const policyAbiType = [
  {
    type: "tuple",
    components: [
      { name: "caps", type: "tuple[]", components: [
        { name: "token", type: "address" }, { name: "perTx", type: "uint128" }, { name: "perDay", type: "uint128" }, { name: "floatMax", type: "uint128" },
      ] },
      { name: "targets", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "selector", type: "bytes4" }] },
      { name: "validUntil", type: "uint64" },
      { name: "increaseDelay", type: "uint32" },
    ],
  },
] as const;

/** keccak256(abi.encode(policy)), the module's policyHash. */
export const policyHash = (p: Policy): Hex => keccak256(encodeAbiParameters(policyAbiType, [p]));

// ------------------------------------------------------------------ operator

/** The signer's consent to a session (08 §5.2). The SDK signs it with the fresh signer key it generated. */
export async function signSessionConsent(
  signer: Account,
  args: { chainId: number; module: Address; account: Address; agentId: bigint; policy: Policy },
): Promise<Hex> {
  if (!signer.signTypedData) throw new Error("Signing needs an account that supports signTypedData.");
  return signer.signTypedData({
    domain: consentDomain(args.chainId, args.module),
    types: consentTypes,
    primaryType: "SessionConsent",
    message: { account: args.account, agentId: args.agentId, policyHash: policyHash(args.policy) },
  });
}

/** Calldata the operator's account sends to the module (for example through Safe `execTransaction`). */
export const operatorCalls = {
  openSession: (agentId: bigint, signer: Address, policy: Policy, consent: Hex) =>
    encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "openSession", args: [agentId, signer, policy, consent] }),
  decreasePolicy: (agentId: bigint, policy: Policy) =>
    encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "decreasePolicy", args: [agentId, policy] }),
  proposeIncrease: (agentId: bigint, policy: Policy) =>
    encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "proposeIncrease", args: [agentId, policy] }),
  applyIncrease: (agentId: bigint) => encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "applyIncrease", args: [agentId] }),
  cancelIncrease: (agentId: bigint) => encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "cancelIncrease", args: [agentId] }),
  pause: (agentId: bigint) => encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "pause", args: [agentId] }),
  unpause: (agentId: bigint) => encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "unpause", args: [agentId] }),
  revoke: (agentId: bigint) => encodeFunctionData({ abi: orreryPolicyModuleAbi, functionName: "revoke", args: [agentId] }),
  payVerification: (agentId: bigint, expectedOwner: Address, maxFee: bigint) =>
    encodeFunctionData({ abi: orreryAttestorAbi, functionName: "payVerification", args: [agentId, expectedOwner, maxFee] }),
};

/** ERC-8004 `setAgentWallet` digest the new wallet must sign (EIP-712 or ERC-1271). */
export function agentWalletDigest(args: { chainId: number; registry: Address; agentId: bigint; newWallet: Address; owner: Address; deadline: bigint }): Hex {
  return hashTypedData({
    domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: args.chainId, verifyingContract: args.registry },
    types: { AgentWalletSet: [
      { name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" },
    ] },
    primaryType: "AgentWalletSet",
    message: { agentId: args.agentId, newWallet: args.newWallet, owner: args.owner, deadline: args.deadline },
  });
}

// ------------------------------------------------------------------ agent

export class AgentClient {
  constructor(
    readonly wallet: WalletClient & { account: Account },
    readonly publicClient: PublicClient,
    readonly module: Address,
  ) {}

  get signer(): Address {
    return this.wallet.account.address;
  }

  async session(): Promise<{ account: Address; agentId: bigint }> {
    const [account, agentId] = await this.publicClient.readContract({ address: this.module, abi: orreryPolicyModuleAbi, functionName: "signerOf", args: [this.signer] });
    if (account === "0x0000000000000000000000000000000000000000") throw new Error("No Orrery session is registered for this signer address.");
    return { account, agentId };
  }

  /** Remaining today and float headroom per capped token. */
  async getAllowance(): Promise<{ token: Address; remainingToday: bigint; floatHeadroom: bigint; perTx: bigint }[]> {
    const { account, agentId } = await this.session();
    const policy = await this.publicClient.readContract({ address: this.module, abi: orreryPolicyModuleAbi, functionName: "getPolicy", args: [account, agentId] });
    const out = [];
    for (const c of policy.caps) {
      const spent = await this.publicClient.readContract({ address: this.module, abi: orreryPolicyModuleAbi, functionName: "spentToday", args: [account, agentId, c.token] });
      const bal = c.token === "0x0000000000000000000000000000000000000000"
        ? await this.publicClient.getBalance({ address: this.signer })
        : await this.publicClient.readContract({ address: c.token, abi: devUSDGAbi, functionName: "balanceOf", args: [this.signer] });
      out.push({ token: c.token, perTx: c.perTx, remainingToday: c.perDay > spent ? c.perDay - spent : 0n, floatHeadroom: c.floatMax > bal ? c.floatMax - bal : 0n });
    }
    return out;
  }

  /** Tops up the float so the signer holds at least `needed` of `token`, within the caps. */
  async ensureFloat(token: Address, needed: bigint): Promise<Hex | null> {
    const bal = await this.publicClient.readContract({ address: token, abi: devUSDGAbi, functionName: "balanceOf", args: [this.signer] });
    if (bal >= needed) return null;
    const allowance = (await this.getAllowance()).find((a) => a.token.toLowerCase() === token.toLowerCase());
    if (!allowance) throw new Error("The session policy sets no cap for this token.");
    let amount = needed - bal;
    if (amount > allowance.perTx) amount = allowance.perTx;
    if (amount > allowance.floatHeadroom) amount = allowance.floatHeadroom;
    if (amount > allowance.remainingToday) amount = allowance.remainingToday;
    if (amount + bal < needed) throw new Error("This payment would exceed today's session caps.");
    const hash = await this.wallet.writeContract({ address: this.module, abi: orreryPolicyModuleAbi, functionName: "topUp", args: [token, amount], chain: null, account: this.wallet.account });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Tops up native gas when NATIVE is capped. The first ETH must come from the operator. */
  async ensureGas(min: bigint): Promise<Hex | null> {
    const bal = await this.publicClient.getBalance({ address: this.signer });
    if (bal >= min) return null;
    if (bal === 0n) throw new Error("The signer holds 0 ETH. Send its first gas from the operator wallet.");
    const allowance = (await this.getAllowance()).find((a) => a.token === "0x0000000000000000000000000000000000000000");
    if (!allowance) throw new Error("The session policy sets no cap for native gas.");
    let amount = min - bal;
    for (const lim of [allowance.perTx, allowance.floatHeadroom, allowance.remainingToday]) if (amount > lim) amount = lim;
    const hash = await this.wallet.writeContract({ address: this.module, abi: orreryPolicyModuleAbi, functionName: "topUp", args: ["0x0000000000000000000000000000000000000000", amount], chain: null, account: this.wallet.account });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Signs an EIP-3009 authorization for an x402 `exact` requirement. */
  async signPayment(req: PaymentRequirements, chainId: number, resource?: PaymentPayload["resource"]): Promise<PaymentPayload> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const authorization = {
      from: this.signer,
      to: getAddress(req.payTo),
      value: BigInt(req.amount),
      validAfter: now - 60n,
      validBefore: now + BigInt(req.maxTimeoutSeconds),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signature = await this.wallet.signTypedData({
      account: this.wallet.account,
      domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: getAddress(req.asset) },
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: authorization,
    });
    return {
      x402Version: X402_VERSION,
      resource,
      accepted: req,
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    };
  }

  /** fetch that pays x402 `exact` requirements from the float, topping it up within the caps first. */
  async x402Fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const first = await fetch(url, init);
    if (first.status !== 402) return first;
    const header = first.headers.get(HEADER_REQUIRED);
    if (!header) return first;
    const required = decodeHeader<PaymentRequired>(header);
    const chainId = await this.publicClient.getChainId();
    const req = required.accepts.find((a) => a.scheme === "exact" && a.network === `eip155:${chainId}`);
    if (!req) return first;
    await this.ensureFloat(getAddress(req.asset), BigInt(req.amount));
    const payload = await this.signPayment(req, chainId, required.resource);
    const headers = new Headers(init.headers);
    headers.set(HEADER_SIGNATURE, encodeHeader(payload));
    return fetch(url, { ...init, headers });
  }
}

// ------------------------------------------------------------------ counterparty

export interface CheckResponse {
  result: Record<string, unknown>;
  signature: Hex;
  checkSigner: Address;
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  extras: { targets: Target[]; coverage: string; probe: { probedAt: number; fresh: boolean } | null };
}

const BIG = new Set([
  "agentId", "sessionEpoch", "sessionCreatedAt", "paidAt", "policyValidUntil", "pendingReadyAt", "validFor", "probedAt", "issuedAt", "validUntil", "blockNumber",
  "stakeActive", "stakeLeaving", "stakeLeavingAt", "stakeLockedUntil",
]);

/** Parses the JSON check result (decimal strings) back into typed values. Version 2 adds the stake fields. */
export function parseCheck(raw: Record<string, unknown>): CheckResult & Partial<Pick<CheckResultV2, "stakeActive" | "stakeLeaving" | "stakeLeavingAt" | "stakeLockedUntil" | "stakedBy">> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "caps") {
      out.caps = (v as Record<string, string>[]).map((c) => ({ token: c.token, perTx: BigInt(c.perTx!), perDay: BigInt(c.perDay!), floatMax: BigInt(c.floatMax!), spentToday: BigInt(c.spentToday!) }));
    } else out[k] = BIG.has(k) ? BigInt(v as string) : v;
  }
  return out as unknown as CheckResult;
}

/**
 * Verifies a signed check offline plus one on-chain read: EIP-712 domain bound to this chain and attestor, the signer
 * is an active check signer, and the result is still within its validity window. Accepts version 1 and version 2
 * (adds `stakeActive`, `stakeLeaving`, `stakeLeavingAt`, `stakeLockedUntil`, `stakedBy`). Only the version is taken from the response; the
 * name, chain and attestor are always the caller's, so a result cannot be passed off under another domain or version.
 */
export async function verifyCheck(
  publicClient: PublicClient,
  attestor: Address,
  res: CheckResponse,
  opts: { now?: bigint; payer?: Address } = {},
): Promise<{ ok: boolean; reason?: string; version?: CheckVersion; result: CheckResult & Partial<CheckResultV2> }> {
  const result = parseCheck(res.result);
  const version = res.domain?.version as CheckVersion;
  if (!CHECK_VERSIONS.includes(version)) return { ok: false, reason: "unsupported check version", result };
  const v2Fields = ["stakeActive", "stakeLeaving", "stakeLeavingAt", "stakeLockedUntil", "stakedBy"] as const;
  const hasV2 = v2Fields.map((f) => f in res.result);
  if (version === "2" ? !hasV2.every(Boolean) : hasV2.some(Boolean)) return { ok: false, reason: "result fields disagree with the check version", result };
  const chainId = await publicClient.getChainId();
  const domain = checkDomain(chainId, attestor, version);
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({ domain, types: checkTypesFor(version), primaryType: "CheckResult", message: result as never, signature: res.signature });
  } catch {
    return { ok: false, reason: "invalid signature", version, result };
  }
  const active = await publicClient.readContract({ address: attestor, abi: orreryAttestorAbi, functionName: "isCheckSigner", args: [recovered] });
  if (!active) return { ok: false, reason: "signer is not an active check signer", version, result };
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  if (result.validUntil < now) return { ok: false, reason: "expired check", version, result };
  if (opts.payer && result.signer.toLowerCase() !== opts.payer.toLowerCase()) return { ok: false, reason: "check names a different address", version, result };
  return { ok: true, version, result };
}

export class OrreryApi {
  constructor(readonly baseUrl: string, readonly apiKey?: string) {}

  async checkPayer(address: Address): Promise<CheckResponse> {
    const r = await fetch(`${this.baseUrl}/v1/check/by-signer/${address}`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
    return (await r.json()) as CheckResponse;
  }

  async checkAgent(agentId: bigint, account: Address): Promise<CheckResponse> {
    const r = await fetch(`${this.baseUrl}/v1/check/by-agent/${agentId}?account=${account}`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
    return (await r.json()) as CheckResponse;
  }

  /**
   * Buys a credit pack (or, with `product: "plan"`, the platform plan) over x402 from an EOA holding USDG. Returns the
   * API key on the first purchase. Every address also gets a monthly allowance of free checks (see `/v1/pricing`).
   */
  static async buyCredits(
    baseUrl: string,
    payer: AgentClient | (WalletClient & { account: Account }),
    publicClient: PublicClient,
    product: "pack" | "plan" = "pack",
  ): Promise<{ apiKey?: string; credits: string; planUntil?: string | null }> {
    const url = `${baseUrl}/v1/credits${product === "plan" ? "?product=plan" : ""}`;
    const first = await fetch(url, { method: "POST" });
    if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}`);
    const required = decodeHeader<PaymentRequired>(first.headers.get(HEADER_REQUIRED)!);
    const chainId = await publicClient.getChainId();
    const req = required.accepts.find((a) => a.network === `eip155:${chainId}`)!;
    const client = payer instanceof AgentClient ? payer : new AgentClient(payer, publicClient, "0x0000000000000000000000000000000000000000");
    const payload = await client.signPayment(req, chainId, required.resource);
    for (let i = 0; i < 10; i++) {
      const r = await fetch(url, { method: "POST", headers: { [HEADER_SIGNATURE]: encodeHeader(payload) } });
      if (r.status === 202) {
        await new Promise((res) => setTimeout(res, 2_000));
        continue;
      }
      const body = (await r.json()) as { apiKey?: string; credits?: string; planUntil?: string | null; error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      return { apiKey: body.apiKey, credits: body.credits ?? "0", planUntil: body.planUntil };
    }
    throw new Error("Payment awaiting confirmation. Retry in a few seconds.");
  }
}

/** Reads the public, unsigned on-chain view directly (no API). */
export async function readOnChain(publicClient: PublicClient, lens: Address, signer: Address) {
  return publicClient.readContract({ address: lens, abi: orreryLensAbi, functionName: "checkBySigner", args: [signer] });
}

// ------------------------------------------------------------------ ORRY: stake, Earn, claims, checkout

/** Calldata for the ORRY contracts (frozen ABIs in `@orrery/shared` orry-abi.ts). Amounts in base units. */
export const orryCalls = {
  /** ORRY `approve(spender, amount)`: staking, the Earn vault, or the treasury (checkout burns with `burnFrom`). */
  approve: (spender: Address, amount: bigint) => encodeFunctionData({ abi: iOrryTokenAbi, functionName: "approve", args: [spender, amount] }),
  // plain stake
  stake: (amount: bigint) => encodeFunctionData({ abi: iOrryStakingAbi, functionName: "stake", args: [amount] }),
  requestUnstake: (amount: bigint) => encodeFunctionData({ abi: iOrryStakingAbi, functionName: "requestUnstake", args: [amount] }),
  withdrawStake: () => encodeFunctionData({ abi: iOrryStakingAbi, functionName: "withdraw" }),
  // stake behind an agent (caller is the agent's owner or agent wallet)
  stakeForAgent: (agentId: bigint, amount: bigint) => encodeFunctionData({ abi: iOrryStakingAbi, functionName: "stakeForAgent", args: [agentId, amount] }),
  requestAgentUnstake: (agentId: bigint, owner: Address, amount: bigint) =>
    encodeFunctionData({ abi: iOrryStakingAbi, functionName: "requestAgentUnstake", args: [agentId, owner, amount] }),
  withdrawAgent: (agentId: bigint, owner: Address) => encodeFunctionData({ abi: iOrryStakingAbi, functionName: "withdrawAgent", args: [agentId, owner] }),
  /** Staker only: no unstake request before `lockedUntil` (unix seconds, later than now, at most MAX_AGENT_LOCK ahead). */
  extendAgentLock: (agentId: bigint, lockedUntil: bigint) =>
    encodeFunctionData({ abi: iOrryStakingAbi, functionName: "extendAgentLock", args: [agentId, lockedUntil] }),
  claimStakeRewards: () => encodeFunctionData({ abi: iOrryStakingAbi, functionName: "claimRewards" }),
  // Earn, one vault per hub (`to` = the pair's vault from /v1/orry/earn). On the native ETH vault send `value` =
  // quoteMax with a deposit and amountIn with a quote zap; an ERC-20 vault takes value 0 and an approval of the quote.
  /** `bounds`: the hub's sqrtPriceX96 must be inside them when the deposit enters (`depositPriceBounds`, review M-3). */
  earnDeposit: (quoteMax: bigint, orryMax: bigint, minShares: bigint, bounds: { min: bigint; max: bigint }, deadline: bigint) =>
    encodeFunctionData({ abi: iEarnVaultAbi, functionName: "deposit", args: [quoteMax, orryMax, minShares, bounds.min, bounds.max, deadline] }),
  earnZap: (fromQuote: boolean, amountIn: bigint, minSwapOut: bigint, minShares: bigint, bounds: { min: bigint; max: bigint }, deadline: bigint) =>
    encodeFunctionData({ abi: iEarnVaultAbi, functionName: "zapDeposit", args: [fromQuote, amountIn, minSwapOut, minShares, bounds.min, bounds.max, deadline] }),
  /** `OrryStaking.claimRewardsTo(to)`: the caller's stake rewards, paid to `to`. */
  claimStakeRewardsTo: (to: Address) => encodeFunctionData({ abi: iOrryStakingAbi, functionName: "claimRewardsTo", args: [to] }),
  earnWithdraw: (shares: bigint, minQuoteOut: bigint, minOrryOut: bigint, deadline: bigint) =>
    encodeFunctionData({ abi: iEarnVaultAbi, functionName: "withdraw", args: [shares, minQuoteOut, minOrryOut, deadline] }),
  claimEarnFees: () => encodeFunctionData({ abi: iEarnVaultAbi, functionName: "claimFees" }),
  /** `IEarnVaultFactory.createVault(quote)`: anyone, once the hook lists the pair. */
  createEarnVault: (quote: Address) => encodeFunctionData({ abi: iEarnVaultFactoryAbi, functionName: "createVault", args: [quote] }),
  /** `ClaimAll.claimAll()`: Earn fees of every vault and stake rewards of the sender in one call (returns `Paid[]`). */
  claimAll: () => encodeFunctionData({ abi: iClaimAllAbi, functionName: "claimAll" }),
  // checkout (the buyer or payer of the quote sends these; approve the treasury for `orryAmount` first)
  /** A pack quote or a pay-as-you-go checks quote: both are `CreditsQuote`s (`quote.packs` is the checks for the latter). */
  burnForCredits: (q: OrryCreditsQuoteResponse | OrryChecksQuoteResponse) =>
    encodeFunctionData({
      abi: iOrreryTreasuryAbi,
      functionName: "burnForCredits",
      args: [q.quote.packs, BigInt(q.quote.orryAmount), q.quote.quoteId, BigInt(q.quote.expiry), q.signature],
    }),
  verifyWithOrry: (q: OrryVerificationQuoteResponse, expectedOwner: Address) =>
    encodeFunctionData({
      abi: iOrreryTreasuryAbi,
      functionName: "verifyWithOrry",
      args: [BigInt(q.quote.agentId), expectedOwner, BigInt(q.quote.orryAmount), q.quote.quoteId, BigInt(q.quote.expiry), q.signature],
    }),
};

/**
 * Checks an ORRY quote before sending it: the signature recovers to the stated signer under the treasury's own EIP-712
 * domain on this chain, the treasury lists that signer, the quote is unused and unexpired, and it is for `sender`.
 */
export async function verifyQuote(
  publicClient: PublicClient,
  treasury: Address,
  q: OrryCreditsQuoteResponse | OrryChecksQuoteResponse | OrryVerificationQuoteResponse,
  opts: { sender?: Address; now?: bigint } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const chainId = await publicClient.getChainId();
  const domain = treasuryDomain(chainId, treasury);
  let recovered: Address;
  try {
    recovered =
      q.kind !== "verification"
        ? await recoverTypedDataAddress({
            domain,
            types: creditsQuoteTypes,
            primaryType: "CreditsQuote",
            message: { buyer: q.quote.buyer, packs: q.quote.packs, orryAmount: BigInt(q.quote.orryAmount), quoteId: q.quote.quoteId, expiry: BigInt(q.quote.expiry) },
            signature: q.signature,
          })
        : await recoverTypedDataAddress({
            domain,
            types: verificationQuoteTypes,
            primaryType: "VerificationQuote",
            message: { payer: q.quote.payer, agentId: BigInt(q.quote.agentId), orryAmount: BigInt(q.quote.orryAmount), quoteId: q.quote.quoteId, expiry: BigInt(q.quote.expiry) },
            signature: q.signature,
          });
  } catch {
    return { ok: false, reason: "invalid signature" };
  }
  if (recovered.toLowerCase() !== q.signer.toLowerCase()) return { ok: false, reason: "signer key mismatch" };
  const [listed, used] = await Promise.all([
    publicClient.readContract({ address: treasury, abi: iOrreryTreasuryAbi, functionName: "isQuoteSigner", args: [recovered] }),
    publicClient.readContract({ address: treasury, abi: iOrreryTreasuryAbi, functionName: "quoteUsed", args: [q.quote.quoteId] }),
  ]);
  if (!listed) return { ok: false, reason: "signer is not a listed quote signer" };
  if (used) return { ok: false, reason: "quote already redeemed" };
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(q.quote.expiry) < now) return { ok: false, reason: "expired quote" };
  const forWhom = q.kind === "verification" ? q.quote.payer : q.quote.buyer;
  if (opts.sender && forWhom.toLowerCase() !== opts.sender.toLowerCase()) return { ok: false, reason: "quote names a different sender" };
  return { ok: true };
}

/** Public ORRY reads and quotes of the Orrery API (`/v1/orry/`). A held feature answers 404 ("not open"). */
export class OrryApi {
  constructor(readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`);
    if (r.status === 404) throw new Error("This ORRY feature is coming soon.");
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  }

  private async post<T>(path: string, data: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    if (r.status === 404) throw new Error("This ORRY feature is coming soon.");
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  }

  earn = () => this.get<OrryEarnResponse>("/v1/orry/earn");
  stake = () => this.get<OrryStakeResponse>("/v1/orry/stake");
  account = (address: Address) => this.get<OrryAccountResponse>(`/v1/orry/accounts/${address}`);
  leaderboard = (kind: "stakers" | "earners", limit = 50) => this.get<OrryLeaderboardResponse>(`/v1/orry/leaderboard?kind=${kind}&limit=${limit}`);
  burns = (limit = 50) => this.get<OrryBurnsResponse>(`/v1/orry/burns?limit=${limit}`);
  quoteCredits = (buyer: Address, packs: number) => this.post<OrryCreditsQuoteResponse>("/v1/orry/quotes/credits", { buyer, packs });
  /** Pay as you go: a quote for `checks` checks paid in ORRY (send it with `orryCalls.burnForCredits`). */
  quoteChecks = (buyer: Address, checks: number) => this.post<OrryChecksQuoteResponse>("/v1/orry/quotes/checks", { buyer, checks });
  quoteVerification = (payer: Address, agentId: bigint) =>
    this.post<OrryVerificationQuoteResponse>("/v1/orry/quotes/verification", { payer, agentId: agentId.toString() });
}

// ------------------------------------------------------------------ wave R1 markets (docs/ORRY-R1-SPEC.md)

/** An order as the trader enters it; `mode` "limit" is the Dark Pool, "swap" the Private Swap. */
export interface MarketOrder {
  sellAsset: boolean;
  amountIn: bigint;
  limitPrice: bigint;
  mode: OrderMode;
  payFeeInOrry: boolean;
}

const abiOrder = (o: MarketOrder) => ({ ...o, mode: ORDER_MODES.indexOf(o.mode) });
const commitmentInputs = getAbiItem({ abi: iSealedBatchMarketAbi, name: "commitmentFor" }).inputs;

/** keccak256(abi.encode(batch, account, order, salt)), as `ISealedBatchMarket.commitmentFor` computes it. */
export function orderCommitment(batch: bigint, account: Address, order: MarketOrder, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(commitmentInputs, [batch, account, abiOrder(order) as never, salt]));
}

/** 32 random bytes for an order's salt. Keep it with the order until the reveal: without it the order cannot be revealed. */
export const newSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** Calldata for a market (`to` = the market) and the approvals clearing pulls from the wallet. */
export const marketCalls = {
  /** ERC-20 `approve(market, amount)` on the input token (USDG to buy, the stock token to sell, ORRY for ORRY fees). */
  approve: (spender: Address, amount: bigint) => encodeFunctionData({ abi: iOrryTokenAbi, functionName: "approve", args: [spender, amount] }),
  commit: (commitment: Hex) => encodeFunctionData({ abi: iSealedBatchMarketAbi, functionName: "commit", args: [commitment] }),
  reveal: (order: MarketOrder, salt: Hex) =>
    encodeFunctionData({ abi: iSealedBatchMarketAbi, functionName: "reveal", args: [abiOrder(order) as never, salt] }),
  /** Reveals `account`'s committed order for it; anyone holding the salt can send this (the opt-in relay does). */
  revealFor: (account: Address, order: MarketOrder, salt: Hex) =>
    encodeFunctionData({ abi: iSealedBatchMarketAbi, functionName: "revealFor", args: [account, abiOrder(order) as never, salt] }),
  clear: (batch: bigint, roundHint: bigint) => encodeFunctionData({ abi: iSealedBatchMarketAbi, functionName: "clear", args: [batch, roundHint] }),
};

/** Public market reads of the Orrery API (`/v1/markets/`). Held features answer 404 ("not open"). */
export class MarketsApi {
  constructor(readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`);
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (r.status === 404 && !body.error) throw new Error("Markets are coming soon.");
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  }

  private static q(opts: Record<string, string | number | bigint | undefined>): string {
    const s = Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    return s ? `?${s}` : "";
  }

  markets = () => this.get<MarketsResponse>("/v1/markets");
  /** The fee tier tables (thresholds in USD); with `account`, that address's stake in USD and discount now. */
  feeTiers = (account?: Address) => this.get<FeeTiersResponse>(`/v1/markets/fee-tiers${MarketsApi.q({ account })}`);
  market = (market: Address) => this.get<MarketResponse>(`/v1/markets/${market}`);
  batches = (market: Address, opts: { limit?: number; before?: bigint } = {}) =>
    this.get<BatchesResponse>(`/v1/markets/${market}/batches${MarketsApi.q(opts)}`);
  batch = (market: Address, batch: bigint) => this.get<BatchView>(`/v1/markets/${market}/batches/${batch}`);
  walletOrders = (address: Address, opts: { limit?: number; before?: bigint } = {}) =>
    this.get<WalletOrdersResponse>(`/v1/markets/accounts/${address}/orders${MarketsApi.q(opts)}`);

  /** Opt in to the reveal relay for one committed order: Orrery's server then holds the order and salt until it reveals. */
  async relayReveal(market: Address, batch: bigint, account: Address, order: MarketOrder, salt: Hex): Promise<RelayRevealResponse> {
    const body: RelayRevealRequest = {
      market,
      batch: batch.toString(),
      account,
      order: { ...order, amountIn: order.amountIn.toString(), limitPrice: order.limitPrice.toString() },
      salt,
    };
    const r = await fetch(`${this.baseUrl}/v1/markets/relay/reveals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await r.json().catch(() => ({}))) as RelayRevealResponse & { error?: string };
    if (!r.ok) throw new Error(out.error ?? (r.status === 404 ? "The relay is coming soon." : `HTTP ${r.status}`));
    return out;
  }

  relayStatus = (market: Address, batch: bigint, account: Address) =>
    this.get<RelayRevealResponse>(`/v1/markets/relay/reveals/${market}/${batch}/${account}`);
}

// ------------------------------------------------------------------ wave 3: public x402 facilitator

/** Merchant contract calls. `create` makes the merchant's payment address (anyone may send it for the merchant);
 * `forward` sends what the payment address holds of one token to the merchant, minus Orrery's fee. */
export const facilitatorCalls = {
  create: (merchant: Address) => encodeFunctionData({ abi: iMerchantSplitterFactoryAbi, functionName: "create", args: [merchant] }),
  forward: (token: Address) => encodeFunctionData({ abi: iMerchantSplitterAbi, functionName: "forward", args: [token] }),
};

export interface MerchantView {
  merchant: Address;
  /** The merchant's payment address: the x402 `payTo`. Known before it is created. */
  splitter: Address;
  created: boolean;
  feeBps: number;
  discountBps: number;
  stakeUsd: string;
  badge: boolean;
  badgeMinStakeUsd: string;
  profile: { name: string | null; url: string | null; description: string | null } | null;
  lastForwardAt: number | null;
  settled30d: { asset: Address; payments: number; amount: string }[];
}

export interface SupportedKind {
  x402Version: 2;
  scheme: "exact";
  network: string;
  asset: Address;
  extra: { assetTransferMethod: "eip3009" | "permit2"; name?: string; version?: string; proxy?: Address; permit2?: Address };
}

/** Orrery's public x402 facilitator (`/v1/x402/`) and merchant pages (`/v1/merchants/`). */
export class FacilitatorApi {
  constructor(readonly baseUrl: string) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, init);
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (r.status === 404 && !body.error) throw new Error("The facilitator is coming soon.");
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  }
  private post<T>(path: string, body: unknown) {
    return this.call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  supported = () => this.call<{ kinds: SupportedKind[]; feeBps: number }>("/v1/x402/supported");
  verify = (req: FacilitatorRequest) => this.post<VerifyResponse>("/v1/x402/verify", req);
  settle = (req: FacilitatorRequest) => this.post<{ success: boolean; transaction: Hex | ""; network: string; payer: Address | ""; errorReason?: string }>("/v1/x402/settle", req);
  merchant = (address: Address) => this.call<MerchantView>(`/v1/merchants/${address}`);
  directory = () => this.call<{ merchants: { merchant: Address; splitter: Address; name: string; url: string | null; description: string | null; stakeUsd: string }[] }>("/v1/merchants");

  /** Writes the merchant's public profile: signs the one-time message with the merchant's wallet, then saves it. */
  async saveProfile(wallet: WalletClient, merchant: Address, profile: { name: string; url?: string; description?: string }): Promise<void> {
    const n = await this.call<{ nonce: string; message: string }>(`/v1/merchants/profile/nonce?address=${merchant}`);
    const signature = await wallet.signMessage({ account: wallet.account ?? merchant, message: n.message });
    await this.post("/v1/merchants/profile", { merchant, nonce: n.nonce, signature, ...profile });
  }
}

/**
 * Signs an ORRY x402 payment over Permit2 (ORRY has no EIP-3009). The payer approves Permit2 once; each payment is
 * one signature naming the amount, the proxy as spender and the merchant's payment address as witness.
 */
export async function signPermit2Payment(
  wallet: WalletClient,
  args: { chainId: number; requirements: PublicPaymentRequirements; permit2: Address; proxy: Address; nonce?: bigint; deadline?: bigint },
): Promise<PublicPaymentPayload> {
  const from = wallet.account?.address;
  if (!from) throw new Error("Attach an account to the wallet client first.");
  const nonce = args.nonce ?? BigInt(toHex(crypto.getRandomValues(new Uint8Array(31))));
  const deadline = args.deadline ?? BigInt(Math.floor(Date.now() / 1000) + args.requirements.maxTimeoutSeconds);
  const message = {
    permitted: { token: args.requirements.asset, amount: BigInt(args.requirements.amount) },
    spender: args.proxy,
    nonce,
    deadline,
    witness: { to: args.requirements.payTo },
  };
  const signature = await wallet.signTypedData({
    account: wallet.account!,
    domain: permit2Domain(args.chainId, args.permit2),
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message,
  });
  const permit2Authorization: Permit2Authorization = {
    from,
    permitted: { token: args.requirements.asset, amount: args.requirements.amount },
    spender: args.proxy,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    witness: { to: args.requirements.payTo },
  };
  return { x402Version: 2, accepted: args.requirements, payload: { signature, permit2Authorization } };
}
