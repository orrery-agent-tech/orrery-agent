// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {FeeOnTransferToken, FalseReturnToken, MockTarget} from "../mocks/Mocks.sol";

contract PolicyModuleLifecycleTest is Base {
    function test_install_bumps_epoch_and_type() public view {
        assertEq(module.epoch(address(account)), 1);
        assertTrue(module.isInitialized(address(account)));
        assertTrue(module.isModuleType(2));
        assertFalse(module.isModuleType(1));
        assertTrue(module.isInstalledOn(address(account)));
    }

    function test_uninstall_revokes_all_sessions_O1() public {
        _openDefault();
        _asAccount(abi.encodeWithSignature("uninstallModule(uint256,address,bytes)", 2, address(module), ""));
        assertEq(module.epoch(address(account)), 2);
        assertFalse(module.isInitialized(address(account)));
        assertEq(uint8(module.effectiveStatus(address(account), agentId)), uint8(OrreryPolicyModule.Status.Revoked));
    }

    function test_reinstall_without_onUninstall_keeps_old_sessions_revoked() public {
        _openDefault();
        _asAccount(abi.encodeWithSignature("setSkipUninstallCallback(bool)", true));
        _asAccount(abi.encodeWithSignature("uninstallModule(uint256,address,bytes)", 2, address(module), ""));
        assertEq(module.epoch(address(account)), 1, "callback skipped");
        _asAccount(abi.encodeWithSignature("installModule(uint256,address,bytes)", 2, address(module), ""));
        assertEq(module.epoch(address(account)), 2);
        assertEq(uint8(module.effectiveStatus(address(account), agentId)), uint8(OrreryPolicyModule.Status.Revoked));
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.NotActive.selector);
        module.topUp(address(usdg), 1e6);
    }

    function test_onInstall_and_onUninstall_never_revert_for_any_caller() public {
        address rando = makeAddr("rando");
        vm.startPrank(rando);
        module.onInstall("");
        module.onUninstall("x");
        module.onUninstall("");
        vm.stopPrank();
        assertEq(module.epoch(rando), 3);
    }
}

contract PolicyModuleOpenTest is Base {
    function test_open_session() public {
        OrreryPolicyModule.Policy memory p = _policy(10e6, 50e6, 20e6);
        vm.expectEmit(true, true, true, true, address(module));
        emit OrreryPolicyModule.SessionOpened(address(account), agentId, signer, 1);
        _open(p);
        OrreryPolicyModule.Session memory s = module.getSession(address(account), agentId);
        assertEq(s.signer, signer);
        assertEq(uint8(s.status), uint8(OrreryPolicyModule.Status.Active));
        assertEq(s.policyHash, keccak256(abi.encode(p)));
        assertEq(keccak256(abi.encode(module.getPolicy(address(account), agentId))), s.policyHash);
        (address a, uint256 id) = module.signerOf(signer);
        assertEq(a, address(account));
        assertEq(id, agentId);
    }

    function test_open_requires_install() public {
        _asAccount(abi.encodeWithSignature("uninstallModule(uint256,address,bytes)", 2, address(module), ""));
        _opExpectRevert(
            _openCall(agentId, signer, _policy(1, 2, 2)),
            abi.encodeWithSelector(OrreryPolicyModule.NotInstalled.selector)
        );
    }

    function test_open_requires_binding() public {
        vm.prank(operator);
        registry.setAgentWallet(agentId, operator);
        _opExpectRevert(
            _openCall(agentId, signer, _policy(1, 2, 2)),
            abi.encodeWithSelector(OrreryPolicyModule.NotBound.selector)
        );
    }

    function test_open_twice_reverts() public {
        _openDefault();
        _opExpectRevert(
            _openCall(agentId, _signer("s2"), _policy(1, 2, 2)),
            abi.encodeWithSelector(OrreryPolicyModule.SessionExists.selector)
        );
    }

    function test_open_bad_signers() public {
        OrreryPolicyModule.Policy memory p = _policy(1, 2, 2);
        _opExpectRevert(
            _openCall(agentId, address(0), p),
            abi.encodeWithSelector(OrreryPolicyModule.InvalidSigner.selector)
        );
        _opExpectRevert(
            _openCall(agentId, address(account), p),
            abi.encodeWithSelector(OrreryPolicyModule.InvalidSigner.selector)
        );
        _opExpectRevert(
            _openCall(agentId, address(target), p),
            abi.encodeWithSelector(OrreryPolicyModule.InvalidSigner.selector)
        );
    }

    function test_signer_single_use_across_agents_and_accounts() public {
        _openDefault();
        _op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)));
        // same agent, same signer: refused
        _opExpectRevert(
            _openCall(agentId, signer, _policy(1, 2, 2)),
            abi.encodeWithSelector(OrreryPolicyModule.SignerUsed.selector)
        );
        // another agent on the same account: refused
        vm.prank(operator);
        uint256 agent2 = registry.register(operator);
        vm.prank(operator);
        registry.setAgentWallet(agent2, address(account));
        _opExpectRevert(
            _openCall(agent2, signer, _policy(1, 2, 2)),
            abi.encodeWithSelector(OrreryPolicyModule.SignerUsed.selector)
        );
        // a fresh signer works after revoke
        _op(_openCall(agentId, _signer("fresh"), _policy(1, 2, 2)));
    }

    function test_validation_errors() public {
        OrreryPolicyModule.Policy memory p = _policy(10, 50, 20);
        p.caps = new OrreryPolicyModule.TokenCap[](0);
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.BadCapCount.selector));

        p = _policy(10, 50, 20);
        p.caps = new OrreryPolicyModule.TokenCap[](9);
        for (uint256 i; i < 9; ++i) p.caps[i] = _cap(address(uint160(1000 + i)), 1, 1, 1);
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.BadCapCount.selector));

        p = _policy(10, 50, 20);
        p.caps = new OrreryPolicyModule.TokenCap[](2);
        p.caps[0] = _cap(address(usdg), 1, 2, 2);
        p.caps[1] = _cap(address(usdg), 1, 2, 2);
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.DuplicateToken.selector));

        _expectOpen(_policy(51, 50, 20), abi.encodeWithSelector(OrreryPolicyModule.BadCaps.selector));
        _expectOpen(_policy(10, 50, 51), abi.encodeWithSelector(OrreryPolicyModule.BadCaps.selector));

        p = _policy(10, 50, 20);
        p.targets = new OrreryPolicyModule.Target[](33);
        for (uint256 i; i < 33; ++i) p.targets[i] = OrreryPolicyModule.Target(address(target), bytes4(uint32(i + 1)));
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.BadTargetCount.selector));

        p = _policy(10, 50, 20);
        p.targets = new OrreryPolicyModule.Target[](2);
        p.targets[0] = OrreryPolicyModule.Target(address(target), MockTarget.ping.selector);
        p.targets[1] = OrreryPolicyModule.Target(address(target), MockTarget.ping.selector);
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.DuplicateTarget.selector));

        p = _policy(10, 50, 20);
        p.validUntil = uint64(block.timestamp);
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.BadValidUntil.selector));

        p = _policy(10, 50, 20);
        p.increaseDelay = 59 minutes;
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.BadIncreaseDelay.selector));
        p.increaseDelay = 31 days;
        _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.BadIncreaseDelay.selector));
    }

    function test_forbidden_selectors() public {
        bytes4[14] memory sels = [
            bytes4(0x095ea7b3), 0x39509351, 0xa22cb465, 0xd505accf, 0x87517c45, 0x2b67b570, 0x2a2d80d1,
            0xc04a8a10, 0xa9059cbb, 0x23b872dd, 0x42842e0e, 0xb88d4fde, 0xf242432a, 0x2eb2c2d6
        ];
        for (uint256 i; i < sels.length; ++i) {
            assertTrue(module.isForbiddenSelector(sels[i]));
            _expectOpen(_policyWithTarget(sels[i]), abi.encodeWithSelector(OrreryPolicyModule.ForbiddenSelector.selector, sels[i]));
        }
        assertFalse(module.isForbiddenSelector(MockTarget.ping.selector));
    }

    function test_forbidden_targets() public {
        address[10] memory bad = [
            address(0), address(module), address(account), address(registry), address(attestor), permit2, ep07, ep08,
            adapter, address(usdg)
        ];
        for (uint256 i; i < bad.length; ++i) {
            OrreryPolicyModule.Policy memory p = _policyWithTarget(MockTarget.ping.selector);
            p.targets[0].target = bad[i];
            _expectOpen(p, abi.encodeWithSelector(OrreryPolicyModule.ForbiddenTarget.selector, bad[i]));
        }
        // any module installed on the account is forbidden
        address otherModule = address(new MockTarget());
        vm.mockCall(otherModule, abi.encodeWithSignature("onInstall(bytes)", ""), "");
        _asAccount(abi.encodeWithSignature("installModule(uint256,address,bytes)", 3, otherModule, ""));
        OrreryPolicyModule.Policy memory q = _policyWithTarget(MockTarget.ping.selector);
        q.targets[0].target = otherModule;
        _expectOpen(q, abi.encodeWithSelector(OrreryPolicyModule.ForbiddenTarget.selector, otherModule));
    }

    function _expectOpen(OrreryPolicyModule.Policy memory p, bytes memory err) internal {
        _opExpectRevert(_openCall(agentId, signer, p), err);
    }
}

contract PolicyModuleChangeTest is Base {
    function setUp() public override {
        super.setUp();
        _openDefault();
    }

    function test_decrease_applies_at_once() public {
        OrreryPolicyModule.Policy memory p = _policy(5e6, 40e6, 10e6);
        p.validUntil = uint64(block.timestamp + 10 days);
        p.increaseDelay = 2 hours;
        _op(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, p)));
        assertEq(module.getPolicy(address(account), agentId).caps[0].perDay, 40e6);
        assertEq(module.getSession(address(account), agentId).policyHash, keccak256(abi.encode(p)));
    }

    function test_decrease_rejects_increases() public {
        _expectDecrease(_policy(11e6, 50e6, 20e6));
        _expectDecrease(_policy(10e6, 51e6, 20e6));
        _expectDecrease(_policy(10e6, 50e6, 21e6));
        OrreryPolicyModule.Policy memory p = _policy(10e6, 50e6, 20e6);
        p.validUntil = uint64(block.timestamp + 31 days);
        _expectDecrease(p);
        p = _policy(10e6, 50e6, 20e6);
        p.targets = new OrreryPolicyModule.Target[](1);
        p.targets[0] = OrreryPolicyModule.Target(address(target), MockTarget.ping.selector);
        _expectDecrease(p);
        // dropping a token is never a decrease (R-C1)
        p = _policy(10e6, 50e6, 20e6);
        p.caps[0] = _cap(address(weth), 1, 1, 1);
        _expectDecrease(p);
        // a different increaseDelay that is shorter
        _op(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, _withDelay(_policy(10e6, 50e6, 20e6), 3 hours))));
        _expectDecrease(_withDelay(_policy(10e6, 50e6, 20e6), 2 hours));
    }

    function test_cap_zero_is_a_decrease_and_token_stays() public {
        _op(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, _policy(0, 0, 0))));
        assertEq(module.getPolicy(address(account), agentId).caps[0].token, address(usdg));
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.PerTxExceeded.selector);
        module.topUp(address(usdg), 1);
    }

    function test_increase_waits_the_delay() public {
        OrreryPolicyModule.Policy memory p = _policy(10e6, 100e6, 20e6);
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, p)));
        (OrreryPolicyModule.Pending memory pend,) = module.getPending(address(account), agentId);
        assertEq(pend.readyAt, block.timestamp + 1 hours);
        _opExpectRevert(
            abi.encodeCall(OrreryPolicyModule.applyIncrease, (agentId)),
            abi.encodeWithSelector(OrreryPolicyModule.IncreaseNotReady.selector)
        );
        vm.warp(block.timestamp + 1 hours);
        _op(abi.encodeCall(OrreryPolicyModule.applyIncrease, (agentId)));
        assertEq(module.getPolicy(address(account), agentId).caps[0].perDay, 100e6);
        (pend,) = module.getPending(address(account), agentId);
        assertEq(pend.readyAt, 0);
    }

    function test_increase_uses_current_longer_delay() public {
        _op(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, _withDelay(_policy(10e6, 50e6, 20e6), 5 hours))));
        // propose to shorten the delay back to 1h: still waits the 5h in force
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, _withDelay(_policy(10e6, 50e6, 20e6), 1 hours))));
        (OrreryPolicyModule.Pending memory pend,) = module.getPending(address(account), agentId);
        assertEq(pend.readyAt, block.timestamp + 5 hours);
    }

    function test_propose_rules() public {
        OrreryPolicyModule.Policy memory p = _policy(10e6, 100e6, 20e6);
        p.caps[0] = _cap(address(weth), 1, 1, 1);
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, p)), abi.encodeWithSelector(OrreryPolicyModule.TokenDropped.selector));
        _opExpectRevert(
            abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, _policy(1e6, 50e6, 20e6))),
            abi.encodeWithSelector(OrreryPolicyModule.UseDecrease.selector)
        );
        _opExpectRevert(
            abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId + 99, _policy(10e6, 100e6, 20e6))),
            abi.encodeWithSelector(OrreryPolicyModule.NoSession.selector)
        );
        // adding a token is an increase
        OrreryPolicyModule.Policy memory q = _policy(10e6, 50e6, 20e6);
        OrreryPolicyModule.TokenCap[] memory caps = new OrreryPolicyModule.TokenCap[](2);
        caps[0] = q.caps[0];
        caps[1] = _cap(address(weth), 1e18, 2e18, 1e18);
        q.caps = caps;
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, q)));
    }

    function test_decrease_and_revoke_cancel_pending() public {
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, _policy(10e6, 100e6, 20e6))));
        _op(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, _policy(10e6, 40e6, 20e6))));
        (OrreryPolicyModule.Pending memory pend,) = module.getPending(address(account), agentId);
        assertEq(pend.readyAt, 0);
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, _policy(10e6, 100e6, 20e6))));
        _op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)));
        (pend,) = module.getPending(address(account), agentId);
        assertEq(pend.readyAt, 0);
    }

    function test_cancel_increase() public {
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.cancelIncrease, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.NoPending.selector));
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, _policy(10e6, 100e6, 20e6))));
        _op(abi.encodeCall(OrreryPolicyModule.cancelIncrease, (agentId)));
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.applyIncrease, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.NoPending.selector));
    }

    function test_pending_dies_with_uninstall() public {
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, _policy(10e6, 100e6, 20e6))));
        _asAccount(abi.encodeWithSignature("uninstallModule(uint256,address,bytes)", 2, address(module), ""));
        _asAccount(abi.encodeWithSignature("installModule(uint256,address,bytes)", 2, address(module), ""));
        vm.warp(block.timestamp + 2 hours);
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.applyIncrease, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.AlreadyRevoked.selector));
    }

    function test_apply_revalidates_expired_pending() public {
        OrreryPolicyModule.Policy memory p = _policy(10e6, 100e6, 20e6);
        p.validUntil = uint64(block.timestamp + 31 days);
        _op(abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, p)));
        vm.warp(block.timestamp + 32 days);
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.applyIncrease, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.BadValidUntil.selector));
    }

    function test_pause_unpause_revoke() public {
        _op(abi.encodeCall(OrreryPolicyModule.pause, (agentId)));
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.NotActive.selector);
        module.topUp(address(usdg), 1e6);
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.pause, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.NotActive.selector));
        _op(abi.encodeCall(OrreryPolicyModule.unpause, (agentId)));
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.unpause, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.NotPaused.selector));
        _op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)));
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.AlreadyRevoked.selector));
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.unpause, (agentId)), abi.encodeWithSelector(OrreryPolicyModule.NotPaused.selector));
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.revoke, (agentId + 5)), abi.encodeWithSelector(OrreryPolicyModule.NoSession.selector));
    }

    function test_revoke_works_when_not_installed() public {
        _asAccount(abi.encodeWithSignature("setSkipUninstallCallback(bool)", true));
        _asAccount(abi.encodeWithSignature("uninstallModule(uint256,address,bytes)", 2, address(module), ""));
        _op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)));
        assertEq(uint8(module.effectiveStatus(address(account), agentId)), uint8(OrreryPolicyModule.Status.Revoked));
    }

    function test_only_the_account_changes_its_sessions() public {
        // an outsider calling directly acts on its own (empty) namespace
        address outsider = makeAddr("outsider");
        vm.prank(outsider);
        vm.expectRevert(OrreryPolicyModule.NoSession.selector);
        module.revoke(agentId);
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.NoSession.selector);
        module.revoke(agentId);
        assertEq(uint8(module.effectiveStatus(address(account), agentId)), uint8(OrreryPolicyModule.Status.Active));
    }

    function _expectDecrease(OrreryPolicyModule.Policy memory p) internal {
        _opExpectRevert(abi.encodeCall(OrreryPolicyModule.decreasePolicy, (agentId, p)), abi.encodeWithSelector(OrreryPolicyModule.NotDecrease.selector));
    }

    function _withDelay(OrreryPolicyModule.Policy memory p, uint32 d) internal pure returns (OrreryPolicyModule.Policy memory) {
        p.increaseDelay = d;
        return p;
    }
}

contract PolicyModuleAgentTest is Base {
    function setUp() public override {
        super.setUp();
        OrreryPolicyModule.Policy memory p = _policy(10e6, 50e6, 20e6);
        OrreryPolicyModule.TokenCap[] memory caps = new OrreryPolicyModule.TokenCap[](2);
        caps[0] = p.caps[0];
        caps[1] = _cap(address(0), 0.1 ether, 0.3 ether, 0.2 ether);
        p.caps = caps;
        p.targets = new OrreryPolicyModule.Target[](3);
        p.targets[0] = OrreryPolicyModule.Target(address(target), MockTarget.pull.selector);
        p.targets[1] = OrreryPolicyModule.Target(address(target), MockTarget.roundTrip.selector);
        p.targets[2] = OrreryPolicyModule.Target(address(target), MockTarget.reenter.selector);
        _open(p);
        // the operator's old approval that an allowlisted target can use
        _asAccount(abi.encodeWithSignature("execute(address,uint256,bytes)", address(usdg), 0, abi.encodeWithSignature("approve(address,uint256)", address(target), type(uint256).max)));
    }

    function test_topUp_moves_exact_amount_and_counts() public {
        vm.prank(signer);
        module.topUp(address(usdg), 10e6);
        assertEq(usdg.balanceOf(signer), 10e6);
        assertEq(module.spentToday(address(account), agentId, address(usdg)), 10e6);
    }

    function test_topUp_limits() public {
        vm.startPrank(signer);
        vm.expectRevert(OrreryPolicyModule.ZeroAmount.selector);
        module.topUp(address(usdg), 0);
        vm.expectRevert(OrreryPolicyModule.PerTxExceeded.selector);
        module.topUp(address(usdg), 10e6 + 1);
        vm.expectRevert(OrreryPolicyModule.TokenNotAllowed.selector);
        module.topUp(address(weth), 1);
        module.topUp(address(usdg), 10e6);
        module.topUp(address(usdg), 10e6);
        vm.expectRevert(OrreryPolicyModule.FloatExceeded.selector);
        module.topUp(address(usdg), 1);
        // spending the float lets the agent top up again, still under the daily cap
        usdg.transfer(makeAddr("merchant"), 20e6);
        module.topUp(address(usdg), 10e6);
        module.topUp(address(usdg), 10e6);
        usdg.transfer(makeAddr("merchant"), 20e6);
        module.topUp(address(usdg), 10e6);
        vm.expectRevert(OrreryPolicyModule.DailyCapExceeded.selector);
        module.topUp(address(usdg), 1);
        vm.stopPrank();
        assertEq(module.spentToday(address(account), agentId, address(usdg)), 50e6);
        // next UTC day resets the bucket
        vm.warp(block.timestamp + 1 days);
        uint256 bal = usdg.balanceOf(signer);
        vm.prank(signer);
        usdg.transfer(makeAddr("merchant"), bal);
        vm.prank(signer);
        module.topUp(address(usdg), 10e6);
    }

    function test_topUp_native() public {
        vm.prank(signer);
        module.topUp(address(0), 0.1 ether);
        assertEq(signer.balance, 0.1 ether);
        vm.deal(signer, 0.15 ether);
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.FloatExceeded.selector);
        module.topUp(address(0), 0.1 ether);
    }

    function test_unknown_and_stale_signers() public {
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(OrreryPolicyModule.UnknownSigner.selector);
        module.topUp(address(usdg), 1);
        _op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)));
        _op(_openCall(agentId, _signer("s2"), _policy(10e6, 50e6, 20e6)));
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.NotActive.selector);
        module.topUp(address(usdg), 1);
    }

    function test_expired_session() public {
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.Expired.selector);
        module.topUp(address(usdg), 1);
    }

    function test_not_installed_blocks_agent() public {
        _asAccount(abi.encodeWithSignature("setSkipUninstallCallback(bool)", true));
        _asAccount(abi.encodeWithSignature("uninstallModule(uint256,address,bytes)", 2, address(module), ""));
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.NotInstalled.selector);
        module.topUp(address(usdg), 1);
    }

    function test_execute_counts_outflow_by_balance_delta() public {
        vm.prank(signer);
        module.execute(address(target), abi.encodeCall(MockTarget.pull, (address(usdg), 7e6)));
        assertEq(module.spentToday(address(account), agentId, address(usdg)), 7e6);
        assertEq(usdg.balanceOf(address(target)), 7e6);
    }

    function test_execute_caps() public {
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.PerTxExceeded.selector);
        module.execute(address(target), abi.encodeCall(MockTarget.pull, (address(usdg), 10e6 + 1)));
        vm.startPrank(signer);
        for (uint256 i; i < 5; ++i) module.execute(address(target), abi.encodeCall(MockTarget.pull, (address(usdg), 10e6)));
        vm.expectRevert(OrreryPolicyModule.DailyCapExceeded.selector);
        module.execute(address(target), abi.encodeCall(MockTarget.pull, (address(usdg), 1)));
        vm.stopPrank();
    }

    function test_execute_net_and_rise() public {
        vm.prank(signer);
        module.execute(address(target), abi.encodeCall(MockTarget.roundTrip, (address(usdg), 30e6, 25e6)));
        assertEq(module.spentToday(address(account), agentId, address(usdg)), 5e6);
        usdg.mint(address(target), 10e6);
        vm.prank(signer);
        module.execute(address(target), abi.encodeCall(MockTarget.roundTrip, (address(usdg), 1e6, 6e6)));
        assertEq(module.spentToday(address(account), agentId, address(usdg)), 5e6, "a rise records nothing");
    }

    function test_execute_guards() public {
        vm.startPrank(signer);
        vm.expectRevert(OrreryPolicyModule.ShortCalldata.selector);
        module.execute(address(target), hex"aabbcc");
        vm.expectRevert(OrreryPolicyModule.TargetNotAllowed.selector);
        module.execute(address(target), abi.encodeCall(MockTarget.ping, (1)));
        vm.stopPrank();
    }

    function test_execute_rechecks_installed_modules() public {
        vm.mockCall(address(target), abi.encodeWithSignature("onInstall(bytes)", ""), "");
        _asAccount(abi.encodeWithSignature("installModule(uint256,address,bytes)", 1, address(target), ""));
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(OrreryPolicyModule.ForbiddenTarget.selector, address(target)));
        module.execute(address(target), abi.encodeCall(MockTarget.pull, (address(usdg), 1)));
    }

    function test_reentrancy_blocked() public {
        bytes memory inner = abi.encodeCall(OrreryPolicyModule.topUp, (address(usdg), 1e6));
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.Reentrancy.selector);
        module.execute(address(target), abi.encodeCall(MockTarget.reenter, (address(module), inner)));
    }

    function test_hostile_tokens_rejected_on_topUp() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        FalseReturnToken ft = new FalseReturnToken();
        fot.mint(address(account), 1e18);
        ft.mint(address(account), 1e18);
        address s2 = _signer("s2");
        vm.prank(operator);
        uint256 a2 = registry.register(operator);
        vm.prank(operator);
        registry.setAgentWallet(a2, address(account));
        OrreryPolicyModule.Policy memory p = _policy(1, 1, 1);
        OrreryPolicyModule.TokenCap[] memory caps = new OrreryPolicyModule.TokenCap[](2);
        caps[0] = _cap(address(fot), 1e18, 1e18, 1e18);
        caps[1] = _cap(address(ft), 1e18, 1e18, 1e18);
        p.caps = caps;
        _op(_openCall(a2, s2, p));
        vm.startPrank(s2);
        vm.expectRevert(OrreryPolicyModule.InexactTransfer.selector);
        module.topUp(address(fot), 1e17);
        vm.expectRevert(OrreryPolicyModule.InexactTransfer.selector);
        module.topUp(address(ft), 1e17);
        vm.stopPrank();
        assertEq(module.spentToday(address(account), a2, address(fot)), 0);
        assertEq(module.spentToday(address(account), a2, address(ft)), 0);
    }
}
