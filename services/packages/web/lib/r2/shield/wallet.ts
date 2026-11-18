// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6). Changed: OrreryShield inserts a deposit at once (no queue, no screener) and computes
// its commitment from the net amount, so a deposit is recognised from the `Deposited` event's own amount and fee.
import type { Address, Hex } from "viem";
import { tryDecryptNote } from "./encryption";
import { ownerHash, type AccountKeys } from "./keys";
import { commitmentOf, nullifierOf, secretCommit, type Note, type OwnedNote } from "./note";
import { MerkleTree } from "./tree";

/** Pool events in chain order. */
export type PoolEvent =
  | {
      type: "Deposited";
      depositor: Address;
      amount: bigint;
      fee: bigint;
      secretCommit: bigint;
      commitment: bigint;
      leafIndex: number;
      encryptedNote: Hex;
    }
  | { type: "NewCommitment"; commitment: bigint; leafIndex: number; encryptedNote: Hex }
  | { type: "NewNullifier"; nullifier: bigint };

const BIGINT_FIELDS = new Set(["amount", "fee", "secretCommit", "commitment", "nullifier"]);

/** JSON form of an event (the API's shape): bigints as decimal strings. */
export function eventFromJson(raw: Record<string, unknown>): PoolEvent {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = BIGINT_FIELDS.has(k) ? BigInt(v as string) : k === "leafIndex" ? Number(v) : v;
  return out as PoolEvent;
}

/**
 * Rebuilds the tree and this account's notes from pool events. Every note it reports was decrypted with the account's
 * viewing key and re-derived from the on-chain commitment, so a wrong ciphertext never shows up as balance. Check the
 * rebuilt root against the pool's `knownRoots` and call {@link ShieldedWallet.checkSpent} before trusting a balance.
 */
export class ShieldedWallet {
  readonly tree = new MerkleTree();
  private readonly mine = new Map<number, OwnedNote>();
  private readonly nullifiers = new Set<bigint>();
  /** Nullifiers of notes an action spent, held out before the chain shows them spent. */
  private readonly held = new Set<bigint>();
  private readonly myHash: bigint;

  constructor(
    readonly owner: Address,
    readonly keys: AccountKeys,
  ) {
    this.myHash = ownerHash(owner, keys.npk);
  }

  apply(events: PoolEvent[]): void {
    for (const e of events) this.applyOne(e);
  }

  private tryOwn(encryptedNote: Hex): Note | null {
    const plain = tryDecryptNote(this.keys.viewPriv, encryptedNote);
    if (!plain) return null;
    return { ...plain, ownerHash: this.myHash };
  }

  private applyOne(e: PoolEvent): void {
    switch (e.type) {
      case "Deposited": {
        this.insert(e.commitment, e.leafIndex);
        const opened = this.tryOwn(e.encryptedNote);
        // the pool computed the note from the net amount; the depositor's ciphertext gives the blinding
        const note = opened ? { ...opened, amount: e.amount - e.fee } : null;
        if (note && secretCommit(note) === e.secretCommit && commitmentOf(note) === e.commitment) {
          this.mine.set(e.leafIndex, { ...note, commitment: e.commitment, leafIndex: e.leafIndex });
        }
        break;
      }
      case "NewCommitment": {
        this.insert(e.commitment, e.leafIndex);
        const note = this.tryOwn(e.encryptedNote);
        if (note && note.amount > 0n && commitmentOf(note) === e.commitment) {
          this.mine.set(e.leafIndex, { ...note, commitment: e.commitment, leafIndex: e.leafIndex });
        }
        break;
      }
      case "NewNullifier":
        this.nullifiers.add(e.nullifier);
        break;
    }
  }

  private insert(commitment: bigint, leafIndex: number): void {
    if (leafIndex !== this.tree.size) throw new Error(`Notes arrived out of order: leaf ${this.tree.size} was expected, ${leafIndex} came in.`);
    this.tree.insert(commitment);
  }

  isSpent(n: OwnedNote): boolean {
    return this.nullifiers.has(nullifierOf(this.keys.nk, n.commitment, n.leafIndex));
  }

  /** Asks the chain about every note this wallet still counts as unspent; returns how many were spent. */
  async checkSpent(nullifierSpent: (nullifier: bigint) => Promise<boolean>): Promise<number> {
    const open = this.notes().map((n) => nullifierOf(this.keys.nk, n.commitment, n.leafIndex));
    const spent = await Promise.all(open.map((x) => nullifierSpent(x)));
    let found = 0;
    open.forEach((x, i) => {
      if (spent[i]) {
        this.nullifiers.add(x);
        found += 1;
      }
    });
    return found;
  }

  /** Leaves `notes` out of the balance until the events of the action that spent them arrive. */
  hold(notes: OwnedNote[]): bigint[] {
    const held = notes.map((n) => nullifierOf(this.keys.nk, n.commitment, n.leafIndex));
    for (const x of held) this.held.add(x);
    return held;
  }

  release(nullifiers: bigint[]): void {
    for (const x of nullifiers) this.held.delete(x);
  }

  /** Unspent notes not held by an action in flight. */
  notes(): OwnedNote[] {
    return [...this.mine.values()].filter(
      (n) => !this.isSpent(n) && !this.held.has(nullifierOf(this.keys.nk, n.commitment, n.leafIndex)),
    );
  }

  balance(): bigint {
    return this.notes().reduce((s, n) => s + n.amount, 0n);
  }
}
