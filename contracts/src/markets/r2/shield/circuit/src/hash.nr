use std::hash::poseidon2_permutation;

global TWO_POW_64: Field = 18446744073709551616;

pub fn hash1(a: Field) -> Field {
    poseidon2_permutation([a, 0, 0, TWO_POW_64])[0]
}

pub fn hash2(a: Field, b: Field) -> Field {
    poseidon2_permutation([a, b, 0, 2 * TWO_POW_64])[0]
}

pub fn hash3(a: Field, b: Field, c: Field) -> Field {
    poseidon2_permutation([a, b, c, 3 * TWO_POW_64])[0]
}

// Root of a binary Poseidon2 tree; bit i of `index` says whether the node at level i is a
// right child. Decomposing into DEPTH bits also proves index < 2^DEPTH, so one note has
// exactly one nullifier.
pub fn merkle_root<let DEPTH: u32>(leaf: Field, index: Field, path: [Field; DEPTH]) -> Field {
    let bits: [bool; DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..DEPTH {
        node = if !bits[i] {
            hash2(node, path[i])
        } else {
            hash2(path[i], node)
        };
    }
    node
}

#[test]
fn hash_vectors() {
    // Printed so the TypeScript and Solidity suites can pin the same values.
    println(hash1(1));
    println(hash2(1, 2));
    println(hash3(1, 2, 3));
}

#[test]
fn merkle_left_and_right() {
    let path = [7, 9];
    let root0 = merkle_root(5, 0, path);
    assert(root0 == hash2(hash2(5, 7), 9));
    let root3 = merkle_root(5, 3, path);
    assert(root3 == hash2(9, hash2(7, 5)));
}

#[test(should_fail)]
fn merkle_index_out_of_range() {
    let _ = merkle_root(5, 4, [7, 9]);
}
