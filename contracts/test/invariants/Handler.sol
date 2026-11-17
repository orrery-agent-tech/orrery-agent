// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {MockIdentityRegistry, MockERC20, MockAccount7579, MockTarget} from "../mocks/Mocks.sol";

/// @notice Bounded random actions against one account with three agents. Ghost state records what the module
///         cannot report itself; flags record any illegal observation. Ids refer to 09-invariants.md.
contract Handler is Test {
    OrreryPolicyModule public module;
    MockIdentityRegistry public registry;
    MockERC20 public usdg;
    MockERC20 public weth;
    MockAccount7579 public account;
    MockTarget public target;
    address public operator;
    address public merchant = address(0xBEEF);

    uint256[3] public agents;
    uint256 public clock;
    uint256 internal signerNonce;
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ghosts
    mapping(uint256 agentId => mapping(address token => mapping(uint256 day => uint256))) public ghostOut;
    mapping(address => bool) public everSigner;
    mapping(address => uint256) internal keyOf;
    mapping(address signer => OrreryPolicyModule.Status) public lastStatusOf;
    mapping(address signer => address[]) internal _tokensAtOpen;
    mapping(uint256 agentId => uint256) public pendingProposedAt;
    mapping(uint256 agentId => uint256) public pendingDelay;
    uint256[] public touchedDays;
    mapping(uint256 => bool) internal _dayTouched;
    address[] public signers;

    // flags (must stay false)
    bool public flagOverPerTx; // A2
    bool public flagOverPerDay; // A1
    bool public flagFloat; // A3
    bool public flagSignerReused; // S4
    bool public flagRevokedRevived; // S1
    bool public flagEarlyIncrease; // P1
    bool public flagInactiveSpent; // S2
    bool public flagTokenDropped; // A9
    bool public flagAllowanceRaised; // A8

    // coverage counters
    uint256 public nOpen;
    uint256 public nTopUp;
    uint256 public nExecute;
    uint256 public nDecrease;
    uint256 public nPropose;
    uint256 public nApply;
    uint256 public nRevoke;
    uint256 public nPause;
    uint256 public nUninstall;
    uint256 public nTransfer;
    uint256 public nRevert;

    constructor(
        OrreryPolicyModule m,
        MockIdentityRegistry r,
        MockERC20 u,
        MockERC20 w,
        MockAccount7579 a,
        MockTarget t,
        address op,
        uint256[3] memory ids
    ) {
        module = m;
        registry = r;
        usdg = u;
        weth = w;
        account = a;
        target = t;
        operator = op;
        agents = ids;
        clock = block.timestamp;
    }

    // ------------------------------------------------------------------ helpers

    function _agent(uint256 seed) internal view returns (uint256) {
        return agents[seed % 3];
    }

    function _op(bytes memory call) internal returns (bool ok) {
        vm.prank(operator);
        try account.execute(address(module), 0, call) {
            ok = true;
        } catch {
            nRevert++;
        }
    }

    function _policy(uint256 seed, bool withWeth) internal view returns (OrreryPolicyModule.Policy memory p) {
        uint128 perDay = uint128(bound(seed, 1e6, 80e6));
        uint128 perTx = uint128(bound(seed >> 16, 1, perDay));
        uint128 floatMax = uint128(bound(seed >> 32, 0, perDay));
        p.caps = new OrreryPolicyModule.TokenCap[](withWeth ? 2 : 1);
        p.caps[0] = OrreryPolicyModule.TokenCap(address(usdg), perTx, perDay, floatMax);
        if (withWeth) p.caps[1] = OrreryPolicyModule.TokenCap(address(weth), 1e17, 5e17, 2e17);
        p.targets = new OrreryPolicyModule.Target[](2);
        p.targets[0] = OrreryPolicyModule.Target(address(target), MockTarget.pull.selector);
        p.targets[1] = OrreryPolicyModule.Target(address(target), MockTarget.roundTrip.selector);
        p.validUntil = uint64(clock + bound(seed >> 48, 1 days, 20 days));
        p.increaseDelay = uint32(bound(seed >> 64, 1 hours, 6 hours));
    }

    function _touch(uint256 day) internal {
        if (!_dayTouched[day]) {
            _dayTouched[day] = true;
            touchedDays.push(day);
        }
    }

    function _observe(uint256 agentId) internal {
        OrreryPolicyModule.Session memory s = module.getSession(address(account), agentId);
        if (s.signer == address(0)) return;
        OrreryPolicyModule.Status st = module.effectiveStatus(address(account), agentId);
        if (lastStatusOf[s.signer] == OrreryPolicyModule.Status.Revoked && st != OrreryPolicyModule.Status.Revoked) {
            flagRevokedRevived = true;
        }
        lastStatusOf[s.signer] = st;
        if (st != OrreryPolicyModule.Status.Revoked) {
            OrreryPolicyModule.Policy memory p = module.getPolicy(address(account), agentId);
            address[] storage toks = _tokensAtOpen[s.signer];
            for (uint256 i; i < toks.length; ++i) {
                bool found;
                for (uint256 j; j < p.caps.length; ++j) {
                    if (p.caps[j].token == toks[i]) found = true;
                }
                if (!found) flagTokenDropped = true;
            }
        }
    }

    function _observeAll() internal {
        for (uint256 i; i < 3; ++i) _observe(agents[i]);
        if (usdg.allowance(address(account), address(this)) != 0 || usdg.allowance(address(account), merchant) != 0) {
            flagAllowanceRaised = true;
        }
    }

    function _activeSigner(uint256 agentId) internal view returns (address s, bool active) {
        s = module.getSession(address(account), agentId).signer;
        active = s != address(0) && module.effectiveStatus(address(account), agentId) == OrreryPolicyModule.Status.Active
            && module.isInstalledOn(address(account))
            && block.timestamp <= module.getPolicy(address(account), agentId).validUntil;
    }

    // ------------------------------------------------------------------ operator actions

    function open(uint256 seed, bool withWeth, bool reuseSigner) external {
        uint256 agentId = _agent(seed);
        address s;
        if (reuseSigner && signers.length > 0) {
            s = signers[seed % signers.length];
        } else {
            uint256 pk = (uint256(keccak256(abi.encode("signer", signerNonce++))) % (SECP_N - 1)) + 1;
            s = vm.addr(pk);
            keyOf[s] = pk;
        }
        bool wasUsed = everSigner[s];
        OrreryPolicyModule.Policy memory pol = _policy(seed, withWeth);
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(keyOf[s], module.consentDigest(address(account), agentId, keccak256(abi.encode(pol))));
        if (_op(abi.encodeCall(OrreryPolicyModule.openSession, (agentId, s, pol, abi.encodePacked(r, ss, v))))) {
            nOpen++;
            if (wasUsed) flagSignerReused = true;
            everSigner[s] = true;
            signers.push(s);
            OrreryPolicyModule.Policy memory p = module.getPolicy(address(account), agentId);
            for (uint256 i; i < p.caps.length; ++i) _tokensAtOpen[s].push(p.caps[i].token);
            pendingProposedAt[agentId] = 0;
        }
        _observeAll();
    }

    function decrease(uint256 seed) external {
        uint256 agentId = _agent(seed);
        OrreryPolicyModule.Policy memory p = module.getPolicy(address(account), agentId);
        if (p.caps.length == 0) return;
        for (uint256 i; i < p.caps.length; ++i) {
            p.caps[i].perTx = uint128(bound(seed >> (i * 8), 0, p.caps[i].perTx));
            p.caps[i].floatMax = uint128(bound(seed >> (i * 8 + 4), 0, p.caps[i].floatMax));
            p.caps[i].perDay = uint128(bound(seed >> (i * 8 + 2), p.caps[i].perTx > p.caps[i].floatMax ? p.caps[i].perTx : p.caps[i].floatMax, p.caps[i].perDay));
        }
        if (seed % 4 == 0 && p.targets.length > 0) {
            OrreryPolicyModule.Target[] memory t = new OrreryPolicyModule.Target[](p.targets.length - 1);
            for (uint256 i; i < t.length; ++i) t[i] = p.targets[i];
            p.targets = t;
        }
        if (_op(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, p)))) {
            nDecrease++;
            pendingProposedAt[agentId] = 0;
        }
        _observeAll();
    }

    function dropTokenAttempt(uint256 seed) external {
        uint256 agentId = _agent(seed);
        OrreryPolicyModule.Policy memory p = module.getPolicy(address(account), agentId);
        if (p.caps.length < 2) return;
        OrreryPolicyModule.TokenCap[] memory c = new OrreryPolicyModule.TokenCap[](1);
        c[0] = p.caps[0];
        p.caps = c;
        if (seed % 2 == 0) _op(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, p)));
        else _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, p)));
        _observeAll();
    }

    function propose(uint256 seed) external {
        uint256 agentId = _agent(seed);
        OrreryPolicyModule.Policy memory cur = module.getPolicy(address(account), agentId);
        if (cur.caps.length == 0) return;
        OrreryPolicyModule.Policy memory p = _policy(seed, cur.caps.length == 2);
        p.caps[0].perDay = cur.caps[0].perDay + uint128(bound(seed, 1, 50e6));
        if (p.caps[0].perTx > p.caps[0].perDay) p.caps[0].perTx = p.caps[0].perDay;
        uint256 delayInForce = cur.increaseDelay < 1 hours ? 1 hours : cur.increaseDelay;
        if (_op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, p)))) {
            nPropose++;
            pendingProposedAt[agentId] = block.timestamp;
            pendingDelay[agentId] = delayInForce;
        }
        _observeAll();
    }

    function applyIncrease(uint256 seed) external {
        uint256 agentId = _agent(seed);
        uint256 proposedAt = pendingProposedAt[agentId];
        if (_op(abi.encodeCall(OrreryPolicyModule.applyIncrease, (agentId)))) {
            nApply++;
            if (proposedAt == 0 || block.timestamp < proposedAt + pendingDelay[agentId]) flagEarlyIncrease = true;
            pendingProposedAt[agentId] = 0;
        }
        _observeAll();
    }

    function cancel(uint256 seed) external {
        uint256 agentId = _agent(seed);
        if (_op(abi.encodeCall(OrreryPolicyModule.cancelIncrease, (agentId)))) pendingProposedAt[agentId] = 0;
        _observeAll();
    }

    function pauseToggle(uint256 seed) external {
        uint256 agentId = _agent(seed);
        if (seed % 2 == 0) {
            if (_op(abi.encodeCall(OrreryPolicyModule.pause, (agentId)))) nPause++;
        } else {
            _op(abi.encodeCall(OrreryPolicyModule.unpause, (agentId)));
        }
        _observeAll();
    }

    function revoke(uint256 seed) external {
        uint256 agentId = _agent(seed);
        if (_op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)))) {
            nRevoke++;
            pendingProposedAt[agentId] = 0;
        }
        _observeAll();
    }

    function reinstall(uint256 seed) external {
        vm.startPrank(operator);
        account.setSkipUninstallCallback(seed % 3 == 0);
        account.uninstallModule(2, address(module), "");
        if (seed % 5 != 0) account.installModule(2, address(module), "");
        vm.stopPrank();
        nUninstall++;
        for (uint256 i; i < 3; ++i) pendingProposedAt[agents[i]] = 0;
        _observeAll();
    }

    function ensureInstalled() external {
        if (!module.isInstalledOn(address(account))) {
            vm.prank(operator);
            account.installModule(2, address(module), "");
        }
    }

    function transferIdentity(uint256 seed) external {
        uint256 agentId = _agent(seed);
        address owner = registry.ownerOfMap(agentId);
        vm.prank(owner);
        registry.transferFrom(owner, operator == owner ? address(0xA11CE) : operator, agentId);
        address newOwner = registry.ownerOfMap(agentId);
        if (newOwner == operator) {
            vm.prank(operator);
            registry.setAgentWallet(agentId, address(account));
        }
        nTransfer++;
        _observeAll();
    }

    function warp(uint256 secs) external {
        clock += bound(secs, 1 minutes, 30 hours);
        vm.warp(clock);
        _observeAll();
    }

    // ------------------------------------------------------------------ agent actions

    function topUp(uint256 seed, uint256 amount, bool useWeth) external {
        uint256 agentId = _agent(seed);
        (address s, bool active) = _activeSigner(agentId);
        if (s == address(0)) return;
        address token = useWeth ? address(weth) : address(usdg);
        amount = bound(amount, 1, 30e6);
        uint256 accBefore = MockERC20(token).balanceOf(address(account));
        OrreryPolicyModule.Policy memory p = module.getPolicy(address(account), agentId);
        vm.prank(s);
        try module.topUp(token, amount) {
            nTopUp++;
            if (!active) flagInactiveSpent = true;
            uint256 out = accBefore - MockERC20(token).balanceOf(address(account));
            _record(agentId, token, out, p);
            for (uint256 i; i < p.caps.length; ++i) {
                if (p.caps[i].token == token && MockERC20(token).balanceOf(s) > p.caps[i].floatMax) flagFloat = true;
            }
        } catch {
            nRevert++;
        }
        _observeAll();
    }

    function spendFloat(uint256 seed) external {
        address s = module.getSession(address(account), _agent(seed)).signer;
        if (s == address(0)) return;
        uint256 b = usdg.balanceOf(s);
        if (b == 0) return;
        vm.prank(s);
        usdg.transfer(merchant, b);
    }

    function execute(uint256 seed, uint256 amount, bool roundTrip) external {
        uint256 agentId = _agent(seed);
        (address s, bool active) = _activeSigner(agentId);
        if (s == address(0)) return;
        amount = bound(amount, 1, 30e6);
        uint256 accBefore = usdg.balanceOf(address(account));
        OrreryPolicyModule.Policy memory p = module.getPolicy(address(account), agentId);
        bytes memory data = roundTrip
            ? abi.encodeCall(MockTarget.roundTrip, (address(usdg), amount, amount / 2))
            : abi.encodeCall(MockTarget.pull, (address(usdg), amount));
        vm.prank(s);
        try module.execute(address(target), data) {
            nExecute++;
            if (!active) flagInactiveSpent = true;
            uint256 accAfter = usdg.balanceOf(address(account));
            if (accAfter < accBefore) _record(agentId, address(usdg), accBefore - accAfter, p);
        } catch {
            nRevert++;
        }
        _observeAll();
    }

    function _record(uint256 agentId, address token, uint256 out, OrreryPolicyModule.Policy memory p) internal {
        uint256 day = block.timestamp / 1 days;
        _touch(day);
        ghostOut[agentId][token][day] += out;
        for (uint256 i; i < p.caps.length; ++i) {
            if (p.caps[i].token != token) continue;
            if (out > p.caps[i].perTx) flagOverPerTx = true;
            if (module.spentOn(address(account), agentId, token, day) > p.caps[i].perDay) flagOverPerDay = true;
        }
    }

    function touchedDayCount() external view returns (uint256) {
        return touchedDays.length;
    }
}
