import type { Address, Hex } from "viem";

/** x402 v2 over HTTP (coinbase/x402 specs/transports-v2/http.md). */
export const X402_VERSION = 2 as const;
export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";

export interface PaymentRequirements {
  scheme: "exact";
  network: string; // CAIP-2, e.g. eip155:4663
  amount: string; // atomic units
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod?: "eip3009" };
}

export interface Resource {
  url: string;
  description: string;
  mimeType: string;
}

export interface PaymentRequired {
  x402Version: 2;
  error: string;
  resource: Resource;
  accepts: PaymentRequirements[];
}

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: Resource;
  accepted: PaymentRequirements;
  payload: { signature: Hex; authorization: Eip3009Authorization };
}

export interface SettlementResponse {
  success: boolean;
  transaction: Hex | "";
  network: string;
  payer: Address | "";
  errorReason?: string;
}

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
export const decodeHeader = <T>(value: string): T => JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;

// ------------------------------------------------------------------ public facilitator (wave 3, R-57, utility 11)

/** Requirements a merchant puts in its 402: `payTo` is its Orrery splitter. USDG uses EIP-3009; ORRY uses Permit2
 * through `X402Permit2Proxy` (`extra.proxy`), since the Pons token has no EIP-3009. */
export interface PublicPaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; assetTransferMethod?: "eip3009" | "permit2"; proxy?: Address };
}

/** The Permit2 authorization a payer signs for an ORRY x402 payment: spender is the proxy, the witness names payTo. */
export interface Permit2Authorization {
  from: Address;
  permitted: { token: Address; amount: string };
  spender: Address;
  nonce: string;
  deadline: string;
  witness: { to: Address };
}

export interface PublicPaymentPayload {
  x402Version: 2;
  resource?: Resource;
  accepted: PublicPaymentRequirements;
  payload: { signature: Hex; authorization?: Eip3009Authorization; permit2Authorization?: Permit2Authorization };
}

/** POST /v1/x402/verify and /v1/x402/settle body (x402 facilitator HTTP API). */
export interface FacilitatorRequest {
  x402Version?: 2;
  paymentPayload: PublicPaymentPayload;
  paymentRequirements: PublicPaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

/** EIP-712 types of a Permit2 witness transfer for x402 (`X402Permit2Proxy.WITNESS_TYPE_STRING`). */
export const permit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "X402Payment" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  X402Payment: [{ name: "to", type: "address" }],
} as const;

/** Permit2's EIP-712 domain: name "Permit2", no version. */
export const permit2Domain = (chainId: number, permit2: Address) => ({ name: "Permit2", chainId, verifyingContract: permit2 }) as const;
