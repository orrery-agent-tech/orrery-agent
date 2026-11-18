// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6).
import { permute } from "@zkpassport/poseidon2";

export const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const TWO_POW_64 = 1n << 64n;

/** "intent" as a field element; separates intent nullifiers from note nullifiers. */
export const INTENT_TAG = 0x696e74656e74n;

// One Poseidon2 permutation with the input count in the capacity word. Same construction
// as circuits/transact/src/hash.nr and LibPoseidon2Yul.hash_1/2/3.
function compress(inputs: bigint[]): bigint {
  const state = [0n, 0n, 0n, BigInt(inputs.length) * TWO_POW_64];
  inputs.forEach((v, i) => {
    state[i] = mod(v);
  });
  return permute(state)[0]!;
}

export function mod(v: bigint): bigint {
  const r = v % FIELD_SIZE;
  return r < 0n ? r + FIELD_SIZE : r;
}

export const hash1 = (a: bigint) => compress([a]);
export const hash2 = (a: bigint, b: bigint) => compress([a, b]);
export const hash3 = (a: bigint, b: bigint, c: bigint) => compress([a, b, c]);
