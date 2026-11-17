// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentityRegistry, IERC20Min} from "./interfaces/IExternal.sol";

/// @title OrreryAttestor
/// @notice Verification fee record per ERC-8004 agent, liveness attestations, and the key sets allowed to post
///         attestations and to sign check results. Spec: 08-contract-spec.md section 6. Holds no balance.
contract OrreryAttestor {
    uint256 public constant MAX_ATTESTERS = 5;
    uint256 public constant MAX_CHECK_SIGNERS = 5;
    uint64 public constant MAX_ATTESTATION_TTL = 7 days;

    struct Verification {
        address ownerAtPayment;
        uint64 paidAt;
        uint128 feePaid;
    }

    struct Attestation {
        uint64 observedAt;
        uint64 expiresAt;
        bool endpointsLive;
        bool registrationValid;
        bool domainVerified;
        bytes32 registrationHash;
        address attester;
    }

    IIdentityRegistry public immutable identityRegistry;
    IERC20Min public immutable feeToken;
    uint128 public immutable feeCap;

    address public owner;
    address public pendingOwner;
    address public treasury;
    uint128 public fee;

    mapping(address => bool) public isAttester;
    uint256 public attesterCount;
    mapping(address => bool) public isCheckSigner;
    uint256 public checkSignerCount;

    mapping(uint256 agentId => Verification) internal _verifications;
    mapping(uint256 agentId => Attestation) internal _attestations;

    event VerificationPaid(uint256 indexed agentId, address indexed payer, address indexed owner, uint128 fee);
    event Attested(uint256 indexed agentId, address indexed attester, uint64 observedAt, uint64 expiresAt);
    event AttestationCleared(uint256 indexed agentId, address indexed by);
    event AttesterSet(address indexed attester, bool enabled);
    event CheckSignerSet(address indexed signer, bool enabled);
    event FeeSet(uint128 fee);
    event TreasurySet(address indexed treasury);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotAttester();
    error NotPendingOwner();
    error ZeroAddress();
    error FeeAboveCap();
    error FeeChanged();
    error AlreadyVerified();
    error NotVerified();
    error BadObservedAt();
    error BadExpiry();
    error TooManyKeys();
    error InexactTransfer();
    error TransferFailed();
    error OwnerChanged();
    error BadDecimals();

    constructor(IIdentityRegistry identityRegistry_, IERC20Min feeToken_, address owner_, address treasury_, uint128 fee_) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        feeToken = feeToken_;
        uint8 dec = feeToken_.decimals();
        if (dec > 30) revert BadDecimals();
        uint128 cap = uint128(50 * (10 ** uint256(dec)));
        feeCap = cap;
        if (fee_ > cap) revert FeeAboveCap();
        owner = owner_;
        treasury = treasury_;
        fee = fee_;
        emit OwnershipTransferred(address(0), owner_);
        emit TreasurySet(treasury_);
        emit FeeSet(fee_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------------ verification fee (I5)

    /// @notice Pay the one-time verification fee for `agentId` and its current owner. `expectedOwner` and `maxFee`
    ///         protect the payer against an identity transfer or a fee change between signing and inclusion.
    ///         Any attestation from before this payment is deleted (code review R-03).
    function payVerification(uint256 agentId, address expectedOwner, uint128 maxFee) external {
        address agentOwner = identityRegistry.ownerOf(agentId);
        if (agentOwner != expectedOwner) revert OwnerChanged();
        if (isVerified(agentId)) revert AlreadyVerified();
        uint128 f = fee;
        if (f > maxFee) revert FeeChanged();
        uint128 recorded = f;
        address t = treasury;
        if (msg.sender == t) {
            recorded = 0;
        } else if (f != 0) {
            uint256 before = feeToken.balanceOf(t);
            (bool ok, bytes memory ret) =
                address(feeToken).call(abi.encodeCall(IERC20Min.transferFrom, (msg.sender, t, uint256(f))));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
            if (feeToken.balanceOf(t) != before + f) revert InexactTransfer();
        }
        _verifications[agentId] = Verification(agentOwner, uint64(block.timestamp), recorded);
        delete _attestations[agentId];
        emit VerificationPaid(agentId, msg.sender, agentOwner, recorded);
    }

    function isVerified(uint256 agentId) public view returns (bool) {
        Verification memory v = _verifications[agentId];
        if (v.paidAt == 0) return false;
        (bool ok, bytes memory ret) =
            address(identityRegistry).staticcall(abi.encodeCall(IIdentityRegistry.ownerOf, (agentId)));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (address)) == v.ownerAtPayment;
    }

    // ------------------------------------------------------------------ attestations

    function attest(uint256 agentId, Attestation calldata a) external {
        if (!isAttester[msg.sender]) revert NotAttester();
        if (!isVerified(agentId)) revert NotVerified();
        Verification memory v = _verifications[agentId];
        if (a.observedAt < v.paidAt || a.observedAt > block.timestamp) revert BadObservedAt();
        if (a.observedAt <= _attestations[agentId].observedAt) revert BadObservedAt();
        if (a.expiresAt <= block.timestamp || a.expiresAt > block.timestamp + MAX_ATTESTATION_TTL) revert BadExpiry();
        Attestation memory stored = a;
        stored.attester = msg.sender;
        _attestations[agentId] = stored;
        emit Attested(agentId, msg.sender, a.observedAt, a.expiresAt);
    }

    function clearAttestation(uint256 agentId) external {
        if (!isAttester[msg.sender] && msg.sender != owner) revert NotAttester();
        delete _attestations[agentId];
        emit AttestationCleared(agentId, msg.sender);
    }

    // ------------------------------------------------------------------ admin (capped, section 7)

    function setAttester(address who, bool enabled) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        if (isAttester[who] == enabled) return;
        if (enabled) {
            if (attesterCount >= MAX_ATTESTERS) revert TooManyKeys();
            attesterCount += 1;
        } else {
            attesterCount -= 1;
        }
        isAttester[who] = enabled;
        emit AttesterSet(who, enabled);
    }

    function setCheckSigner(address who, bool enabled) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        if (isCheckSigner[who] == enabled) return;
        if (enabled) {
            if (checkSignerCount >= MAX_CHECK_SIGNERS) revert TooManyKeys();
            checkSignerCount += 1;
        } else {
            checkSignerCount -= 1;
        }
        isCheckSigner[who] = enabled;
        emit CheckSignerSet(who, enabled);
    }

    function setFee(uint128 newFee) external onlyOwner {
        if (newFee > feeCap) revert FeeAboveCap();
        fee = newFee;
        emit FeeSet(newFee);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ views

    function getVerification(uint256 agentId) external view returns (Verification memory) {
        return _verifications[agentId];
    }

    function getAttestation(uint256 agentId) external view returns (Attestation memory) {
        return _attestations[agentId];
    }
}
