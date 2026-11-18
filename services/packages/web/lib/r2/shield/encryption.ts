// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6). Changed: the key-derivation info string.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, type Hex } from "viem";

// Note ciphertext: ephemeral compressed key (33) | nonce (24) | sealed payload.
// Payload v1: version (1) | asset (20) | amount (16) | blinding (32) = 69 bytes.
const VERSION = 1;
const PAYLOAD_LEN = 69;
const INFO = new TextEncoder().encode("orrery-shield-note-v1");

export interface NotePlain {
  asset: bigint;
  amount: bigint;
  blinding: bigint;
}

function toFixed(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("The value is too large for one field.");
  return out;
}

function fromBytes(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function sharedKey(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  const shared = secp256k1.getSharedSecret(priv, pub, true).slice(1);
  return hkdf(sha256, shared, undefined, INFO, 32);
}

/** Encrypts a note opening to a registered viewing key. */
export function encryptNote(viewKey: Hex, note: NotePlain): Hex {
  const eph = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(eph, true);
  const nonce = new Uint8Array(24);
  crypto.getRandomValues(nonce);
  const payload = new Uint8Array(PAYLOAD_LEN);
  payload[0] = VERSION;
  payload.set(toFixed(note.asset, 20), 1);
  payload.set(toFixed(note.amount, 16), 21);
  payload.set(toFixed(note.blinding, 32), 37);
  const sealed = xchacha20poly1305(sharedKey(eph, hexToBytes(viewKey)), nonce).encrypt(payload);
  const out = new Uint8Array(33 + 24 + sealed.length);
  out.set(ephPub, 0);
  out.set(nonce, 33);
  out.set(sealed, 57);
  return bytesToHex(out);
}

/** Returns the opening if this ciphertext was encrypted to `viewPriv`, otherwise null. */
export function tryDecryptNote(viewPriv: Uint8Array, ciphertext: Hex): NotePlain | null {
  const data = hexToBytes(ciphertext);
  if (data.length !== 33 + 24 + PAYLOAD_LEN + 16) return null;
  try {
    const key = sharedKey(viewPriv, data.slice(0, 33));
    const payload = xchacha20poly1305(key, data.slice(33, 57)).decrypt(data.slice(57));
    if (payload[0] !== VERSION) return null;
    return {
      asset: fromBytes(payload.slice(1, 21)),
      amount: fromBytes(payload.slice(21, 37)),
      blinding: fromBytes(payload.slice(37, 69)),
    };
  } catch {
    return null;
  }
}
