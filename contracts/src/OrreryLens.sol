// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentityRegistry, ISafeMin} from "./interfaces/IExternal.sol";
import {OrreryPolicyModule} from "./OrreryPolicyModule.sol";
import {OrreryAttestor} from "./OrreryAttestor.sol";

/// @title OrreryLens
/// @notice Stateless read view that assembles everything a counterparty needs about one signer's session.
///         Spec: 08-contract-spec.md section 9. Known Safe implementations are fixed at construction.
contract OrreryLens {
    enum AccountKind {
        Unknown,
        Safe7579
    }

    enum EffectiveStatus {
        None,
        Active,
        Paused,
        Revoked,
        Expired
    }

    struct TokenView {
        address token;
        uint128 perTx;
        uint128 perDay;
        uint128 floatMax;
        uint256 spentToday;
    }

    struct CheckView {
        address signer;
        address account;
        uint256 agentId;
        uint64 sessionEpoch;
        uint64 sessionCreatedAt;
        address owner;
        bool bound;
        bool installed;
        EffectiveStatus status;
        AccountKind accountKind;
        bool signerIsAccountOwner;
        bool otherAccountModules;
        bool signerHasCode;
        bytes32 policyHash;
        TokenView[] caps;
        OrreryPolicyModule.Target[] targets;
        uint64 policyValidUntil;
        uint32 increaseDelay;
        bytes32 pendingHash;
        uint64 pendingReadyAt;
        uint64 validFor;
        bool verified;
        uint64 paidAt;
        OrreryAttestor.Attestation attestation;
    }

    address internal constant SAFE_SENTINEL = address(0x1);
    /// @dev Safe 1.3/1.4 storage slot of the fallback handler: keccak256("fallback_manager.handler.address").
    uint256 internal constant SAFE_FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    OrreryPolicyModule public immutable module;
    OrreryAttestor public immutable attestor;
    IIdentityRegistry public immutable identityRegistry;
    address public immutable safe7579Adapter;

    mapping(bytes32 => bool) public isKnownSafeProxyCodehash;
    mapping(address => bool) public isKnownSafeSingleton;

    constructor(
        OrreryPolicyModule module_,
        OrreryAttestor attestor_,
        address safe7579Adapter_,
        bytes32[] memory safeProxyCodehashes,
        address[] memory safeSingletons
    ) {
        module = module_;
        attestor = attestor_;
        identityRegistry = module_.identityRegistry();
        safe7579Adapter = safe7579Adapter_;
        for (uint256 i; i < safeProxyCodehashes.length; ++i) {
            isKnownSafeProxyCodehash[safeProxyCodehashes[i]] = true;
        }
        for (uint256 i; i < safeSingletons.length; ++i) {
            isKnownSafeSingleton[safeSingletons[i]] = true;
        }
    }

    function checkBySigner(address signer) external view returns (CheckView memory v) {
        (address account, uint256 agentId) = module.signerOf(signer);
        v.signer = signer;
        if (account == address(0)) return v;
        // The agentId may have a newer session with a different signer: this signer is then revoked, and the newer
        // session's data must not be shown as this signer's (code review, info).
        if (module.getSession(account, agentId).signer != signer) {
            v.account = account;
            v.agentId = agentId;
            v.status = EffectiveStatus.Revoked;
            v.validFor = uint64(block.timestamp);
            return v;
        }
        _fill(v, account, agentId);
    }

    function checkByAgent(uint256 agentId, address account) external view returns (CheckView memory v) {
        v.signer = module.getSession(account, agentId).signer;
        _fill(v, account, agentId);
    }

    function _fill(CheckView memory v, address account, uint256 agentId) internal view {
        v.account = account;
        v.agentId = agentId;
        OrreryPolicyModule.Session memory s = module.getSession(account, agentId);
        v.sessionEpoch = s.epoch;
        v.sessionCreatedAt = s.createdAt;
        v.owner = _ownerOf(agentId);
        v.bound = _agentWallet(agentId) == account && account != address(0);
        v.installed = module.isInstalledOn(account);

        OrreryPolicyModule.Policy memory p = module.getPolicy(account, agentId);
        OrreryPolicyModule.Status st = module.effectiveStatus(account, agentId);
        if ((st == OrreryPolicyModule.Status.Active || st == OrreryPolicyModule.Status.Paused) && block.timestamp > p.validUntil)
        {
            v.status = EffectiveStatus.Expired;
        } else {
            v.status = EffectiveStatus(uint8(st));
        }
        v.signerHasCode = s.signer.code.length != 0;

        (v.accountKind, v.signerIsAccountOwner, v.otherAccountModules) = _accountKind(account, s.signer);

        v.policyHash = s.policyHash;
        v.caps = new TokenView[](p.caps.length);
        for (uint256 i; i < p.caps.length; ++i) {
            OrreryPolicyModule.TokenCap memory c = p.caps[i];
            v.caps[i] = TokenView(c.token, c.perTx, c.perDay, c.floatMax, module.spentToday(account, agentId, c.token));
        }
        v.targets = p.targets;
        v.policyValidUntil = p.validUntil;
        v.increaseDelay = p.increaseDelay;

        (OrreryPolicyModule.Pending memory pend,) = module.getPending(account, agentId);
        v.pendingHash = pend.policyHash;
        v.pendingReadyAt = pend.readyAt;
        uint64 nowTs = uint64(block.timestamp);
        if (pend.readyAt != 0) {
            v.validFor = pend.readyAt <= nowTs ? nowTs : pend.readyAt;
        } else {
            uint64 d = p.increaseDelay < module.MIN_INCREASE_DELAY() ? module.MIN_INCREASE_DELAY() : uint64(p.increaseDelay);
            v.validFor = nowTs + d;
        }

        // The window only covers the module's own delays. Anything that can change authority at once (unpause,
        // reinstall, owner-level grants) leaves no window (code review R-05).
        if (
            v.status != EffectiveStatus.Active || !v.installed || v.accountKind == AccountKind.Unknown
                || v.otherAccountModules || v.signerIsAccountOwner || v.signerHasCode
        ) v.validFor = nowTs;

        v.verified = attestor.isVerified(agentId);
        if (v.verified) {
            v.paidAt = attestor.getVerification(agentId).paidAt;
            OrreryAttestor.Attestation memory a = attestor.getAttestation(agentId);
            // Only a current attestation made for this payment by a still-active attester (code review R-03).
            if (a.observedAt >= v.paidAt && a.expiresAt > block.timestamp && attestor.isAttester(a.attester)) {
                v.attestation = a;
            }
        }
    }

    /// @dev A Safe counts only when its proxy code is a known Safe proxy, its singleton is a known Safe singleton and
    ///      the Safe7579 adapter is an enabled module. Any other enabled Safe module is reported.
    function _accountKind(address account, address signer)
        internal
        view
        returns (AccountKind kind, bool signerIsOwner, bool otherModules)
    {
        if (account.code.length == 0 || !isKnownSafeProxyCodehash[account.codehash]) return (AccountKind.Unknown, false, false);
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeCall(ISafeMin.getStorageAt, (0, 1)));
        if (!ok) return (AccountKind.Unknown, false, false);
        bytes memory slot0 = abi.decode(ret, (bytes));
        if (slot0.length != 32) return (AccountKind.Unknown, false, false);
        address singleton = address(uint160(uint256(bytes32(slot0))));
        if (!isKnownSafeSingleton[singleton]) return (AccountKind.Unknown, false, false);
        if (!ISafeMin(account).isModuleEnabled(safe7579Adapter)) return (AccountKind.Unknown, false, false);
        // The adapter must also be the fallback handler, or the 7579 answers come from another contract (R-08).
        (ok, ret) = account.staticcall(abi.encodeCall(ISafeMin.getStorageAt, (SAFE_FALLBACK_SLOT, 1)));
        if (!ok) return (AccountKind.Unknown, false, false);
        bytes memory fb = abi.decode(ret, (bytes));
        if (fb.length != 32 || address(uint160(uint256(bytes32(fb)))) != safe7579Adapter) {
            return (AccountKind.Unknown, false, false);
        }
        signerIsOwner = signer != address(0) && ISafeMin(account).isOwner(signer);
        // A module entry for the signer that is not linked into the list still passes Safe's module check (R-01).
        if (signer != address(0) && ISafeMin(account).isModuleEnabled(signer)) otherModules = true;
        (address[] memory mods,) = ISafeMin(account).getModulesPaginated(SAFE_SENTINEL, 10);
        for (uint256 i; i < mods.length; ++i) {
            if (mods[i] != safe7579Adapter) otherModules = true;
        }
        // ERC-7579 modules on the adapter: any other executor, or any validator, can give some key authority over
        // the account that this module does not limit. Read through the Safe so the adapter sees the Safe as caller.
        if (_listHasOther(account, "getExecutorsPaginated(address,uint256)", address(module))) otherModules = true;
        if (_listHasOther(account, "getValidatorsPaginated(address,uint256)", address(0))) otherModules = true;
        kind = AccountKind.Safe7579;
    }

    /// @dev True when the paginated list holds an entry other than `allowed`, or cannot be read.
    function _listHasOther(address account, string memory sig, address allowed) internal view returns (bool) {
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeWithSignature(sig, SAFE_SENTINEL, uint256(10)));
        if (!ok || ret.length < 64) return true;
        (address[] memory list,) = abi.decode(ret, (address[], address));
        for (uint256 i; i < list.length; ++i) {
            if (list[i] != allowed) return true;
        }
        return false;
    }

    function _ownerOf(uint256 agentId) internal view returns (address) {
        (bool ok, bytes memory ret) =
            address(identityRegistry).staticcall(abi.encodeCall(IIdentityRegistry.ownerOf, (agentId)));
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }

    function _agentWallet(uint256 agentId) internal view returns (address) {
        (bool ok, bytes memory ret) =
            address(identityRegistry).staticcall(abi.encodeCall(IIdentityRegistry.getAgentWallet, (agentId)));
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }
}
