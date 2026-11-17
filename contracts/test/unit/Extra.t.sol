// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../src/interfaces/IExternal.sol";
import {LeakyAccount7579, MockTarget, FeeOnTransferToken} from "../mocks/Mocks.sol";

contract ExtraTest is Base {
    /// A10: native leaving the account during `execute` reverts when native is not capped.
    function test_native_outflow_refused_when_native_not_capped() public {
        LeakyAccount7579 leaky = new LeakyAccount7579(operator);
        vm.deal(address(leaky), 1 ether);
        vm.prank(operator);
        uint256 id = registry.register(operator);
        vm.prank(operator);
        registry.setAgentWallet(id, address(leaky));
        vm.startPrank(operator);
        leaky.execute(address(leaky), 0, abi.encodeWithSignature("installModule(uint256,address,bytes)", 2, address(module), ""));
        address s = _signer("leakySigner");
        leaky.execute(address(module), 0, _openCallFor(address(leaky), id, s, _policyWithTarget(MockTarget.ping.selector)));
        vm.stopPrank();
        vm.prank(s);
        vm.expectRevert(OrreryPolicyModule.NativeOutflow.selector);
        module.execute(address(target), abi.encodeCall(MockTarget.ping, (1)));
    }

    /// F1: a fee token that delivers less than the fee is refused.
    function test_fee_token_must_deliver_exact_fee() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        OrreryAttestor a2 = new OrreryAttestor(IIdentityRegistry(address(registry)), IERC20Min(address(fot)), adminWallet, treasury, 5e18);
        address payer = makeAddr("payer");
        fot.mint(payer, 10e18);
        vm.startPrank(payer);
        fot.approve(address(a2), type(uint256).max);
        vm.expectRevert(OrreryAttestor.InexactTransfer.selector);
        a2.payVerification(agentId, operator, 5e18);
        vm.stopPrank();
    }
}
