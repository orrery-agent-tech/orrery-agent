// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6). Changed: the domain name is "Orrery Shield", as OrreryShield.DOMAIN_SEPARATOR.
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from "viem";

export const KIND = { send: 1, withdraw: 2 } as const;
export type Kind = keyof typeof KIND;

export const ACTION_TYPES = {
  Action: [
    { name: "kind", type: "uint8" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "to", type: "address" },
    { name: "fee", type: "uint256" },
    { name: "protocolFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function actionDomain(chainId: number, pool: Address) {
  return { name: "Orrery Shield", version: "1", chainId, verifyingContract: pool } as const;
}

const DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

/** Same value as OrreryShield.DOMAIN_SEPARATOR. */
export function domainSeparator(chainId: number, pool: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, keccak256(toBytes("Orrery Shield")), keccak256(toBytes("1")), BigInt(chainId), pool],
    ),
  );
}

export function splitDomain(sep: Hex): { hi: bigint; lo: bigint } {
  const v = BigInt(sep);
  return { hi: v >> 128n, lo: v & ((1n << 128n) - 1n) };
}
