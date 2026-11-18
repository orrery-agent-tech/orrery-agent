// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6).
import { FIELD_SIZE, hash2, hash3 } from "./hash";

export interface Note {
  /** Asset address as an integer; 0 is native ETH. */
  asset: bigint;
  amount: bigint;
  blinding: bigint;
  ownerHash: bigint;
}

export interface OwnedNote extends Note {
  commitment: bigint;
  leafIndex: number;
}

export const secretCommit = (n: Pick<Note, "ownerHash" | "blinding">) => hash2(n.ownerHash, n.blinding);

export const commitmentOf = (n: Note) => hash3(n.asset, n.amount, secretCommit(n));

export const nullifierOf = (nk: bigint, commitment: bigint, leafIndex: number | bigint) =>
  hash3(nk, commitment, BigInt(leafIndex));

/** Uniform random field element. */
export function randomField(): bigint {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v % FIELD_SIZE;
}

/** Random value below 2^128, used for intent nonces. */
export function randomU128(): bigint {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
