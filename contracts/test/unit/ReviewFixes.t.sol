// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {OrreryLens} from "../../src/OrreryLens.sol";
import {SenderTaxToken} from "../mocks/Mocks.sol";

contract ReviewFixesTest is Base {
    function test_consent_required_and_bound_to_signer() public {
        OrreryPolicyModule.Policy memory p = _policy(10e6, 50e6, 20e6);
        // no signature
        _opExpectRevert(
            abi.encodeCall(OrreryPolicyModule.openSession, (agentId, signer, p, bytes(""))),
            abi.encodeWithSelector(OrreryPolicyModule.InvalidSignerConsent.selector)
        );
        // signed by someone else
        address other = _signer("other");
        bytes memory wrong = _consent(address(account), agentId, other, p);
        _opExpectRevert(
            abi.encodeCall(OrreryPolicyModule.openSession, (agentId, signer, p, wrong)),
            abi.encodeWithSelector(OrreryPolicyModule.InvalidSignerConsent.selector)
        );
        // signed for a different policy
        bytes memory otherPolicy = _consent(address(account), agentId, signer, _policy(1, 2, 2));
        _opExpectRevert(
            abi.encodeCall(OrreryPolicyModule.openSession, (agentId, signer, p, otherPolicy)),
            abi.encodeWithSelector(OrreryPolicyModule.InvalidSignerConsent.selector)
        );
        _open(p);
    }

    function test_new_forbidden_selectors() public view {
        bytes4[12] memory sels = [
            bytes4(0xfa6e671d), 0xec6cb13f, 0x110496e5, 0xeecea000, 0x558a7297, 0x426a8493, 0xd73dd623, 0x8fcbaf0c,
            0x959b8c3f, 0xcae9ca51, 0x4000aea0, 0xbeaeb388
        ];
        for (uint256 i; i < sels.length; ++i) assertTrue(module.isForbiddenSelector(sels[i]));
    }

    function test_topUp_checks_the_account_side_too() public {
        SenderTaxToken stx = new SenderTaxToken();
        stx.mint(address(account), 1e18);
        address s2 = _signer("s2");
        vm.prank(operator);
        uint256 a2 = registry.register(operator);
        vm.prank(operator);
        registry.setAgentWallet(a2, address(account));
        OrreryPolicyModule.Policy memory p = _policy(1, 1, 1);
        p.caps[0] = _cap(address(stx), 1e17, 1e17, 1e17);
        _op(_openCall(a2, s2, p));
        vm.prank(s2);
        vm.expectRevert(OrreryPolicyModule.InexactTransfer.selector);
        module.topUp(address(stx), 1e16);
    }

    function test_payVerification_pins_owner() public {
        address payer = makeAddr("payer");
        usdg.mint(payer, 10e6);
        vm.prank(payer);
        usdg.approve(address(attestor), type(uint256).max);
        vm.prank(payer);
        vm.expectRevert(OrreryAttestor.OwnerChanged.selector);
        attestor.payVerification(agentId, makeAddr("someoneElse"), 5e6);
    }

    function test_lens_hides_stale_attestations() public {
        address attester = makeAddr("attester");
        address payer = makeAddr("payer");
        usdg.mint(payer, 10e6);
        vm.prank(payer);
        usdg.approve(address(attestor), type(uint256).max);
        vm.prank(adminWallet);
        attestor.setAttester(attester, true);
        _openDefault();
        vm.prank(payer);
        attestor.payVerification(agentId, operator, 5e6);
        OrreryAttestor.Attestation memory a;
        a.observedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + 1 days);
        a.endpointsLive = true;
        vm.prank(attester);
        attestor.attest(agentId, a);
        assertTrue(lens.checkBySigner(signer).attestation.endpointsLive);
        // removed attester: hidden
        vm.prank(adminWallet);
        attestor.setAttester(attester, false);
        assertFalse(lens.checkBySigner(signer).attestation.endpointsLive);
        vm.prank(adminWallet);
        attestor.setAttester(attester, true);
        // expired: hidden
        vm.warp(block.timestamp + 1 days);
        assertFalse(lens.checkBySigner(signer).attestation.endpointsLive);
    }

    function test_lens_paused_and_expired_reads_expired() public {
        _openDefault();
        _op(abi.encodeCall(OrreryPolicyModule.pause, (agentId)));
        vm.warp(block.timestamp + 31 days);
        assertEq(uint8(lens.checkBySigner(signer).status), uint8(OrreryLens.EffectiveStatus.Expired));
    }

    function test_lens_replaced_signer_shows_no_new_session_data() public {
        _openDefault();
        _op(abi.encodeCall(OrreryPolicyModule.revoke, (agentId)));
        _op(_openCall(agentId, _signer("s2"), _policy(5e6, 40e6, 10e6)));
        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertEq(uint8(v.status), uint8(OrreryLens.EffectiveStatus.Revoked));
        assertEq(v.caps.length, 0);
        assertEq(v.policyHash, bytes32(0));
    }

    function test_lens_reports_signer_code() public {
        _openDefault();
        vm.etch(signer, hex"00");
        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertTrue(v.signerHasCode);
        assertEq(v.validFor, block.timestamp);
    }
}
