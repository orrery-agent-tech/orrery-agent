// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6). Changed: the protocol fee floor is the pool's own `withdrawFeeFloor(to, amount)` (it carries the staker
// discount), passed in by the caller.
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseSignature,
  recoverPublicKey,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { ACTION_TYPES, KIND, actionDomain, domainSeparator, splitDomain, type Kind } from "./eip712";
import { encryptNote } from "./encryption";
import { FIELD_SIZE, INTENT_TAG, hash2, hash3 } from "./hash";
import { ownerHash, type AccountKeys } from "./keys";
import { commitmentOf, nullifierOf, randomField, randomU128, type Note, type OwnedNote } from "./note";
import { DEPTH, ZEROS, type MerkleTree } from "./tree";

export const BPS = 10_000n;

export interface Recipient {
  npk: bigint;
  viewKey: Hex;
}

export interface BuildTransactArgs {
  chainId: number;
  pool: Address;
  owner: Address;
  keys: AccountKeys;
  kind: Kind;
  asset: Address;
  /** Amount delivered to `to`. */
  amount: bigint;
  /** A registered account for a send; any address for a withdrawal. */
  to: Address;
  /** Registry entry of `to`; required for a send. */
  recipient?: Recipient;
  /** Network fee paid to the relayer, in the same asset. */
  fee: bigint;
  /** Withdrawals: the pool's `withdrawFeeFloor(to, amount)`, read from the pool, not from a relayer. */
  protocolFeeFloor?: bigint;
  /**
   * Withdrawals only: protocol fee to pay instead of the floor. It must be at least the floor;
   * {@link exitWithdrawal} uses it to absorb rounding dust so a full exit leaves no change.
   */
  protocolFee?: bigint;
  /**
   * Commit empty outputs as 0 so the pool does not insert them. Defaults to on when the tree
   * has fewer than two free leaves, which is the only way notes leave a full tree.
   */
  omitEmptyOutputs?: boolean;
  /** Unspent notes of `asset` owned by `owner`. */
  notes: OwnedNote[];
  tree: MerkleTree;
  relayer: Address;
}

/** Arguments for OrreryShield.transact, minus the proof. */
export interface TxArgsBase {
  root: bigint;
  nullifiers: [bigint, bigint];
  outCommitments: [bigint, bigint];
  asset: Address;
  kind: number;
  withdrawAmount: bigint;
  withdrawTo: Address;
  fee: bigint;
  protocolFee: bigint;
  intentNullifier: bigint;
}

export interface ExtData {
  relayer: Address;
  encryptedOutput0: Hex;
  encryptedOutput1: Hex;
}

export interface PreparedTransact {
  /** EIP-712 payload for the owner's wallet. */
  typedData: {
    domain: ReturnType<typeof actionDomain>;
    types: typeof ACTION_TYPES;
    primaryType: "Action";
    message: {
      kind: number;
      token: Address;
      amount: bigint;
      to: Address;
      fee: bigint;
      protocolFee: bigint;
      nonce: bigint;
    };
  };
  args: TxArgsBase;
  ext: ExtData;
  spent: OwnedNote[];
  outputs: [Note, Note];
  /** Builds the circuit inputs once the wallet has signed `typedData`. */
  witness(signature: Hex): Promise<Record<string, unknown>>;
}

export class InsufficientNotesError extends Error {
  constructor(
    readonly needed: bigint,
    readonly bestPair: bigint,
  ) {
    super(`Your two largest notes hold ${bestPair}, short of the ${needed} this move needs.`);
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const hex = (v: bigint) => `0x${v.toString(16)}`;

export function extDataHash(ext: ExtData): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
    [ext.relayer, ext.encryptedOutput0, ext.encryptedOutput1],
  );
  return BigInt(keccak256(encoded)) % FIELD_SIZE;
}

/** Picks at most two notes covering `needed`: the smallest single note, else the two largest. */
export function selectNotes(notes: OwnedNote[], needed: bigint): OwnedNote[] {
  const sorted = [...notes].filter((n) => n.amount > 0n).sort((a, b) => (a.amount < b.amount ? -1 : 1));
  const single = sorted.find((n) => n.amount >= needed);
  if (single) return [single];
  const pair = sorted.slice(-2);
  const total = pair.reduce((s, n) => s + n.amount, 0n);
  if (pair.length < 2 || total < needed) throw new InsufficientNotesError(needed, total);
  return pair;
}

/** The floor for the protocol fee on a withdrawal of `amount` before any staker discount. */
export const protocolFeeFloor = (amount: bigint, withdrawFeeBps: number) => (amount * BigInt(withdrawFeeBps)) / BPS;

/**
 * Amount and protocol fee that spend `totalIn` exactly, leaving no change: the largest amount
 * whose floor fits, with the rounding dust added to the protocol fee.
 */
export function exitWithdrawal(totalIn: bigint, fee: bigint, withdrawFeeBps: number): { amount: bigint; protocolFee: bigint } {
  const room = totalIn - fee;
  if (room <= 0n) throw new InsufficientNotesError(fee + 1n, totalIn);
  let amount = (room * BPS) / (BPS + BigInt(withdrawFeeBps));
  while (amount + 1n + protocolFeeFloor(amount + 1n, withdrawFeeBps) <= room) amount += 1n;
  return { amount, protocolFee: room - amount };
}

export function prepareTransact(a: BuildTransactArgs): PreparedTransact {
  const kind = KIND[a.kind];
  const asset = BigInt(a.asset);
  let protocolFee = 0n;
  if (a.kind === "withdraw") {
    const floor = a.protocolFeeFloor ?? 0n;
    protocolFee = a.protocolFee ?? floor;
    if (protocolFee < floor) throw new Error("The protocol fee is under the pool's minimum.");
  } else if (a.protocolFee) {
    throw new Error("A private send carries no protocol fee.");
  }
  const needed = a.amount + a.fee + protocolFee;
  const spent = selectNotes(a.notes, needed);
  const totalIn = spent.reduce((s, n) => s + n.amount, 0n);
  const change = totalIn - needed;
  const myHash = ownerHash(a.owner, a.keys.npk);

  let outputs: [Note, Note];
  let enc0: Hex;
  if (a.kind === "send") {
    if (!a.recipient) throw new Error("A send needs the recipient's registered Shield keys.");
    const out0: Note = {
      asset,
      amount: a.amount,
      blinding: randomField(),
      ownerHash: hash2(BigInt(a.to), a.recipient.npk),
    };
    outputs = [out0, { asset, amount: change, blinding: randomField(), ownerHash: myHash }];
    enc0 = encryptNote(a.recipient.viewKey, out0);
  } else {
    const out0: Note = { asset, amount: change, blinding: randomField(), ownerHash: myHash };
    outputs = [out0, { asset, amount: 0n, blinding: randomField(), ownerHash: myHash }];
    enc0 = encryptNote(a.keys.viewKey, out0);
  }
  const enc1 = encryptNote(a.keys.viewKey, outputs[1]);

  // An omitted output is committed as 0 and never inserted; the circuit allows that only for
  // an empty note. Outputs that carry value always need a leaf.
  const omit = a.omitEmptyOutputs ?? 2 ** DEPTH - a.tree.size < 2;
  const omitted = outputs.map((o) => omit && o.amount === 0n);

  // Pad to two inputs with a zero note; the circuit skips its membership check.
  const inputs: { note: Note; commitment: bigint; leafIndex: number; path: bigint[] }[] = spent.map((n) => ({
    note: n,
    commitment: n.commitment,
    leafIndex: n.leafIndex,
    path: a.tree.path(n.leafIndex),
  }));
  while (inputs.length < 2) {
    const note: Note = { asset, amount: 0n, blinding: randomField(), ownerHash: myHash };
    inputs.push({ note, commitment: commitmentOf(note), leafIndex: 0, path: ZEROS.slice(0, DEPTH) });
  }

  const nonce = randomU128();
  const ext: ExtData = {
    relayer: a.relayer,
    encryptedOutput0: omitted[0] ? "0x" : enc0,
    encryptedOutput1: omitted[1] ? "0x" : enc1,
  };
  const to = getAddress(a.to);
  const args: TxArgsBase = {
    root: a.tree.root(),
    nullifiers: [
      nullifierOf(a.keys.nk, inputs[0]!.commitment, inputs[0]!.leafIndex),
      nullifierOf(a.keys.nk, inputs[1]!.commitment, inputs[1]!.leafIndex),
    ],
    outCommitments: [omitted[0] ? 0n : commitmentOf(outputs[0]), omitted[1] ? 0n : commitmentOf(outputs[1])],
    asset: getAddress(a.asset),
    kind,
    withdrawAmount: a.kind === "withdraw" ? a.amount : 0n,
    withdrawTo: a.kind === "withdraw" ? to : ZERO_ADDRESS,
    fee: a.fee,
    protocolFee,
    intentNullifier: hash3(a.keys.nk, nonce, INTENT_TAG),
  };

  const typedData = {
    domain: actionDomain(a.chainId, a.pool),
    types: ACTION_TYPES,
    primaryType: "Action" as const,
    message: { kind, token: getAddress(a.asset), amount: a.amount, to, fee: a.fee, protocolFee, nonce },
  };

  const witness = async (signature: Hex) => {
    const digest = hashTypedData(typedData);
    const pubHex = await recoverPublicKey({ hash: digest, signature });
    const pub = hexToBytes(pubHex);
    if (publicKeyToAddress(pubHex) !== getAddress(a.owner)) {
      throw new Error("The signature does not match the note owner.");
    }
    const { r, s } = parseSignature(signature);
    let sv = BigInt(s);
    if (sv > secp256k1.CURVE.n / 2n) sv = secp256k1.CURVE.n - sv; // circuit expects low-s
    const sig = [...hexToBytes(r), ...hexToBytes(`0x${sv.toString(16).padStart(64, "0")}`)];
    const { hi, lo } = splitDomain(domainSeparator(a.chainId, a.pool));
    const recipientNpk = a.kind === "send" ? a.recipient!.npk : 0n;

    return {
      root: hex(args.root),
      nullifiers: args.nullifiers.map(hex),
      out_commitments: args.outCommitments.map(hex),
      asset: hex(asset),
      kind: hex(BigInt(kind)),
      withdraw_amount: hex(args.withdrawAmount),
      withdraw_to: hex(BigInt(args.withdrawTo)),
      fee: hex(args.fee),
      protocol_fee: hex(protocolFee),
      intent_nullifier: hex(args.intentNullifier),
      domain_hi: hex(hi),
      domain_lo: hex(lo),
      ext_data_hash: hex(extDataHash(ext)),
      pub_key_x: [...pub.slice(1, 33)],
      pub_key_y: [...pub.slice(33, 65)],
      signature: sig,
      nk: hex(a.keys.nk),
      intent_amount: hex(a.amount),
      intent_to: hex(BigInt(to)),
      intent_nonce: hex(nonce),
      recipient_npk: hex(recipientNpk),
      in_amounts: inputs.map((i) => hex(i.note.amount)),
      in_blindings: inputs.map((i) => hex(i.note.blinding)),
      in_indices: inputs.map((i) => hex(BigInt(i.leafIndex))),
      in_paths: inputs.map((i) => i.path.map(hex)),
      out_amounts: outputs.map((o) => hex(o.amount)),
      out_blindings: outputs.map((o) => hex(o.blinding)),
    };
  };

  return { typedData, args, ext, spent, outputs, witness };
}

/** Public inputs in circuit order, for checking a proof before submitting it. */
export function publicInputsOf(args: TxArgsBase, ext: ExtData, chainId: number, pool: Address): bigint[] {
  const { hi, lo } = splitDomain(domainSeparator(chainId, pool));
  return [
    args.root,
    ...args.nullifiers,
    ...args.outCommitments,
    BigInt(args.asset),
    BigInt(args.kind),
    args.withdrawAmount,
    BigInt(args.withdrawTo),
    args.fee,
    args.protocolFee,
    args.intentNullifier,
    hi,
    lo,
    extDataHash(ext),
  ];
}
