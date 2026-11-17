// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "../unit/Base.t.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {OrreryLens} from "../../src/OrreryLens.sol";
import {MockAccount7579, MockERC20} from "../mocks/Mocks.sol";

/// @dev Balancer-Vault-shaped contract: a sender may approve a relayer, which can then move the sender's tokens that
///      the sender approved to the vault. Same shape: CoW setPreSignature, Comet allow, Morpho setAuthorization,
///      ERC-6909 setOperator, Safe AllowanceModule setAllowance.
contract RelayerVault {
    mapping(address => mapping(address => bool)) public relayerOk;

    function setRelayerApproval(address sender, address relayer, bool ok) external {
        require(msg.sender == sender, "sender");
        relayerOk[sender][relayer] = ok;
    }

    function pullAs(address sender, address token, address to, uint256 amount) external {
        require(relayerOk[sender][msg.sender], "relayer");
        MockERC20(token).transferFrom(sender, to, amount);
    }
}

contract MediumFindingsReview is Base {
    /// R-02: openSession binds any EOA as signer without its consent; the first account to name an address owns it
    /// forever (S4), and checkBySigner attributes that address to the squatter's account and agent.
    function test_R02_signer_squatting_without_consent() public {
        address attackerOp = makeAddr("attackerOp");
        MockAccount7579 evil = new MockAccount7579(attackerOp);
        vm.prank(attackerOp);
        uint256 evilAgent = registry.register(attackerOp);
        vm.prank(attackerOp);
        registry.setAgentWallet(evilAgent, address(evil));
        vm.prank(attackerOp);
        evil.execute(address(evil), 0, abi.encodeWithSignature("installModule(uint256,address,bytes)", 2, address(module), ""));
        // the victim's hot wallet `signer` is public (it was funded for gas, or already pays via x402)
        // fixed: without the signer's consent the squatter cannot bind the address
        vm.prank(attackerOp);
        vm.expectRevert(OrreryPolicyModule.InvalidSignerConsent.selector);
        evil.execute(address(module), 0, abi.encodeCall(OrreryPolicyModule.openSession, (evilAgent, signer, _policy(1, 1, 1), bytes(""))));
        // nor reuse a consent the signer gave to its own operator's account
        bytes memory ownConsent = _consent(address(account), agentId, signer, _policy(1, 1, 1));
        vm.prank(attackerOp);
        vm.expectRevert(OrreryPolicyModule.InvalidSignerConsent.selector);
        evil.execute(address(module), 0, abi.encodeCall(OrreryPolicyModule.openSession, (evilAgent, signer, _policy(1, 1, 1), ownConsent)));

        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertEq(v.account, address(0), "the victim's paying address resolves to nothing");

        bytes memory call_ = abi.encodeCall(
            MockAccount7579.execute, (address(module), 0, _openCall(agentId, signer, _policy(10e6, 50e6, 20e6)))
        );
        vm.prank(operator);
        (bool ok,) = address(account).call(call_);
        assertTrue(ok, "operator can no longer open a session for its own signer (SignerUsed)");
    }

    /// R-03: after an identity transfer and a new payment, the lens still serves the previous owner's unexpired
    /// attestation next to verified=true, and the view has no paidAt to tell (B2).
    function test_R03_lens_serves_previous_owner_attestation() public {
        address payer = makeAddr("payer");
        address attester = makeAddr("attester");
        usdg.mint(payer, 100e6);
        vm.prank(payer);
        usdg.approve(address(attestor), type(uint256).max);
        vm.prank(adminWallet);
        attestor.setAttester(attester, true);
        _openDefault();

        vm.prank(payer);
        attestor.payVerification(agentId, operator, 5e6);
        OrreryAttestor.Attestation memory a;
        a.observedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + 7 days);
        a.endpointsLive = true;
        a.domainVerified = true;
        vm.prank(attester);
        attestor.attest(agentId, a);

        vm.prank(operator);
        registry.transferFrom(operator, makeAddr("buyer"), agentId);
        vm.warp(block.timestamp + 1 days);
        vm.prank(payer);
        attestor.payVerification(agentId, makeAddr("buyer"), 5e6);

        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        uint64 paidAt = attestor.getVerification(agentId).paidAt;
        assertTrue(v.verified);
        assertEq(v.paidAt, paidAt);
        // fixed: the previous owner's attestation is deleted on payment and never shown
        assertEq(v.attestation.observedAt, 0, "no attestation of the previous owner");
        assertFalse(v.attestation.endpointsLive);
    }

    /// R-04: the forbidden-selector denylist misses grants made through contracts that already hold an allowance on a
    /// capped token. One allowlisted call grants the signer a relayer right; the signer then pulls past perDay
    /// outside `execute`, with nothing recorded (A4, A8).
    function test_R04_deferred_pull_via_relayer_grant() public {
        RelayerVault vault = new RelayerVault();
        // ordinary DeFi setup by the operator: the account approved the vault for USDG
        vm.prank(operator);
        account.execute(address(usdg), 0, abi.encodeCall(MockERC20.approve, (address(vault), type(uint256).max)));

        OrreryPolicyModule.Policy memory p = _policyWithTarget(RelayerVault.setRelayerApproval.selector);
        p.targets[0].target = address(vault);
        _opExpectRevert(
            _openCall(agentId, signer, p),
            abi.encodeWithSelector(OrreryPolicyModule.ForbiddenSelector.selector, RelayerVault.setRelayerApproval.selector)
        );

        // fixed: setRelayerApproval is a forbidden selector, so the policy cannot allowlist it
        assertTrue(module.isForbiddenSelector(RelayerVault.setRelayerApproval.selector));
        assertEq(module.getSession(address(account), agentId).signer, address(0), "session was refused");
    }

    /// R-05: P4 says validFor is never later than the earliest moment the signer's authority can rise. A Paused
    /// session reports validFor = now + increaseDelay, yet unpause restores full authority in the same block.
    function test_R05_validFor_ignores_instant_unpause() public {
        _openDefault();
        _op(abi.encodeCall(OrreryPolicyModule.pause, (agentId)));
        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        _op(abi.encodeCall(OrreryPolicyModule.unpause, (agentId)));
        vm.prank(signer);
        module.topUp(address(usdg), 10e6); // authority rose at t = now
        assertLe(v.validFor, block.timestamp, "validFor promised an hour, authority rose in the same block");
    }
}
