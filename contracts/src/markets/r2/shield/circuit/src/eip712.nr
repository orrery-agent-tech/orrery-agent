use keccak256::keccak256;

// keccak256("Action(uint8 kind,address token,uint256 amount,address to,uint256 fee,uint256 protocolFee,uint256 nonce)")
global ACTION_TYPEHASH: [u8; 32] = [
    0xb7, 0x66, 0xca, 0xd8, 0xda, 0x27, 0x33, 0xb4, 0x3a, 0xaf, 0x8a, 0x5d, 0xac, 0xab, 0x9e, 0x12,
    0xbd, 0xf3, 0x2c, 0x95, 0x4a, 0x29, 0x8a, 0x0b, 0x7e, 0x94, 0xcc, 0xbb, 0xf0, 0xc6, 0x3a, 0xc0,
];

fn put_word(buf: &mut [u8; 256], slot: u32, value: Field) {
    let bytes: [u8; 32] = value.to_be_bytes();
    for i in 0..32 {
        buf[slot * 32 + i] = bytes[i];
    }
}

// EIP-712 digest of Action{kind, token, amount, to, fee, protocolFee, nonce} under the pool's
// domain separator, passed in as two 128-bit halves because it does not fit one field element.
// 256 bytes still hash in two keccak blocks, so signing the protocol fee costs no extra rounds.
pub fn action_digest(
    domain_hi: Field,
    domain_lo: Field,
    kind: Field,
    token: Field,
    amount: Field,
    to: Field,
    fee: Field,
    protocol_fee: Field,
    nonce: Field,
) -> [u8; 32] {
    let mut s = [0 as u8; 256];
    for i in 0..32 {
        s[i] = ACTION_TYPEHASH[i];
    }
    put_word(&mut s, 1, kind);
    put_word(&mut s, 2, token);
    put_word(&mut s, 3, amount);
    put_word(&mut s, 4, to);
    put_word(&mut s, 5, fee);
    put_word(&mut s, 6, protocol_fee);
    put_word(&mut s, 7, nonce);
    let struct_hash = keccak256(s, 256);

    let hi: [u8; 16] = domain_hi.to_be_bytes();
    let lo: [u8; 16] = domain_lo.to_be_bytes();
    let mut d = [0 as u8; 66];
    d[0] = 0x19;
    d[1] = 0x01;
    for i in 0..16 {
        d[2 + i] = hi[i];
        d[18 + i] = lo[i];
    }
    for i in 0..32 {
        d[34 + i] = struct_hash[i];
    }
    keccak256(d, 66)
}

// Ethereum address of an uncompressed secp256k1 key: low 20 bytes of keccak256(x || y).
pub fn eth_address(x: [u8; 32], y: [u8; 32]) -> Field {
    let mut buf = [0 as u8; 64];
    for i in 0..32 {
        buf[i] = x[i];
        buf[32 + i] = y[i];
    }
    let h = keccak256(buf, 64);
    let mut addr: Field = 0;
    for i in 12..32 {
        addr = addr * 256 + h[i] as Field;
    }
    addr
}

#[test]
fn address_of_anvil_key_zero() {
    // Public key of the first default anvil account (private key 0xac09...ff80).
    let x: [u8; 32] = [
        0x83, 0x18, 0x53, 0x5b, 0x54, 0x10, 0x5d, 0x4a, 0x7a, 0xae, 0x60, 0xc0, 0x8f, 0xc4, 0x5f,
        0x96, 0x87, 0x18, 0x1b, 0x4f, 0xdf, 0xc6, 0x25, 0xbd, 0x1a, 0x75, 0x3f, 0xa7, 0x39, 0x7f,
        0xed, 0x75,
    ];
    let y: [u8; 32] = [
        0x35, 0x47, 0xf1, 0x1c, 0xa8, 0x69, 0x66, 0x46, 0xf2, 0xf3, 0xac, 0xb0, 0x8e, 0x31, 0x01,
        0x6a, 0xfa, 0xc2, 0x3e, 0x63, 0x0c, 0x5d, 0x11, 0xf5, 0x9f, 0x61, 0xfe, 0xf5, 0x7b, 0x0d,
        0x2a, 0xa5,
    ];
    assert(eth_address(x, y) == 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266);
}
