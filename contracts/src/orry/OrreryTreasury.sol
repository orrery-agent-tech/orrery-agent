// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Min} from "../interfaces/IExternal.sol";
import {IOrreryTreasury} from "./interfaces/IOrreryTreasury.sol";
import {IOrryBurnEvents, IOrryToken} from "./interfaces/IOrryToken.sol";

/// @notice The two `OrreryAttestor` calls the treasury makes.
interface IOrreryAttestorPay {
    function fee() external view returns (uint128);
    function payVerification(uint256 agentId, address expectedOwner, uint128 maxFee) external;
}

/// @title OrreryTreasury
/// @notice Orrery's USDG treasury (`docs/ORRY-BUILD-SPEC.md` 3.5, invariants T-1 to T-6). Every USDG increase is
/// split by `sync`: `OWNER_BPS` to the owner, the rest to the buyback reserve. Coinless until `executeCoin`: the reserve
/// only accrues and the owner may reclaim it; once the coin is set the reserve leaves only through `pullBuyback`, at
/// most `PULL_BPS_PER_DAY` of the reserve measured at the window start per 24 hours (all of it at 1 USDG or less).
/// Also sells check packs and verifications for ORRY against EIP-712 quotes; the ORRY is burned.
/// @dev The owner can withdraw only `ownerAccrued`, reclaim the reserve while coinless, set the coin once, and manage
/// at most three quote signers. Never calls a Pons contract (R-1).
contract OrreryTreasury is IOrreryTreasury, IOrryBurnEvents {
    uint256 private constant BPS = 10_000;
    bytes32 private constant LOCK_SLOT = keccak256("orrery.orry.treasury.lock");

    uint64 public constant COIN_DELAY = 48 hours;
    uint64 public constant COIN_WINDOW = 7 days;
    uint16 public constant PULL_BPS_PER_DAY = 1000;
    uint32 public constant MAX_ORRY_VERIFICATIONS_PER_DAY = 25;
    uint8 public constant MAX_QUOTE_SIGNERS = 3;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Orrery Treasury");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant CREDITS_TYPEHASH =
        keccak256("CreditsQuote(address buyer,uint32 packs,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");
    /// @dev Half the secp256k1 order: a signature with a larger `s` is the malleable twin of another and is refused.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    bytes32 private constant VERIFICATION_TYPEHASH =
        keccak256("VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,bytes32 quoteId,uint64 expiry)");

    uint16 public immutable OWNER_BPS;
    address public immutable usdg;
    address public immutable attestor;
    /// @dev One whole USDG: at or below it the whole reserve may be pulled at once.
    uint256 private immutable _wholeUnit;

    address public owner;
    address public pendingOwner;

    address public orry;
    address public buyback;
    address private _proposedOrry;
    address private _proposedBuyback;
    uint64 private _executableAt;

    uint256 public ownerAccrued;
    uint256 public buybackReserve;

    mapping(address signer => bool) public isQuoteSigner;
    uint8 private _signerCount;
    mapping(bytes32 quoteId => bool) public quoteUsed;

    uint64 private _windowStart;
    uint256 private _windowBase;
    uint256 private _windowPulled;

    uint64 private _verifyDay;
    uint32 private _verifyCount;

    constructor(address usdg_, address attestor_, address owner_, uint16 ownerBps, address[] memory quoteSigners) {
        if (usdg_ == address(0) || attestor_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        require(ownerBps <= BPS, "bps above 10000");
        if (quoteSigners.length > MAX_QUOTE_SIGNERS) revert TooManySigners();
        usdg = usdg_;
        attestor = attestor_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        OWNER_BPS = ownerBps;
        _wholeUnit = 10 ** uint256(IERC20Min(usdg_).decimals());
        for (uint256 i; i < quoteSigners.length; ++i) {
            _setQuoteSigner(quoteSigners[i], true);
        }
    }

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            if tload(slot) { revert(0, 0) }
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------------ revenue split

    function sync() external nonReentrant {
        _sync();
    }

    function withdrawOwnerShare() external onlyOwner nonReentrant {
        _sync();
        uint256 amount = ownerAccrued;
        if (amount == 0) revert ZeroAmount();
        ownerAccrued = 0;
        address to = owner;
        _sendUsdg(to, amount);
        emit OwnerShareWithdrawn(to, amount);
    }

    function reclaimReserve() external onlyOwner nonReentrant {
        if (orry != address(0)) revert CoinAlreadySet();
        _sync();
        uint256 amount = buybackReserve;
        if (amount == 0) revert ZeroAmount();
        buybackReserve = 0;
        ownerAccrued += amount;
        emit ReserveReclaimed(amount);
    }

    // ------------------------------------------------------------------ the coin, set once

    function proposeCoin(address orry_, address buyback_) external onlyOwner {
        if (orry != address(0)) revert CoinAlreadySet();
        if (orry_ == address(0) || buyback_ == address(0)) revert ZeroAddress();
        uint64 executableAt = uint64(block.timestamp) + COIN_DELAY;
        _proposedOrry = orry_;
        _proposedBuyback = buyback_;
        _executableAt = executableAt;
        emit CoinProposed(orry_, buyback_, executableAt);
    }

    function executeCoin() external onlyOwner {
        if (orry != address(0)) revert CoinAlreadySet();
        uint64 executableAt = _executableAt;
        if (executableAt == 0) revert NoProposal();
        if (block.timestamp < executableAt) revert ProposalNotReady(executableAt);
        if (block.timestamp > uint256(executableAt) + COIN_WINDOW) revert ProposalExpired();
        address orry_ = _proposedOrry;
        address buyback_ = _proposedBuyback;
        orry = orry_;
        buyback = buyback_;
        delete _proposedOrry;
        delete _proposedBuyback;
        delete _executableAt;
        emit CoinSet(orry_, buyback_);
    }

    function pullBuyback(uint256 amount) external nonReentrant returns (uint256 pulled) {
        if (orry == address(0)) revert CoinNotSet();
        address to = buyback;
        if (msg.sender != to) revert NotBuyback();
        if (amount == 0) revert ZeroAmount();
        _sync();
        uint256 reserve = buybackReserve;
        if (_windowStart == 0 || block.timestamp >= uint256(_windowStart) + 1 days) {
            _windowStart = uint64(block.timestamp);
            _windowBase = reserve;
            _windowPulled = 0;
        }
        uint256 available = _available(reserve, _windowBase, _windowPulled);
        pulled = amount < available ? amount : available;
        if (pulled == 0) revert ZeroAmount();
        buybackReserve = reserve - pulled;
        _windowPulled += pulled;
        _sendUsdg(to, pulled);
        emit BuybackPulled(to, pulled);
    }

    // ------------------------------------------------------------------ ORRY checkout (burned)

    function burnForCredits(uint32 packs, uint256 orryAmount, bytes32 quoteId, uint64 expiry, bytes calldata sig)
        external
        nonReentrant
    {
        address coin = orry;
        if (coin == address(0)) revert CoinNotSet();
        if (packs == 0 || orryAmount == 0) revert ZeroAmount();
        bytes32 structHash = keccak256(abi.encode(CREDITS_TYPEHASH, msg.sender, packs, orryAmount, quoteId, expiry));
        _useQuote(structHash, quoteId, expiry, sig);
        _burnFrom(coin, msg.sender, orryAmount);
        emit CreditsPaid(msg.sender, packs, orryAmount, quoteId);
        emit Burned(2, orryAmount);
    }

    function verifyWithOrry(
        uint256 agentId,
        address expectedOwner,
        uint256 orryAmount,
        bytes32 quoteId,
        uint64 expiry,
        bytes calldata sig
    ) external nonReentrant {
        address coin = orry;
        if (coin == address(0)) revert CoinNotSet();
        if (orryAmount == 0) revert ZeroAmount();
        bytes32 structHash =
            keccak256(abi.encode(VERIFICATION_TYPEHASH, msg.sender, agentId, orryAmount, quoteId, expiry));
        _useQuote(structHash, quoteId, expiry, sig);

        uint64 day = uint64(block.timestamp / 1 days);
        if (day != _verifyDay) {
            _verifyDay = day;
            _verifyCount = 0;
        }
        if (_verifyCount >= MAX_ORRY_VERIFICATIONS_PER_DAY) revert DailyVerificationCap();
        _verifyCount += 1;

        _burnFrom(coin, msg.sender, orryAmount);
        // the treasury pays as itself: the attestor records fee 0 and moves no USDG
        IOrreryAttestorPay(attestor).payVerification(agentId, expectedOwner, IOrreryAttestorPay(attestor).fee());
        emit VerificationBurned(agentId, msg.sender, orryAmount, quoteId);
        emit Burned(3, orryAmount);
    }

    // ------------------------------------------------------------------ admin

    function setQuoteSigner(address signer, bool enabled) external onlyOwner {
        _setQuoteSigner(signer, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner; // zero cancels a pending transfer
        emit OwnershipTransferStarted(msg.sender, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ views

    function availableForBuyback() external view returns (uint256) {
        if (orry == address(0)) return 0;
        (, uint256 toReserve) = _unsynced();
        uint256 reserve = buybackReserve + toReserve;
        if (_windowStart == 0 || block.timestamp >= uint256(_windowStart) + 1 days) {
            return _available(reserve, reserve, 0);
        }
        return _available(reserve, _windowBase, _windowPulled);
    }

    // ------------------------------------------------------------------ internals

    function _sync() private {
        (uint256 toOwner, uint256 toReserve) = _unsynced();
        if (toOwner == 0 && toReserve == 0) return;
        ownerAccrued += toOwner;
        buybackReserve += toReserve;
        emit Synced(toOwner, toReserve);
    }

    function _unsynced() private view returns (uint256 toOwner, uint256 toReserve) {
        uint256 bal = IERC20Min(usdg).balanceOf(address(this));
        uint256 booked = ownerAccrued + buybackReserve;
        if (bal <= booked) return (0, 0);
        uint256 fresh = bal - booked;
        toOwner = fresh * OWNER_BPS / BPS;
        toReserve = fresh - toOwner;
    }

    function _available(uint256 reserve, uint256 windowBase, uint256 windowPulled) private view returns (uint256) {
        if (reserve <= _wholeUnit) return reserve;
        uint256 cap = windowBase * PULL_BPS_PER_DAY / BPS;
        uint256 left = cap > windowPulled ? cap - windowPulled : 0;
        return left < reserve ? left : reserve;
    }

    function _useQuote(bytes32 structHash, bytes32 quoteId, uint64 expiry, bytes calldata sig) private {
        if (expiry < block.timestamp) revert QuoteExpired();
        if (quoteUsed[quoteId]) revert QuoteUsed();
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address signer = _recover(digest, sig);
        if (signer == address(0) || !isQuoteSigner[signer]) revert BadQuoteSignature();
        quoteUsed[quoteId] = true;
    }

    /// @dev ECDSA recovery of a 65-byte (r, s, v) signature with the same rules as OpenZeppelin's `tryRecover`: wrong
    /// length or an `s` above half the curve order gives address 0, and so does anything `ecrecover` rejects. Written
    /// inline so the treasury needs no library beyond forge-std in the v1 tree (R-12).
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER) return address(0);
        return ecrecover(digest, v, r, s);
    }

    /// @dev Burns from `from` and requires the total supply to fall by exactly `amount` (T-4).
    function _burnFrom(address coin, address from, uint256 amount) private {
        uint256 supplyBefore = IOrryToken(coin).totalSupply();
        IOrryToken(coin).burnFrom(from, amount);
        if (supplyBefore - IOrryToken(coin).totalSupply() != amount) revert InexactBurn();
    }

    function _setQuoteSigner(address signer, bool enabled) private {
        if (signer == address(0)) revert ZeroAddress();
        if (isQuoteSigner[signer] == enabled) return;
        if (enabled) {
            if (_signerCount >= MAX_QUOTE_SIGNERS) revert TooManySigners();
            _signerCount += 1;
        } else {
            _signerCount -= 1;
        }
        isQuoteSigner[signer] = enabled;
        emit QuoteSignerSet(signer, enabled);
    }

    function _sendUsdg(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = usdg.call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "usdg transfer failed");
    }
}
