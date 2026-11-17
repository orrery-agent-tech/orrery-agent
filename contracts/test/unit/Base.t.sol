// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {OrreryLens} from "../../src/OrreryLens.sol";
import {IIdentityRegistry, IERC20Min} from "../../src/interfaces/IExternal.sol";
import {MockIdentityRegistry, MockERC20, MockAccount7579, MockTarget} from "../mocks/Mocks.sol";

abstract contract Base is Test {
    OrreryPolicyModule module;
    OrreryAttestor attestor;
    OrreryLens lens;
    MockIdentityRegistry registry;
    MockERC20 usdg;
    MockERC20 weth;
    MockAccount7579 account;
    MockTarget target;

    address operator = makeAddr("operator");
    address signer;
    mapping(address => uint256) internal keyOf;
    address treasury = makeAddr("treasury");
    address adminWallet = makeAddr("admin");
    address permit2 = makeAddr("permit2");
    address ep07 = makeAddr("ep07");
    address ep08 = makeAddr("ep08");
    address adapter = makeAddr("adapter");
    uint256 agentId;

    uint64 constant START = 1_800_000_000; // a fixed clock, kept in a variable to avoid via-IR timestamp caching

    function setUp() public virtual {
        vm.warp(START);
        signer = _signer("signer");
        registry = new MockIdentityRegistry();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        attestor = new OrreryAttestor(IIdentityRegistry(address(registry)), IERC20Min(address(usdg)), adminWallet, treasury, 5e6);
        module = new OrreryPolicyModule(IIdentityRegistry(address(registry)), address(attestor), permit2, ep07, ep08, adapter);
        lens = new OrreryLens(module, attestor, adapter, new bytes32[](0), new address[](0));
        account = new MockAccount7579(operator);
        target = new MockTarget();
        vm.deal(address(account), 10 ether);
        usdg.mint(address(account), 1_000e6);
        weth.mint(address(account), 100e18);

        vm.prank(operator);
        agentId = registry.register(operator);
        vm.prank(operator);
        registry.setAgentWallet(agentId, address(account));
        _asAccount(abi.encodeWithSignature("installModule(uint256,address,bytes)", 2, address(module), ""));
    }

    // ---------------------------------------------------------------- helpers

    function _asAccount(bytes memory call) internal returns (bytes memory) {
        vm.prank(operator);
        return account.execute(address(account), 0, call);
    }

    function _op(bytes memory moduleCall) internal returns (bytes memory) {
        vm.prank(operator);
        return account.execute(address(module), 0, moduleCall);
    }

    function _opExpectRevert(bytes memory moduleCall, bytes memory err) internal {
        vm.prank(operator);
        vm.expectRevert(err);
        account.execute(address(module), 0, moduleCall);
    }

    function _cap(address token, uint128 perTx, uint128 perDay, uint128 floatMax)
        internal
        pure
        returns (OrreryPolicyModule.TokenCap memory)
    {
        return OrreryPolicyModule.TokenCap(token, perTx, perDay, floatMax);
    }

    function _policy(uint128 perTx, uint128 perDay, uint128 floatMax) internal view returns (OrreryPolicyModule.Policy memory p) {
        p.caps = new OrreryPolicyModule.TokenCap[](1);
        p.caps[0] = _cap(address(usdg), perTx, perDay, floatMax);
        p.targets = new OrreryPolicyModule.Target[](0);
        p.validUntil = uint64(block.timestamp + 30 days);
        p.increaseDelay = 1 hours;
    }

    function _policyWithTarget(bytes4 sel) internal view returns (OrreryPolicyModule.Policy memory p) {
        p = _policy(10e6, 50e6, 20e6);
        p.targets = new OrreryPolicyModule.Target[](1);
        p.targets[0] = OrreryPolicyModule.Target(address(target), sel);
    }

    function _signer(string memory name) internal returns (address a) {
        uint256 k;
        (a, k) = makeAddrAndKey(name);
        keyOf[a] = k;
    }

    function _consent(address acct, uint256 id, address s, OrreryPolicyModule.Policy memory p)
        internal
        view
        returns (bytes memory)
    {
        uint256 k = keyOf[s];
        if (k == 0) return "";
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(k, module.consentDigest(acct, id, keccak256(abi.encode(p))));
        return abi.encodePacked(r, ss, v);
    }

    function _openCall(uint256 id, address s, OrreryPolicyModule.Policy memory p) internal view returns (bytes memory) {
        return _openCallFor(address(account), id, s, p);
    }

    function _openCallFor(address acct, uint256 id, address s, OrreryPolicyModule.Policy memory p)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(OrreryPolicyModule.openSession, (id, s, p, _consent(acct, id, s, p)));
    }

    function _open(OrreryPolicyModule.Policy memory p) internal {
        _op(_openCall(agentId, signer, p));
    }

    function _openDefault() internal {
        _open(_policy(10e6, 50e6, 20e6));
    }
}
