// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {IOrreryShield, IHonkVerifier} from "../interfaces/IShield.sol";
import {IFeeTiers} from "../../interfaces/IMarketPricing.sol";
import {LibPoseidon2Yul} from "./vendor/LibPoseidon2Yul.sol";

interface IShieldToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Shield V2: a private balance of one asset (`docs/updates/L3-R2-SPEC.md` 6, L3-15). Deposits become notes in a
/// Poseidon2 Merkle tree at once; sends and withdrawals are proven with the `transact` circuit, which checks the owner's
/// EIP-712 signature inside the proof, so a note moves only when its owner's wallet signed that exact action. Fees are
/// fixed at deployment and go to the treasury (lever L1), with the staker discount of the depositor and of the
/// withdrawal recipient (L2). One pool per asset (custody pattern C); no owner, no pause, no screener, no block list:
/// withdrawals cannot be stopped by anyone (the asset's own issuer controls still apply to its transfers).
/// @dev The note tree, the accounts registry, the public-input layout, the nullifier and intent checks and the
/// empty-output rule follow the `transact` circuit in `./circuit`. One ERC-20 asset, no native ETH, no deposit queue or screener (a deposit is inserted at once and
/// the note commitment is computed here from the net amount), no owner, no pause, no block list, fees immutable with the
/// staker discount, fees flushed to the treasury, the EIP-712 domain "Orrery Shield". The `transact` circuit (`./circuit`, MIT)
/// and its verifier (`./verifier/HonkVerifier.sol`, Apache-2.0, Aztec): the domain separator is a public input, so the
/// circuit needs no change for this pool.
contract OrreryShield is IOrreryShield {
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant DEPTH = 20;
    uint256 private constant MAX_LEAVES = 1 << DEPTH;
    uint8 private constant KIND_SEND = 1;
    uint8 private constant KIND_WITHDRAW = 2;
    uint256 private constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 100;
    uint256 private constant MAX_NOTE_BYTES = 1024;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant LOCK_SLOT = keccak256("orrery.OrreryShield.lock");

    struct Account {
        uint256 npk;
        bytes viewKey;
    }

    address public immutable verifier;
    address public immutable asset;
    address public immutable treasury;
    address public immutable feeTiers;
    uint16 public immutable depositFeeBps;
    uint16 public immutable withdrawFeeBps;
    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 private immutable _domainHi;
    uint256 private immutable _domainLo;

    mapping(address who => Account) private _accounts;
    uint256[DEPTH] private _zeros;
    uint256[DEPTH] private _filledSubtrees;
    uint256 public currentRoot;
    uint32 public nextLeafIndex;
    mapping(uint256 root => bool) public knownRoots;
    mapping(uint256 nullifier => bool) public nullifierSpent;
    mapping(uint256 intentNullifier => bool) public intentUsed;
    uint256 public accruedFees;

    constructor(
        address verifier_,
        address asset_,
        address treasury_,
        address feeTiers_,
        uint16 depositFeeBps_,
        uint16 withdrawFeeBps_
    ) {
        require(
            verifier_ != address(0) && asset_ != address(0) && treasury_ != address(0) && feeTiers_ != address(0),
            "zero address"
        );
        require(depositFeeBps_ <= MAX_FEE_BPS && withdrawFeeBps_ <= MAX_FEE_BPS, "fee");
        verifier = verifier_;
        asset = asset_;
        treasury = treasury_;
        feeTiers = feeTiers_;
        depositFeeBps = depositFeeBps_;
        withdrawFeeBps = withdrawFeeBps_;
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Orrery Shield"), keccak256("1"), block.chainid, address(this))
        );
        DOMAIN_SEPARATOR = domain;
        _domainHi = uint256(domain) >> 128;
        _domainLo = uint256(domain) & type(uint128).max;

        uint256 z;
        for (uint256 i; i < DEPTH; ++i) {
            _zeros[i] = z;
            _filledSubtrees[i] = z;
            z = LibPoseidon2Yul.hash_2(z, z);
        }
        currentRoot = z;
        knownRoots[z] = true;
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

    // ------------------------------------------------------------------ views

    function accountOf(address who) external view returns (uint256 npk, bytes memory viewKey) {
        Account storage a = _accounts[who];
        return (a.npk, a.viewKey);
    }

    function depositFee(address depositor, uint256 amount) public view returns (uint256) {
        return FullMath.mulDiv(amount, uint256(depositFeeBps) * (BPS - _discount(depositor)), BPS * BPS);
    }

    function withdrawFeeFloor(address to, uint256 amount) public view returns (uint256) {
        return FullMath.mulDiv(amount, uint256(withdrawFeeBps) * (BPS - _discount(to)), BPS * BPS);
    }

    function noteCommitment(uint256 amount, uint256 secretCommit) public view returns (uint256) {
        return LibPoseidon2Yul.hash_3(uint256(uint160(asset)), amount, secretCommit);
    }

    function extDataHash(ExtData calldata ext) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(ext.relayer, ext.encryptedOutput0, ext.encryptedOutput1))) % FIELD_SIZE;
    }

    // ------------------------------------------------------------------ accounts

    /// @notice Publishes the caller's note key and viewing key so others can send to them.
    function register(uint256 npk, bytes calldata viewKey) external {
        if (_accounts[msg.sender].npk != 0) revert AlreadyRegistered();
        if (npk == 0 || npk >= FIELD_SIZE) revert BadKey();
        if (viewKey.length != 33 || (viewKey[0] != 0x02 && viewKey[0] != 0x03)) revert BadKey();
        _accounts[msg.sender] = Account(npk, viewKey);
        emit AccountRegistered(msg.sender, npk, viewKey);
    }

    // ------------------------------------------------------------------ deposits

    function deposit(uint256 amount, uint256 secretCommit, bytes calldata encryptedNote)
        external
        nonReentrant
        returns (uint32 leafIndex)
    {
        if (amount == 0 || amount > type(uint128).max) revert BadAmount();
        if (secretCommit == 0 || secretCommit >= FIELD_SIZE) revert NotField();
        if (encryptedNote.length > MAX_NOTE_BYTES) revert NoteTooLarge();
        uint256 before = IShieldToken(asset).balanceOf(address(this));
        if (!_tryCall(abi.encodeCall(IShieldToken.transferFrom, (msg.sender, address(this), amount)))) {
            revert InexactTransfer();
        }
        if (IShieldToken(asset).balanceOf(address(this)) - before != amount) revert InexactTransfer();
        uint256 fee = depositFee(msg.sender, amount);
        uint256 commitment = noteCommitment(amount - fee, secretCommit);
        leafIndex = _insert(commitment);
        accruedFees += fee;
        emit Deposited(msg.sender, amount, fee, secretCommit, commitment, leafIndex, encryptedNote);
    }

    // ------------------------------------------------------------------ transact

    /// @notice Spends two notes and creates up to two, as proven. Anyone may submit; the relayer named in `ext` (or the
    /// caller) receives the relayer fee. An output committed as 0 is proven empty and is not inserted, so notes can
    /// still leave a full tree.
    function transact(TxArgs calldata args, ExtData calldata ext) external nonReentrant {
        if (args.asset != asset) revert WrongAsset();
        if (args.kind == KIND_SEND) {
            if (args.withdrawAmount != 0 || args.withdrawTo != address(0) || args.protocolFee != 0) {
                revert BadWithdraw();
            }
        } else if (args.kind == KIND_WITHDRAW) {
            if (args.withdrawTo == address(0) || args.withdrawAmount == 0) revert BadWithdraw();
            if (args.protocolFee < withdrawFeeFloor(args.withdrawTo, args.withdrawAmount)) revert FeeTooLow();
        } else {
            revert BadKind();
        }
        if (!knownRoots[args.root]) revert UnknownRoot();
        if (ext.encryptedOutput0.length > MAX_NOTE_BYTES || ext.encryptedOutput1.length > MAX_NOTE_BYTES) {
            revert NoteTooLarge();
        }
        for (uint256 i; i < 2; ++i) {
            if (nullifierSpent[args.nullifiers[i]]) revert NullifierSpent();
            if (args.outCommitments[i] >= FIELD_SIZE) revert NotField();
        }
        if (intentUsed[args.intentNullifier]) revert IntentUsed();

        // the generated verifier reverts on most malformed proofs; every rejection reads the same
        try IHonkVerifier(verifier).verify(args.proof, _publicInputs(args, extDataHash(ext))) returns (bool ok) {
            if (!ok) revert InvalidProof();
        } catch {
            revert InvalidProof();
        }

        for (uint256 i; i < 2; ++i) {
            nullifierSpent[args.nullifiers[i]] = true;
            emit NewNullifier(args.nullifiers[i]);
        }
        intentUsed[args.intentNullifier] = true;
        if (args.outCommitments[0] != 0) {
            emit NewCommitment(args.outCommitments[0], _insert(args.outCommitments[0]), ext.encryptedOutput0);
        }
        if (args.outCommitments[1] != 0) {
            emit NewCommitment(args.outCommitments[1], _insert(args.outCommitments[1]), ext.encryptedOutput1);
        }

        accruedFees += args.protocolFee;
        address relayer = ext.relayer == address(0) ? msg.sender : ext.relayer;
        if (args.withdrawAmount != 0) _pay(args.withdrawTo, args.withdrawAmount);
        if (args.fee != 0) _pay(relayer, args.fee);
        emit Transacted(args.kind, args.withdrawAmount, args.withdrawTo, args.fee, args.protocolFee, relayer);
    }

    function flushFees() external nonReentrant returns (uint256 amount) {
        amount = accruedFees;
        if (amount == 0) revert NothingToFlush();
        accruedFees = 0;
        _pay(treasury, amount);
        emit FeesFlushed(treasury, amount);
    }

    // ------------------------------------------------------------------ internals

    function _publicInputs(TxArgs calldata a, uint256 extHash) private view returns (bytes32[] memory p) {
        p = new bytes32[](15);
        p[0] = bytes32(a.root);
        p[1] = bytes32(a.nullifiers[0]);
        p[2] = bytes32(a.nullifiers[1]);
        p[3] = bytes32(a.outCommitments[0]);
        p[4] = bytes32(a.outCommitments[1]);
        p[5] = bytes32(uint256(uint160(a.asset)));
        p[6] = bytes32(uint256(a.kind));
        p[7] = bytes32(a.withdrawAmount);
        p[8] = bytes32(uint256(uint160(a.withdrawTo)));
        p[9] = bytes32(a.fee);
        p[10] = bytes32(a.protocolFee);
        p[11] = bytes32(a.intentNullifier);
        p[12] = bytes32(_domainHi);
        p[13] = bytes32(_domainLo);
        p[14] = bytes32(extHash);
    }

    function _insert(uint256 leaf) private returns (uint32 index) {
        index = nextLeafIndex;
        if (index >= MAX_LEAVES) revert TreeFull();
        uint256 node = leaf;
        uint256 at = index;
        for (uint256 level; level < DEPTH; ++level) {
            if (at & 1 == 0) {
                _filledSubtrees[level] = node;
                node = LibPoseidon2Yul.hash_2(node, _zeros[level]);
            } else {
                node = LibPoseidon2Yul.hash_2(_filledSubtrees[level], node);
            }
            at >>= 1;
        }
        currentRoot = node;
        knownRoots[node] = true;
        nextLeafIndex = index + 1;
    }

    function _discount(address account) private view returns (uint256) {
        try IFeeTiers(feeTiers).discountBps(account) returns (uint16 d) {
            return d > BPS ? BPS : d;
        } catch {
            return 0;
        }
    }

    function _pay(address to, uint256 amount) private {
        if (!_tryCall(abi.encodeCall(IShieldToken.transfer, (to, amount)))) revert InexactTransfer();
    }

    /// @dev An asset call that succeeded and returned true or nothing.
    function _tryCall(bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = asset.call(data);
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
