// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test stand-in for the ORRY contracts while lanes A and B are unmerged. Answers any call with a preset
/// return (first by exact calldata, then by selector), reverts with preset data when told to, counts calls that land
/// in a transaction, and emits any log on request, so the services are tested against the frozen ABIs only.
/// Development and test deployments only.
contract OrryStandIn {
    mapping(bytes32 => bytes) internal byInput;
    mapping(bytes32 => bool) internal hasInput;
    mapping(bytes4 => bytes) internal bySelector;
    mapping(bytes4 => bool) internal hasSelector;
    mapping(bytes4 => bytes) internal revertData;
    mapping(bytes4 => bool) internal reverts;
    mapping(bytes4 => uint256) public callCount;

    function setResponse(bytes4 selector, bytes calldata output) external {
        bySelector[selector] = output;
        hasSelector[selector] = true;
    }

    function setResponseFor(bytes calldata input, bytes calldata output) external {
        bytes32 k = keccak256(input);
        byInput[k] = output;
        hasInput[k] = true;
    }

    function setRevert(bytes4 selector, bytes calldata data, bool on) external {
        revertData[selector] = data;
        reverts[selector] = on;
    }

    function emitLog(bytes32[] calldata topics, bytes calldata data) external {
        bytes memory d = data;
        uint256 n = topics.length;
        require(n <= 4, "too many topics");
        bytes32 t0 = n > 0 ? topics[0] : bytes32(0);
        bytes32 t1 = n > 1 ? topics[1] : bytes32(0);
        bytes32 t2 = n > 2 ? topics[2] : bytes32(0);
        bytes32 t3 = n > 3 ? topics[3] : bytes32(0);
        assembly {
            let p := add(d, 32)
            let l := mload(d)
            switch n
            case 0 { log0(p, l) }
            case 1 { log1(p, l, t0) }
            case 2 { log2(p, l, t0, t1) }
            case 3 { log3(p, l, t0, t1, t2) }
            default { log4(p, l, t0, t1, t2, t3) }
        }
    }

    receive() external payable {}

    fallback(bytes calldata input) external payable returns (bytes memory) {
        require(input.length >= 4, "no selector");
        bytes4 sel = bytes4(input[:4]);
        if (reverts[sel]) {
            bytes memory r = revertData[sel];
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
        callCount[sel] += 1;
        bytes32 k = keccak256(input);
        if (hasInput[k]) return byInput[k];
        if (hasSelector[sel]) return bySelector[sel];
        return "";
    }
}

/// @notice Stand-in for the quote paths of `OrreryTreasury`: verifies the EIP-712 quotes exactly as written in the
/// frozen `IOrreryTreasury` (type strings and domain), single-use quoteId, `expiry >= block.timestamp`, the caller is
/// the buyer or payer, then emits the frozen events. It burns nothing (no token in this stand-in).
contract QuoteTreasuryStandIn {
    event CreditsPaid(address indexed buyer, uint32 packs, uint256 orryAmount, bytes32 indexed quoteId);
    event VerificationBurned(uint256 indexed agentId, address indexed payer, uint256 orryAmount, bytes32 indexed quoteId);
    event Burned(uint8 indexed source, uint256 amount);

    error QuoteExpired();
    error QuoteUsed();
    error BadQuoteSignature();

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CREDITS_TYPEHASH =
        keccak256("CreditsQuote(address buyer,uint32 packs,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");
    bytes32 internal constant VERIFICATION_TYPEHASH =
        keccak256("VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");

    mapping(address => bool) public isQuoteSigner;
    mapping(bytes32 => bool) public quoteUsed;

    constructor(address signer) {
        isQuoteSigner[signer] = true;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Orrery Treasury"), keccak256("1"), block.chainid, address(this)));
    }

    function burnForCredits(uint32 packs, uint256 orryAmount, bytes32 quoteId, uint64 expiry, bytes calldata sig) external {
        _accept(keccak256(abi.encode(CREDITS_TYPEHASH, msg.sender, packs, orryAmount, quoteId, expiry)), quoteId, expiry, sig);
        emit Burned(2, orryAmount);
        emit CreditsPaid(msg.sender, packs, orryAmount, quoteId);
    }

    function verifyWithOrry(uint256 agentId, address, uint256 orryAmount, bytes32 quoteId, uint64 expiry, bytes calldata sig) external {
        _accept(keccak256(abi.encode(VERIFICATION_TYPEHASH, msg.sender, agentId, orryAmount, quoteId, expiry)), quoteId, expiry, sig);
        emit Burned(3, orryAmount);
        emit VerificationBurned(agentId, msg.sender, orryAmount, quoteId);
    }

    function _accept(bytes32 structHash, bytes32 quoteId, uint64 expiry, bytes calldata sig) internal {
        if (expiry < block.timestamp) revert QuoteExpired();
        if (quoteUsed[quoteId]) revert QuoteUsed();
        if (sig.length != 65) revert BadQuoteSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        address signer = ecrecover(keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash)), v, r, s);
        if (signer == address(0) || !isQuoteSigner[signer]) revert BadQuoteSignature();
        quoteUsed[quoteId] = true;
    }
}

/// @dev The market's commitment hash with the frozen `ISealedBatchMarket.Order` layout, so the SDK's off-chain
/// `orderCommitment` is checked against Solidity's own `abi.encode` (wave R1).
contract CommitmentProbe {
    enum Mode {
        Limit,
        Swap
    }

    struct Order {
        bool sellAsset;
        uint256 amountIn;
        uint256 limitPrice;
        Mode mode;
        bool payFeeInOrry;
    }

    function commitmentFor(uint256 batch, address account, Order calldata order, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(batch, account, order, salt));
    }
}
