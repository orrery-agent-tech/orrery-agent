// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6). Changed: the key-derivation domain, wording and labels are Orrery's.
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, concat, hexToBytes, keccak256, toBytes, type Address, type Hex } from "viem";
import { FIELD_SIZE, hash1, hash2 } from "./hash";

/**
 * Typed data the wallet signs once to create account keys. The keys can find, decrypt and
 * prove ownership of notes, but every spend still needs a fresh wallet signature, checked
 * inside the proof.
 */
export function accountKeyTypedData(chainId: number) {
  return {
    domain: { name: "Orrery Shield", version: "1", chainId },
    types: {
      AccountKeys: [{ name: "purpose", type: "string" }],
    },
    primaryType: "AccountKeys" as const,
    message: {
      purpose: "Create my Orrery Shield keys. This signature cannot move funds.",
    },
  };
}

export interface AccountKeys {
  /** Nullifying key: proves note ownership and derives nullifiers. */
  nk: bigint;
  /** hash1(nk), published in the registry. */
  npk: bigint;
  /** secp256k1 private key for note decryption. */
  viewPriv: Uint8Array;
  /** Compressed viewing public key, published in the registry. */
  viewKey: Hex;
}

function derive(seed: Uint8Array, label: string): bigint {
  return BigInt(keccak256(concat([seed, toBytes(`orrery-shield/${label}`)])));
}

/** Derives account keys from the wallet's signature over {@link accountKeyTypedData}. */
export function deriveAccountKeys(signature: Hex): AccountKeys {
  const seed = hexToBytes(keccak256(signature));
  const nk = derive(seed, "nk") % FIELD_SIZE;
  const n = secp256k1.CURVE.n;
  const view = (derive(seed, "view") % (n - 1n)) + 1n;
  const viewPriv = hexToBytes(`0x${view.toString(16).padStart(64, "0")}`);
  return {
    nk,
    npk: hash1(nk),
    viewPriv,
    viewKey: bytesToHex(secp256k1.getPublicKey(viewPriv, true)),
  };
}

/** Owner hash a note commits to: hash2(address, npk). */
export function ownerHash(owner: Address, npk: bigint): bigint {
  return hash2(BigInt(owner), npk);
}
