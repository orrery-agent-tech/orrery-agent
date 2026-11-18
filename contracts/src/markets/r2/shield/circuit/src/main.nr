// The transact circuit of Orrery Shield (lane L3). The verifier in
// ../verifier/HonkVerifier.sol is generated from it; the EIP-712 domain is a public input, so Orrery's own domain
// ("Orrery Shield") needs no change here.
// Transact circuit: two notes in, two notes out, one asset.
//
// The wallet keeps spending authority. Every action is an EIP-712 `Action` that the
// owner's wallet signs; the proof shows that signature is valid for the address that
// owns the input notes without revealing that address. Account keys derived in the
// browser can find and decrypt notes and compute nullifiers, but cannot spend.
//
// Hashes are single Poseidon2 permutations (width 4) with the input count in the
// capacity word, identical to Barretenberg's sponge for up to three inputs and to
// LibPoseidon2Yul's hash_1/hash_2/hash_3 on chain.

mod hash;
mod eip712;

use hash::{hash1, hash2, hash3, merkle_root};

pub global DEPTH: u32 = 20;

global KIND_SEND: Field = 1;
global KIND_WITHDRAW: Field = 2;

// "intent" as a field element: keeps intent nullifiers apart from note nullifiers.
global INTENT_TAG: Field = 0x696e74656e74;

fn main(
    // Public inputs, in the order the pool contract passes them.
    root: pub Field,
    nullifiers: pub [Field; 2],
    out_commitments: pub [Field; 2],
    asset: pub Field,
    kind: pub Field,
    withdraw_amount: pub Field,
    withdraw_to: pub Field,
    fee: pub Field,
    protocol_fee: pub Field,
    intent_nullifier: pub Field,
    domain_hi: pub Field,
    domain_lo: pub Field,
    ext_data_hash: pub Field,
    // Wallet authorisation.
    pub_key_x: [u8; 32],
    pub_key_y: [u8; 32],
    signature: [u8; 64],
    // Account key and the signed intent.
    nk: Field,
    intent_amount: Field,
    intent_to: Field,
    intent_nonce: Field,
    recipient_npk: Field,
    // Notes.
    in_amounts: [Field; 2],
    in_blindings: [Field; 2],
    in_indices: [Field; 2],
    in_paths: [[Field; DEPTH]; 2],
    out_amounts: [Field; 2],
    out_blindings: [Field; 2],
) {
    assert((kind - KIND_SEND) * (kind - KIND_WITHDRAW) == 0, "unknown kind");
    let is_send = kind == KIND_SEND;

    asset.assert_max_bit_size::<160>();
    intent_to.assert_max_bit_size::<160>();
    withdraw_to.assert_max_bit_size::<160>();
    intent_amount.assert_max_bit_size::<128>();
    withdraw_amount.assert_max_bit_size::<128>();
    fee.assert_max_bit_size::<128>();
    protocol_fee.assert_max_bit_size::<128>();
    intent_nonce.assert_max_bit_size::<128>();

    // 1. The owner's wallet signed exactly this action. Every value that leaves the pool
    //    (amount, fee, protocol fee) is in the signed struct, so the code that builds the
    //    proof cannot move more than the wallet showed.
    let digest = eip712::action_digest(
        domain_hi,
        domain_lo,
        kind,
        asset,
        intent_amount,
        intent_to,
        fee,
        protocol_fee,
        intent_nonce,
    );
    assert(
        std::ecdsa_secp256k1::verify_signature(pub_key_x, pub_key_y, signature, digest),
        "bad signature",
    );
    let owner = eip712::eth_address(pub_key_x, pub_key_y);
    let owner_hash = hash2(owner, hash1(nk));

    // 2. A signature authorises one action only.
    assert(intent_nullifier == hash3(nk, intent_nonce, INTENT_TAG), "bad intent nullifier");

    // 3. Input notes belong to the signer and sit in the tree. Zero-amount inputs are
    //    padding: they still produce a unique nullifier but skip the membership check.
    let mut total_in = 0;
    for i in 0..2 {
        in_amounts[i].assert_max_bit_size::<128>();
        let commitment = hash3(asset, in_amounts[i], hash2(owner_hash, in_blindings[i]));
        let computed_root = merkle_root(commitment, in_indices[i], in_paths[i]);
        if in_amounts[i] != 0 {
            assert(computed_root == root, "note not in tree");
        }
        assert(nullifiers[i] == hash3(nk, commitment, in_indices[i]), "bad nullifier");
        total_in += in_amounts[i];
    }
    assert(nullifiers[0] != nullifiers[1], "duplicate input");

    // 4. Outputs. A send pays the signed amount to the signed recipient's account and
    //    returns change to the signer. A withdrawal keeps both outputs with the signer.
    //    An output committed as 0 is omitted: the pool does not insert it, so it must be
    //    empty. This is how notes still leave once the tree is full.
    let recipient_hash = hash2(intent_to, recipient_npk);
    let out_owners = [if is_send { recipient_hash } else { owner_hash }, owner_hash];
    let mut total_out = 0;
    for j in 0..2 {
        out_amounts[j].assert_max_bit_size::<128>();
        let commitment = hash3(asset, out_amounts[j], hash2(out_owners[j], out_blindings[j]));
        if out_commitments[j] == 0 {
            assert(out_amounts[j] == 0, "omitted output must be empty");
        } else {
            assert(out_commitments[j] == commitment, "bad output commitment");
        }
        total_out += out_amounts[j];
    }

    if is_send {
        assert(out_amounts[0] == intent_amount, "send amount mismatch");
        assert(withdraw_amount == 0, "send cannot withdraw");
        assert(withdraw_to == 0, "send cannot withdraw");
    } else {
        assert(withdraw_amount == intent_amount, "withdraw amount mismatch");
        assert(withdraw_to == intent_to, "withdraw recipient mismatch");
    }

    // 5. Value is conserved; everything that leaves the pool is public.
    assert(
        total_in == total_out + withdraw_amount + fee + protocol_fee,
        "value not conserved",
    );

    // Relayer address and encrypted notes are bound through this hash.
    std::as_witness(ext_data_hash);
}
