// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentityRegistry, IERC20Min, IERC7579AccountMin, IERC7579Module} from "./interfaces/IExternal.sol";

/// @title OrreryPolicyModule
/// @notice ERC-7579 executor module that gives an agent's hot wallet (the signer) capped, public spending authority
///         over an operator's smart account. Spec: 08-contract-spec.md revision 2. No admin, no pause, no upgrade.
contract OrreryPolicyModule is IERC7579Module {
    // ------------------------------------------------------------------ constants

    uint256 public constant MODULE_TYPE_EXECUTOR = 2;
    uint64 public constant MIN_INCREASE_DELAY = 1 hours;
    uint64 public constant MAX_INCREASE_DELAY = 30 days;
    uint256 public constant MAX_TOKENS = 8;
    uint256 public constant MAX_TARGETS = 32;
    uint256 public constant DAY = 1 days;
    address public constant NATIVE = address(0);

    /// @dev ERC-7579 mode for a single call that reverts on failure (callType 0x00, execType 0x00).
    bytes32 internal constant MODE_SINGLE = bytes32(0);

    // Selectors an allowlisted call may never use (R-H1, I13). Computed with `cast sig`.
    bytes4 internal constant SEL_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant SEL_INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 internal constant SEL_SET_APPROVAL_FOR_ALL = 0xa22cb465; // setApprovalForAll(address,bool)
    bytes4 internal constant SEL_PERMIT_2612 = 0xd505accf; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
    bytes4 internal constant SEL_P2_APPROVE = 0x87517c45; // approve(address,address,uint160,uint48)
    bytes4 internal constant SEL_P2_PERMIT_SINGLE = 0x2b67b570; // permit(address,PermitSingle,bytes)
    bytes4 internal constant SEL_P2_PERMIT_BATCH = 0x2a2d80d1; // permit(address,PermitBatch,bytes)
    bytes4 internal constant SEL_APPROVE_DELEGATION = 0xc04a8a10; // approveDelegation(address,uint256)
    bytes4 internal constant SEL_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant SEL_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 internal constant SEL_SAFE_TRANSFER_FROM_721 = 0x42842e0e; // safeTransferFrom(address,address,uint256)
    bytes4 internal constant SEL_SAFE_TRANSFER_FROM_721_DATA = 0xb88d4fde; // safeTransferFrom(address,address,uint256,bytes)
    bytes4 internal constant SEL_SAFE_TRANSFER_FROM_1155 = 0xf242432a; // safeTransferFrom(address,address,uint256,uint256,bytes)
    bytes4 internal constant SEL_SAFE_BATCH_TRANSFER_FROM_1155 = 0x2eb2c2d6; // safeBatchTransferFrom(...)
    // Deferred-pull grants (code review R-04): a right or an order registered now and used later outside the module.
    bytes4 internal constant SEL_SET_RELAYER_APPROVAL = 0xfa6e671d; // setRelayerApproval(address,address,bool)
    bytes4 internal constant SEL_SET_PRE_SIGNATURE = 0xec6cb13f; // setPreSignature(bytes,bool)
    bytes4 internal constant SEL_ALLOW = 0x110496e5; // allow(address,bool)
    bytes4 internal constant SEL_SET_AUTHORIZATION = 0xeecea000; // setAuthorization(address,bool)
    bytes4 internal constant SEL_SET_OPERATOR_6909 = 0x558a7297; // setOperator(address,bool)
    bytes4 internal constant SEL_APPROVE_6909 = 0x426a8493; // approve(address,uint256,uint256)
    bytes4 internal constant SEL_INCREASE_APPROVAL = 0xd73dd623; // increaseApproval(address,uint256)
    bytes4 internal constant SEL_PERMIT_DAI = 0x8fcbaf0c; // permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)
    bytes4 internal constant SEL_AUTHORIZE_OPERATOR = 0x959b8c3f; // authorizeOperator(address)
    bytes4 internal constant SEL_APPROVE_AND_CALL = 0xcae9ca51; // approveAndCall(address,uint256,bytes)
    bytes4 internal constant SEL_TRANSFER_AND_CALL = 0x4000aea0; // transferAndCall(address,uint256,bytes)
    bytes4 internal constant SEL_SET_ALLOWANCE = 0xbeaeb388; // setAllowance(address,address,uint96,uint16,uint32)

    // Signer consent (code review R-02): the signer signs EIP-712 SessionConsent before it can be bound.
    bytes32 public constant SESSION_CONSENT_TYPEHASH =
        keccak256("SessionConsent(address account,uint256 agentId,bytes32 policyHash)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // ------------------------------------------------------------------ types

    struct TokenCap {
        address token;
        uint128 perTx;
        uint128 perDay;
        uint128 floatMax;
    }

    struct Target {
        address target;
        bytes4 selector;
    }

    struct Policy {
        TokenCap[] caps;
        Target[] targets;
        uint64 validUntil;
        uint32 increaseDelay;
    }

    enum Status {
        None,
        Active,
        Paused,
        Revoked
    }

    struct Session {
        address signer;
        Status status;
        uint64 epoch;
        uint64 createdAt;
        uint64 policyChangedAt;
        bytes32 policyHash;
    }

    struct Pending {
        bytes32 policyHash;
        uint64 readyAt;
    }

    struct SignerRef {
        address account;
        uint256 agentId;
    }

    // ------------------------------------------------------------------ immutables

    IIdentityRegistry public immutable identityRegistry;
    address public immutable attestor;
    address public immutable permit2;
    address public immutable entryPoint07;
    address public immutable entryPoint08;
    address public immutable safe7579Adapter;

    // ------------------------------------------------------------------ storage

    mapping(address account => mapping(uint256 agentId => Session)) internal _sessions;
    mapping(address account => mapping(uint256 agentId => Policy)) internal _policies;
    mapping(address account => mapping(uint256 agentId => Policy)) internal _pendingPolicies;
    mapping(address account => mapping(uint256 agentId => Pending)) internal _pending;
    mapping(address account => mapping(uint256 agentId => mapping(address token => mapping(uint256 day => uint256))))
        internal _spent;
    mapping(address signer => SignerRef) internal _signerOf;
    mapping(address account => uint64) public epoch;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events

    event ModuleInstalled(address indexed account, uint64 epoch);
    event AllSessionsRevoked(address indexed account, uint64 oldEpoch);
    event SessionOpened(address indexed account, uint256 indexed agentId, address indexed signer, uint64 epoch);
    event PolicySet(address indexed account, uint256 indexed agentId, bool isPending, Policy policy, bytes32 hash);
    event PolicyDecreased(address indexed account, uint256 indexed agentId, bytes32 hash);
    event IncreaseProposed(address indexed account, uint256 indexed agentId, bytes32 hash, uint64 readyAt);
    event PolicyIncreased(address indexed account, uint256 indexed agentId, bytes32 hash);
    event IncreaseCancelled(address indexed account, uint256 indexed agentId);
    event SessionPaused(address indexed account, uint256 indexed agentId);
    event SessionUnpaused(address indexed account, uint256 indexed agentId);
    event SessionRevoked(address indexed account, uint256 indexed agentId);
    event ToppedUp(
        address indexed account, uint256 indexed agentId, address indexed token, uint256 amount, uint256 day, uint256 spentToday
    );
    event Spent(
        address indexed account, uint256 indexed agentId, address indexed token, uint256 amount, uint256 day, uint256 spentToday
    );
    event Executed(address indexed account, uint256 indexed agentId, address indexed target, bytes4 selector);

    // ------------------------------------------------------------------ errors

    error Reentrancy();
    error NotInstalled();
    error NotBound();
    error SessionExists();
    error SignerUsed();
    error InvalidSigner();
    error UnknownSigner();
    error NoSession();
    error NotActive();
    error Expired();
    error NotPaused();
    error AlreadyRevoked();
    error NotDecrease();
    error UseDecrease();
    error TokenDropped();
    error NoPending();
    error IncreaseNotReady();
    error BadCapCount();
    error DuplicateToken();
    error BadCaps();
    error BadTargetCount();
    error DuplicateTarget();
    error ForbiddenTarget(address target);
    error ForbiddenSelector(bytes4 selector);
    error BadValidUntil();
    error BadIncreaseDelay();
    error TokenNotAllowed();
    error ZeroAmount();
    error PerTxExceeded();
    error DailyCapExceeded();
    error FloatExceeded();
    error InexactTransfer();
    error ShortCalldata();
    error TargetNotAllowed();
    error NativeOutflow();
    error InvalidSignerConsent();

    // ------------------------------------------------------------------ construction

    constructor(
        IIdentityRegistry identityRegistry_,
        address attestor_,
        address permit2_,
        address entryPoint07_,
        address entryPoint08_,
        address safe7579Adapter_
    ) {
        identityRegistry = identityRegistry_;
        attestor = attestor_;
        permit2 = permit2_;
        entryPoint07 = entryPoint07_;
        entryPoint08 = entryPoint08_;
        safe7579Adapter = safe7579Adapter_;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------ 5.1 module lifecycle

    /// @notice Never reverts. Bumps the epoch so any session from before this install stays revoked.
    function onInstall(bytes calldata) external override {
        uint64 e = epoch[msg.sender] + 1;
        epoch[msg.sender] = e;
        emit ModuleInstalled(msg.sender, e);
    }

    /// @notice Never reverts. O(1): every existing session of the caller becomes effectively revoked.
    function onUninstall(bytes calldata) external override {
        uint64 old = epoch[msg.sender];
        epoch[msg.sender] = old + 1;
        emit AllSessionsRevoked(msg.sender, old);
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    /// @notice Informational only (odd after an install, even after an uninstall). Authority uses the live
    ///         `isModuleInstalled` answer of the account instead.
    function isInitialized(address smartAccount) external view override returns (bool) {
        return epoch[smartAccount] % 2 == 1;
    }

    // ------------------------------------------------------------------ 5.2 operator (caller = account)

    /// @param signerConsent 65-byte signature by `signer` over `consentDigest(account, agentId, keccak256(abi.encode(p)))`.
    function openSession(uint256 agentId, address signer, Policy calldata p, bytes calldata signerConsent)
        external
        nonReentrant
    {
        address account = msg.sender;
        _requireInstalled(account);
        if (identityRegistry.getAgentWallet(agentId) != account) revert NotBound();
        Session storage s = _sessions[account][agentId];
        if (s.status != Status.None && _effective(account, s) != Status.Revoked) revert SessionExists();
        if (signer == address(0) || signer == account || signer.code.length != 0) revert InvalidSigner();
        if (_signerOf[signer].account != address(0)) revert SignerUsed();
        _validate(account, p);
        bytes32 h = keccak256(abi.encode(p));
        if (_recover(consentDigest(account, agentId, h), signerConsent) != signer) revert InvalidSignerConsent();

        uint64 nowTs = uint64(block.timestamp);
        s.signer = signer;
        s.status = Status.Active;
        s.epoch = epoch[account];
        s.createdAt = nowTs;
        s.policyChangedAt = nowTs;
        _store(_policies[account][agentId], p);
        s.policyHash = h;
        _clearPending(account, agentId);
        _signerOf[signer] = SignerRef(account, agentId);

        emit SessionOpened(account, agentId, signer, s.epoch);
        emit PolicySet(account, agentId, false, p, h);
    }

    function decreasePolicy(uint256 agentId, Policy calldata p) external nonReentrant {
        address account = msg.sender;
        _requireInstalled(account);
        Session storage s = _sessions[account][agentId];
        Status st = _effective(account, s);
        if (st != Status.Active && st != Status.Paused) revert NotActive();
        _validate(account, p);
        Policy storage cur = _policies[account][agentId];
        if (!_isDecrease(cur, p)) revert NotDecrease();

        _store(cur, p);
        bytes32 h = keccak256(abi.encode(p));
        s.policyHash = h;
        s.policyChangedAt = uint64(block.timestamp);
        _clearPending(account, agentId);

        emit PolicyDecreased(account, agentId, h);
        emit PolicySet(account, agentId, false, p, h);
    }

    function proposeIncrease(uint256 agentId, Policy calldata p) external nonReentrant {
        address account = msg.sender;
        _requireInstalled(account);
        Session storage s = _sessions[account][agentId];
        Status st = _effective(account, s);
        if (st == Status.None) revert NoSession();
        if (st == Status.Revoked) revert AlreadyRevoked();
        _validate(account, p);
        Policy storage cur = _policies[account][agentId];
        _requireKeepsTokens(cur, p);
        if (_isDecrease(cur, p)) revert UseDecrease();

        uint64 curDelay = uint64(cur.increaseDelay);
        uint64 delay = curDelay < MIN_INCREASE_DELAY ? MIN_INCREASE_DELAY : curDelay;
        uint64 readyAt = uint64(block.timestamp) + delay;
        _store(_pendingPolicies[account][agentId], p);
        bytes32 h = keccak256(abi.encode(p));
        _pending[account][agentId] = Pending(h, readyAt);

        emit IncreaseProposed(account, agentId, h, readyAt);
        emit PolicySet(account, agentId, true, p, h);
    }

    function applyIncrease(uint256 agentId) external nonReentrant {
        address account = msg.sender;
        _requireInstalled(account);
        Pending memory pend = _pending[account][agentId];
        if (pend.readyAt == 0) revert NoPending();
        if (block.timestamp < pend.readyAt) revert IncreaseNotReady();
        Session storage s = _sessions[account][agentId];
        Status st = _effective(account, s);
        if (st == Status.None) revert NoSession();
        if (st == Status.Revoked) revert AlreadyRevoked();
        Policy memory p = _load(_pendingPolicies[account][agentId]);
        _validate(account, p);

        _storeMem(_policies[account][agentId], p);
        s.policyHash = pend.policyHash;
        s.policyChangedAt = uint64(block.timestamp);
        _clearPending(account, agentId);

        emit PolicyIncreased(account, agentId, pend.policyHash);
        emit PolicySet(account, agentId, false, p, pend.policyHash);
    }

    function cancelIncrease(uint256 agentId) external nonReentrant {
        if (_pending[msg.sender][agentId].readyAt == 0) revert NoPending();
        _clearPending(msg.sender, agentId);
        emit IncreaseCancelled(msg.sender, agentId);
    }

    function pause(uint256 agentId) external nonReentrant {
        address account = msg.sender;
        _requireInstalled(account);
        Session storage s = _sessions[account][agentId];
        if (_effective(account, s) != Status.Active) revert NotActive();
        s.status = Status.Paused;
        emit SessionPaused(account, agentId);
    }

    function unpause(uint256 agentId) external nonReentrant {
        address account = msg.sender;
        _requireInstalled(account);
        Session storage s = _sessions[account][agentId];
        if (_effective(account, s) != Status.Paused) revert NotPaused();
        s.status = Status.Active;
        emit SessionUnpaused(account, agentId);
    }

    /// @notice Works even when the module is no longer installed.
    function revoke(uint256 agentId) external nonReentrant {
        address account = msg.sender;
        Session storage s = _sessions[account][agentId];
        Status st = _effective(account, s);
        if (st == Status.None) revert NoSession();
        if (st == Status.Revoked) revert AlreadyRevoked();
        s.status = Status.Revoked;
        _clearPending(account, agentId);
        emit SessionRevoked(account, agentId);
    }

    // ------------------------------------------------------------------ 5.3 agent (caller = signer)

    function topUp(address token, uint256 amount) external nonReentrant {
        (address account, uint256 agentId, Policy storage pol) = _agentContext();
        uint256 i = _capIndex(pol, token);
        TokenCap memory cap = pol.caps[i];
        if (amount == 0) revert ZeroAmount();
        if (amount > cap.perTx) revert PerTxExceeded();
        uint256 day = block.timestamp / DAY;
        uint256 newSpent = _spent[account][agentId][token][day] + amount;
        if (newSpent > cap.perDay) revert DailyCapExceeded();
        uint256 before = _balanceOf(token, msg.sender);
        if (before + amount > cap.floatMax) revert FloatExceeded();
        uint256 accountBefore = _balanceOf(token, account);

        _spent[account][agentId][token][day] = newSpent;
        if (token == NATIVE) {
            _exec(account, msg.sender, amount, "");
        } else {
            _exec(account, token, 0, abi.encodeCall(IERC20Min.transfer, (msg.sender, amount)));
        }
        if (_balanceOf(token, msg.sender) != before + amount || _balanceOf(token, account) + amount != accountBefore) {
            revert InexactTransfer();
        }

        emit ToppedUp(account, agentId, token, amount, day, newSpent);
    }

    function execute(address target, bytes calldata data) external nonReentrant {
        (address account, uint256 agentId, Policy storage pol) = _agentContext();
        if (data.length < 4) revert ShortCalldata();
        bytes4 sel = bytes4(data[:4]);
        if (!_hasTarget(pol, target, sel)) revert TargetNotAllowed();
        _checkTarget(account, pol.caps, target, sel);

        uint256 n = pol.caps.length;
        uint256[] memory before = new uint256[](n);
        bool nativeCapped;
        for (uint256 i; i < n; ++i) {
            address t = pol.caps[i].token;
            if (t == NATIVE) nativeCapped = true;
            before[i] = _balanceOf(t, account);
        }
        uint256 nativeBefore = account.balance;

        _exec(account, target, 0, data);

        uint256 day = block.timestamp / DAY;
        for (uint256 i; i < n; ++i) {
            TokenCap memory cap = pol.caps[i];
            uint256 afterBal = _balanceOf(cap.token, account);
            if (afterBal >= before[i]) continue;
            uint256 d = before[i] - afterBal;
            if (d > cap.perTx) revert PerTxExceeded();
            uint256 newSpent = _spent[account][agentId][cap.token][day] + d;
            if (newSpent > cap.perDay) revert DailyCapExceeded();
            _spent[account][agentId][cap.token][day] = newSpent;
            emit Spent(account, agentId, cap.token, d, day, newSpent);
        }
        if (!nativeCapped && account.balance < nativeBefore) revert NativeOutflow();

        emit Executed(account, agentId, target, sel);
    }

    // ------------------------------------------------------------------ views

    function getSession(address account, uint256 agentId) external view returns (Session memory) {
        return _sessions[account][agentId];
    }

    function effectiveStatus(address account, uint256 agentId) external view returns (Status) {
        return _effective(account, _sessions[account][agentId]);
    }

    function getPolicy(address account, uint256 agentId) external view returns (Policy memory) {
        return _load(_policies[account][agentId]);
    }

    function getPending(address account, uint256 agentId) external view returns (Pending memory, Policy memory) {
        return (_pending[account][agentId], _load(_pendingPolicies[account][agentId]));
    }

    function signerOf(address signer) external view returns (address account, uint256 agentId) {
        SignerRef memory r = _signerOf[signer];
        return (r.account, r.agentId);
    }

    function spentOn(address account, uint256 agentId, address token, uint256 day) external view returns (uint256) {
        return _spent[account][agentId][token][day];
    }

    function spentToday(address account, uint256 agentId, address token) external view returns (uint256) {
        return _spent[account][agentId][token][block.timestamp / DAY];
    }

    function isInstalledOn(address account) external view returns (bool) {
        return _installed(account);
    }

    /// @notice True when `selector` may never be allowlisted.
    function isForbiddenSelector(bytes4 selector) public pure returns (bool) {
        return selector == SEL_APPROVE || selector == SEL_INCREASE_ALLOWANCE || selector == SEL_SET_APPROVAL_FOR_ALL
            || selector == SEL_PERMIT_2612 || selector == SEL_P2_APPROVE || selector == SEL_P2_PERMIT_SINGLE
            || selector == SEL_P2_PERMIT_BATCH || selector == SEL_APPROVE_DELEGATION || selector == SEL_TRANSFER
            || selector == SEL_TRANSFER_FROM || selector == SEL_SAFE_TRANSFER_FROM_721
            || selector == SEL_SAFE_TRANSFER_FROM_721_DATA || selector == SEL_SAFE_TRANSFER_FROM_1155
            || selector == SEL_SAFE_BATCH_TRANSFER_FROM_1155 || selector == SEL_SET_RELAYER_APPROVAL
            || selector == SEL_SET_PRE_SIGNATURE || selector == SEL_ALLOW || selector == SEL_SET_AUTHORIZATION
            || selector == SEL_SET_OPERATOR_6909 || selector == SEL_APPROVE_6909 || selector == SEL_INCREASE_APPROVAL
            || selector == SEL_PERMIT_DAI || selector == SEL_AUTHORIZE_OPERATOR || selector == SEL_APPROVE_AND_CALL
            || selector == SEL_TRANSFER_AND_CALL || selector == SEL_SET_ALLOWANCE;
    }

    /// @notice EIP-712 digest the signer signs to consent to a session (R-02).
    function consentDigest(address account, uint256 agentId, bytes32 policyHash) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("Orrery Policy Module"), keccak256("1"), block.chainid, address(this)
            )
        );
        bytes32 structHash = keccak256(abi.encode(SESSION_CONSENT_TYPEHASH, account, agentId, policyHash));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 sv = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(sv) > HALF_N || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, sv);
    }

    // ------------------------------------------------------------------ internals: agent

    function _agentContext() internal view returns (address account, uint256 agentId, Policy storage pol) {
        SignerRef memory r = _signerOf[msg.sender];
        if (r.account == address(0)) revert UnknownSigner();
        account = r.account;
        agentId = r.agentId;
        _requireInstalled(account);
        Session storage s = _sessions[account][agentId];
        if (s.signer != msg.sender || _effective(account, s) != Status.Active) revert NotActive();
        pol = _policies[account][agentId];
        if (block.timestamp > pol.validUntil) revert Expired();
    }

    function _capIndex(Policy storage pol, address token) internal view returns (uint256) {
        uint256 n = pol.caps.length;
        for (uint256 i; i < n; ++i) {
            if (pol.caps[i].token == token) return i;
        }
        revert TokenNotAllowed();
    }

    function _hasTarget(Policy storage pol, address target, bytes4 sel) internal view returns (bool) {
        uint256 n = pol.targets.length;
        for (uint256 i; i < n; ++i) {
            if (pol.targets[i].target == target && pol.targets[i].selector == sel) return true;
        }
        return false;
    }

    function _exec(address account, address target, uint256 value, bytes memory data) internal {
        IERC7579AccountMin(account).executeFromExecutor(MODE_SINGLE, abi.encodePacked(target, value, data));
    }

    function _balanceOf(address token, address who) internal view returns (uint256) {
        if (token == NATIVE) return who.balance;
        return IERC20Min(token).balanceOf(who);
    }

    // ------------------------------------------------------------------ internals: status

    function _effective(address account, Session storage s) internal view returns (Status) {
        if (s.status == Status.None) return Status.None;
        if (s.epoch != epoch[account]) return Status.Revoked;
        return s.status;
    }

    function _installed(address account) internal view returns (bool) {
        return _isModuleInstalled(account, MODULE_TYPE_EXECUTOR, address(this));
    }

    function _requireInstalled(address account) internal view {
        if (!_installed(account)) revert NotInstalled();
    }

    /// @dev Low-level so an account without code, or one that reverts, reads as "not installed".
    function _isModuleInstalled(address account, uint256 typeId, address module) internal view returns (bool) {
        if (account.code.length == 0) return false;
        (bool ok, bytes memory ret) = account.staticcall(
            abi.encodeCall(IERC7579AccountMin.isModuleInstalled, (typeId, module, bytes("")))
        );
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }

    /// @dev Safe-level modules (`isModuleEnabled`) of the account, read low-level so non-Safe accounts answer false.
    function _isSafeModule(address account, address target) internal view returns (bool) {
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeWithSelector(0x2d9ad53d, target));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }

    function _clearPending(address account, uint256 agentId) internal {
        if (_pending[account][agentId].readyAt != 0) {
            delete _pending[account][agentId];
            Policy storage pp = _pendingPolicies[account][agentId];
            delete pp.caps;
            delete pp.targets;
            pp.validUntil = 0;
            pp.increaseDelay = 0;
        }
    }

    // ------------------------------------------------------------------ internals: policy

    function _validate(address account, Policy memory p) internal view {
        uint256 nc = p.caps.length;
        if (nc == 0 || nc > MAX_TOKENS) revert BadCapCount();
        for (uint256 i; i < nc; ++i) {
            TokenCap memory c = p.caps[i];
            if (c.perTx > c.perDay || c.floatMax > c.perDay) revert BadCaps();
            for (uint256 j = i + 1; j < nc; ++j) {
                if (p.caps[j].token == c.token) revert DuplicateToken();
            }
        }
        uint256 nt = p.targets.length;
        if (nt > MAX_TARGETS) revert BadTargetCount();
        for (uint256 i; i < nt; ++i) {
            Target memory t = p.targets[i];
            for (uint256 j = i + 1; j < nt; ++j) {
                if (p.targets[j].target == t.target && p.targets[j].selector == t.selector) revert DuplicateTarget();
            }
            _checkTarget(account, p.caps, t.target, t.selector);
        }
        if (p.validUntil <= block.timestamp) revert BadValidUntil();
        if (p.increaseDelay < MIN_INCREASE_DELAY || p.increaseDelay > MAX_INCREASE_DELAY) revert BadIncreaseDelay();
    }

    function _checkTarget(address account, TokenCap[] memory caps, address target, bytes4 sel) internal view {
        if (isForbiddenSelector(sel)) revert ForbiddenSelector(sel);
        if (
            target == address(0) || target == address(this) || target == account || target == address(identityRegistry)
                || target == attestor || target == permit2 || target == entryPoint07 || target == entryPoint08
                || target == safe7579Adapter
        ) revert ForbiddenTarget(target);
        uint256 n = caps.length;
        for (uint256 i; i < n; ++i) {
            if (caps[i].token == target) revert ForbiddenTarget(target);
        }
        for (uint256 typeId = 1; typeId <= 4; ++typeId) {
            if (_isModuleInstalled(account, typeId, target)) revert ForbiddenTarget(target);
        }
        if (_isSafeModule(account, target)) revert ForbiddenTarget(target);
    }

    /// @dev Same token list, every cap <=, targets a subset, validUntil not later, increaseDelay not shorter.
    function _isDecrease(Policy storage cur, Policy memory p) internal view returns (bool) {
        uint256 nc = cur.caps.length;
        if (p.caps.length != nc) return false;
        for (uint256 i; i < nc; ++i) {
            TokenCap memory c = cur.caps[i];
            bool found = false;
            for (uint256 j; j < nc; ++j) {
                TokenCap memory q = p.caps[j];
                if (q.token == c.token) {
                    if (q.perTx > c.perTx || q.perDay > c.perDay || q.floatMax > c.floatMax) return false;
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        uint256 nt = p.targets.length;
        for (uint256 i; i < nt; ++i) {
            if (!_hasTarget(cur, p.targets[i].target, p.targets[i].selector)) return false;
        }
        if (p.validUntil > cur.validUntil) return false;
        if (p.increaseDelay < cur.increaseDelay) return false;
        return true;
    }

    function _requireKeepsTokens(Policy storage cur, Policy memory p) internal view {
        uint256 nc = cur.caps.length;
        for (uint256 i; i < nc; ++i) {
            address t = cur.caps[i].token;
            bool found = false;
            for (uint256 j; j < p.caps.length; ++j) {
                if (p.caps[j].token == t) {
                    found = true;
                    break;
                }
            }
            if (!found) revert TokenDropped();
        }
    }

    function _store(Policy storage dst, Policy calldata p) internal {
        delete dst.caps;
        delete dst.targets;
        for (uint256 i; i < p.caps.length; ++i) {
            dst.caps.push(p.caps[i]);
        }
        for (uint256 i; i < p.targets.length; ++i) {
            dst.targets.push(p.targets[i]);
        }
        dst.validUntil = p.validUntil;
        dst.increaseDelay = p.increaseDelay;
    }

    function _storeMem(Policy storage dst, Policy memory p) internal {
        delete dst.caps;
        delete dst.targets;
        for (uint256 i; i < p.caps.length; ++i) {
            dst.caps.push(p.caps[i]);
        }
        for (uint256 i; i < p.targets.length; ++i) {
            dst.targets.push(p.targets[i]);
        }
        dst.validUntil = p.validUntil;
        dst.increaseDelay = p.increaseDelay;
    }

    function _load(Policy storage src) internal view returns (Policy memory p) {
        uint256 nc = src.caps.length;
        p.caps = new TokenCap[](nc);
        for (uint256 i; i < nc; ++i) {
            p.caps[i] = src.caps[i];
        }
        uint256 nt = src.targets.length;
        p.targets = new Target[](nt);
        for (uint256 i; i < nt; ++i) {
            p.targets[i] = src.targets[i];
        }
        p.validUntil = src.validUntil;
        p.increaseDelay = src.increaseDelay;
    }
}
