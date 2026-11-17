// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {OrreryLens} from "../../src/OrreryLens.sol";
import {IIdentityRegistry, IERC20Min} from "../../src/interfaces/IExternal.sol";

contract AttestorTest is Base {
    address attester = makeAddr("attester");
    address payer = makeAddr("payer");

    function setUp() public override {
        super.setUp();
        vm.prank(adminWallet);
        attestor.setAttester(attester, true);
        usdg.mint(payer, 100e6);
        vm.prank(payer);
        usdg.approve(address(attestor), type(uint256).max);
    }

    function _att(uint64 observedAt, uint64 expiresAt) internal pure returns (OrreryAttestor.Attestation memory a) {
        a = OrreryAttestor.Attestation(observedAt, expiresAt, true, true, false, keccak256("reg"), address(0xdead));
    }

    function test_constructor_cap_and_zero_checks() public {
        assertEq(attestor.feeCap(), 50e6);
        _ctorReverts(adminWallet, treasury, 50e6 + 1, abi.encodeWithSelector(OrreryAttestor.FeeAboveCap.selector));
        _ctorReverts(address(0), treasury, 0, abi.encodeWithSelector(OrreryAttestor.ZeroAddress.selector));
        _ctorReverts(adminWallet, address(0), 0, abi.encodeWithSelector(OrreryAttestor.ZeroAddress.selector));
    }

    /// @dev try/catch rather than expectRevert: with dynamic test linking and isolate (the effective forge config) a
    /// `new` becomes `vm.deployCode`, and an expected revert there ends the test, so later checks would never run.
    function _ctorReverts(address owner_, address treasury_, uint128 fee_, bytes memory expected) internal {
        try new OrreryAttestor(IIdentityRegistry(address(registry)), IERC20Min(address(usdg)), owner_, treasury_, fee_)
        returns (OrreryAttestor) {
            revert("constructor did not revert");
        } catch (bytes memory data) {
            assertEq(data, expected);
        }
    }

    function test_pay_verification_moves_exact_fee() public {
        vm.prank(payer);
        attestor.payVerification(agentId, operator, 5e6);
        assertEq(usdg.balanceOf(treasury), 5e6);
        assertTrue(attestor.isVerified(agentId));
        assertEq(attestor.getVerification(agentId).ownerAtPayment, operator);
        vm.prank(payer);
        vm.expectRevert(OrreryAttestor.AlreadyVerified.selector);
        attestor.payVerification(agentId, operator, 5e6);
    }

    function test_pay_verification_max_fee_and_missing_agent() public {
        vm.prank(payer);
        vm.expectRevert(OrreryAttestor.FeeChanged.selector);
        attestor.payVerification(agentId, operator, 4e6);
        vm.prank(payer);
        vm.expectRevert();
        attestor.payVerification(999, operator, 5e6);
    }

    function test_treasury_self_pay_records_zero() public {
        usdg.mint(treasury, 10e6);
        vm.prank(treasury);
        attestor.payVerification(agentId, operator, 5e6);
        assertEq(attestor.getVerification(agentId).feePaid, 0);
        assertEq(usdg.balanceOf(treasury), 10e6);
    }

    function test_transfer_voids_verification_and_attestation_until_new_payment() public {
        vm.prank(payer);
        attestor.payVerification(agentId, operator, 5e6);
        vm.prank(attester);
        attestor.attest(agentId, _att(uint64(block.timestamp), uint64(block.timestamp + 1 days)));
        address buyer = makeAddr("buyer");
        vm.prank(operator);
        registry.transferFrom(operator, buyer, agentId);
        assertFalse(attestor.isVerified(agentId));
        vm.prank(attester);
        vm.expectRevert(OrreryAttestor.NotVerified.selector);
        attestor.attest(agentId, _att(uint64(block.timestamp), uint64(block.timestamp + 1 days)));
        vm.warp(block.timestamp + 10);
        vm.prank(payer);
        attestor.payVerification(agentId, buyer, 5e6);
        assertTrue(attestor.isVerified(agentId));
        assertEq(attestor.getAttestation(agentId).observedAt, 0, "payment deletes the previous owner's attestation");
        // an observation from before the new payment is refused
        vm.prank(attester);
        vm.expectRevert(OrreryAttestor.BadObservedAt.selector);
        attestor.attest(agentId, _att(uint64(block.timestamp - 5), uint64(block.timestamp + 1 days)));
    }

    function test_attest_rules() public {
        vm.prank(payer);
        attestor.payVerification(agentId, operator, 5e6);
        vm.prank(makeAddr("x"));
        vm.expectRevert(OrreryAttestor.NotAttester.selector);
        attestor.attest(agentId, _att(uint64(block.timestamp), uint64(block.timestamp + 1)));
        vm.startPrank(attester);
        vm.expectRevert(OrreryAttestor.BadObservedAt.selector);
        attestor.attest(agentId, _att(uint64(block.timestamp + 1), uint64(block.timestamp + 1 days)));
        vm.expectRevert(OrreryAttestor.BadExpiry.selector);
        attestor.attest(agentId, _att(uint64(block.timestamp), uint64(block.timestamp)));
        vm.expectRevert(OrreryAttestor.BadExpiry.selector);
        attestor.attest(agentId, _att(uint64(block.timestamp), uint64(block.timestamp + 7 days + 1)));
        attestor.attest(agentId, _att(uint64(block.timestamp), uint64(block.timestamp + 7 days)));
        assertEq(attestor.getAttestation(agentId).attester, attester, "attester is msg.sender, not calldata");
        vm.expectRevert(OrreryAttestor.BadObservedAt.selector);
        attestor.attest(agentId, _att(uint64(block.timestamp), uint64(block.timestamp + 1 days)));
        vm.stopPrank();
        vm.prank(adminWallet);
        attestor.clearAttestation(agentId);
        assertEq(attestor.getAttestation(agentId).observedAt, 0);
    }

    function test_admin_caps() public {
        vm.startPrank(adminWallet);
        for (uint256 i; i < 4; ++i) attestor.setAttester(address(uint160(500 + i)), true);
        vm.expectRevert(OrreryAttestor.TooManyKeys.selector);
        attestor.setAttester(address(600), true);
        for (uint256 i; i < 5; ++i) attestor.setCheckSigner(address(uint160(700 + i)), true);
        vm.expectRevert(OrreryAttestor.TooManyKeys.selector);
        attestor.setCheckSigner(address(800), true);
        attestor.setCheckSigner(address(700), false);
        attestor.setCheckSigner(address(800), true);
        assertEq(attestor.checkSignerCount(), 5);
        vm.expectRevert(OrreryAttestor.FeeAboveCap.selector);
        attestor.setFee(50e6 + 1);
        attestor.setFee(50e6);
        vm.expectRevert(OrreryAttestor.ZeroAddress.selector);
        attestor.setTreasury(address(0));
        vm.stopPrank();
        vm.prank(payer);
        vm.expectRevert(OrreryAttestor.NotOwner.selector);
        attestor.setFee(1);
    }

    function test_two_step_ownership() public {
        address next = makeAddr("next");
        vm.prank(adminWallet);
        attestor.transferOwnership(next);
        vm.prank(payer);
        vm.expectRevert(OrreryAttestor.NotPendingOwner.selector);
        attestor.acceptOwnership();
        vm.prank(next);
        attestor.acceptOwnership();
        assertEq(attestor.owner(), next);
    }
}

contract LensTest is Base {
    function test_unknown_signer_is_empty() public {
        OrreryLens.CheckView memory v = lens.checkBySigner(makeAddr("nobody"));
        assertEq(v.account, address(0));
        assertEq(uint8(v.status), uint8(OrreryLens.EffectiveStatus.None));
    }

    function test_view_of_an_active_session() public {
        _openDefault();
        vm.prank(signer);
        module.topUp(address(usdg), 3e6);
        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertEq(v.account, address(account));
        assertEq(v.agentId, agentId);
        assertTrue(v.bound);
        assertTrue(v.installed);
        assertEq(uint8(v.status), uint8(OrreryLens.EffectiveStatus.Active));
        assertEq(uint8(v.accountKind), uint8(OrreryLens.AccountKind.Unknown), "mock account is not a known Safe");
        assertEq(v.caps[0].spentToday, 3e6);
        assertEq(v.validFor, block.timestamp, "an unknown account kind leaves no window (R-05)");
        assertEq(v.owner, operator);
    }

    function test_validFor_is_now_when_not_active() public {
        _openDefault();
        _op(abi.encodeCall(OrreryPolicyModule.pause, (agentId)));
        assertEq(lens.checkBySigner(signer).validFor, block.timestamp, "a paused session can unpause at once (R-05)");
    }

    function test_bound_false_after_identity_transfer() public {
        _openDefault();
        vm.prank(operator);
        registry.transferFrom(operator, makeAddr("buyer"), agentId);
        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertFalse(v.bound);
        assertEq(uint8(v.status), uint8(OrreryLens.EffectiveStatus.Active), "authority does not depend on binding (B3)");
    }

    function test_expired_and_replaced_signers() public {
        _openDefault();
        vm.warp(block.timestamp + 31 days);
        assertEq(uint8(lens.checkBySigner(signer).status), uint8(OrreryLens.EffectiveStatus.Expired));
        _op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)));
        _op(_openCall(agentId, _signer("s2"), _policy(1, 2, 2)));
        assertEq(uint8(lens.checkBySigner(signer).status), uint8(OrreryLens.EffectiveStatus.Revoked));
        assertEq(uint8(lens.checkBySigner(_signer("s2")).status), uint8(OrreryLens.EffectiveStatus.Active));
        assertEq(lens.checkByAgent(agentId, address(account)).signer, _signer("s2"));
    }
}
