// Orrery Shield client (lane L3,
// docs/updates/L3-R2-SPEC.md 6). Mirrors OrreryShield's incremental tree.
import { hash2 } from "./hash";

export const DEPTH = 20;

/** zeros[i] is the root of an empty subtree of height i; zeros[DEPTH] is the empty root. */
export const ZEROS: bigint[] = (() => {
  const z = [0n];
  for (let i = 0; i < DEPTH; i++) z.push(hash2(z[i]!, z[i]!));
  return z;
})();

/** Append-only Poseidon2 tree mirroring OrreryShield's incremental tree. */
export class MerkleTree {
  private levels: bigint[][] = Array.from({ length: DEPTH + 1 }, () => []);

  get size(): number {
    return this.levels[0]!.length;
  }

  insert(leaf: bigint): number {
    const index = this.size;
    this.levels[0]!.push(leaf);
    let at = index;
    for (let level = 0; level < DEPTH; level++) {
      const parent = at >> 1;
      const left = this.node(level, parent * 2);
      const right = this.node(level, parent * 2 + 1);
      this.levels[level + 1]![parent] = hash2(left, right);
      at = parent;
    }
    return index;
  }

  private node(level: number, index: number): bigint {
    return this.levels[level]![index] ?? ZEROS[level]!;
  }

  root(): bigint {
    return this.size === 0 ? ZEROS[DEPTH]! : this.levels[DEPTH]![0]!;
  }

  path(index: number): bigint[] {
    if (index >= this.size) throw new Error(`Leaf ${index} is past the end of the note tree.`);
    const siblings: bigint[] = [];
    let at = index;
    for (let level = 0; level < DEPTH; level++) {
      siblings.push(this.node(level, at ^ 1));
      at >>= 1;
    }
    return siblings;
  }

  leaf(index: number): bigint | undefined {
    return this.levels[0]![index];
  }
}
