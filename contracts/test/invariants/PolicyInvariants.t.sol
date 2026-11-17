// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {IIdentityRegistry} from "../../src/interfaces/IExternal.sol";
import {MockIdentityRegistry, MockERC20, MockAccount7579, MockTarget} from "../mocks/Mocks.sol";
import {Handler} from "./Handler.sol";

contract PolicyInvariants is StdInvariant, Test {
    OrreryPolicyModule module;
    MockIdentityRegistry registry;
    MockERC20 usdg;
    MockERC20 weth;
    MockAccount7579 account;
    MockTarget target;
    Handler handler;
    address operator = makeAddr("operator");
    uint256[3] ids;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new MockIdentityRegistry();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        module = new OrreryPolicyModule(
            IIdentityRegistry(address(registry)), makeAddr("attestor"), makeAddr("permit2"), makeAddr("ep07"),
            makeAddr("ep08"), makeAddr("adapter")
        );
        account = new MockAccount7579(operator);
        target = new MockTarget();
        usdg.mint(address(account), 1e15);
        weth.mint(address(account), 1e24);
        vm.startPrank(operator);
        for (uint256 i; i < 3; ++i) {
            ids[i] = registry.register(operator);
            registry.setAgentWallet(ids[i], address(account));
        }
        account.installModule(2, address(module), "");
        account.execute(address(usdg), 0, abi.encodeWithSignature("approve(address,uint256)", address(target), type(uint256).max));
        account.execute(address(weth), 0, abi.encodeWithSignature("approve(address,uint256)", address(target), type(uint256).max));
        vm.stopPrank();

        handler = new Handler(module, registry, usdg, weth, account, target, operator, ids);

        bytes4[] memory sel = new bytes4[](22);
        uint256 k;
        // weights by repetition
        sel[k++] = Handler.open.selector;
        sel[k++] = Handler.open.selector;
        sel[k++] = Handler.open.selector;
        sel[k++] = Handler.topUp.selector;
        sel[k++] = Handler.topUp.selector;
        sel[k++] = Handler.topUp.selector;
        sel[k++] = Handler.topUp.selector;
        sel[k++] = Handler.execute.selector;
        sel[k++] = Handler.execute.selector;
        sel[k++] = Handler.execute.selector;
        sel[k++] = Handler.spendFloat.selector;
        sel[k++] = Handler.spendFloat.selector;
        sel[k++] = Handler.decrease.selector;
        sel[k++] = Handler.dropTokenAttempt.selector;
        sel[k++] = Handler.propose.selector;
        sel[k++] = Handler.applyIncrease.selector;
        sel[k++] = Handler.cancel.selector;
        sel[k++] = Handler.pauseToggle.selector;
        sel[k++] = Handler.revoke.selector;
        sel[k++] = Handler.reinstall.selector;
        sel[k++] = Handler.ensureInstalled.selector;
        sel[k++] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------ invariants

    function invariant_flags() public view {
        assertFalse(handler.flagOverPerTx(), "A2 per-tx");
        assertFalse(handler.flagOverPerDay(), "A1 per-day");
        assertFalse(handler.flagFloat(), "A3 float");
        assertFalse(handler.flagSignerReused(), "S4 signer reuse");
        assertFalse(handler.flagRevokedRevived(), "S1 revoked revived");
        assertFalse(handler.flagEarlyIncrease(), "P1 early increase");
        assertFalse(handler.flagInactiveSpent(), "S2 inactive spent");
        assertFalse(handler.flagTokenDropped(), "A9 token dropped");
        assertFalse(handler.flagAllowanceRaised(), "A8 allowance");
    }

    /// A1 + A4: recorded spend equals the outflow agent calls caused, for every agent, token and touched day.
    function invariant_spentEqualsOutflow() public view {
        uint256 nd = handler.touchedDayCount();
        address[2] memory toks = [address(usdg), address(weth)];
        for (uint256 d; d < nd; ++d) {
            uint256 day = handler.touchedDays(d);
            for (uint256 i; i < 3; ++i) {
                for (uint256 t; t < 2; ++t) {
                    assertEq(module.spentOn(address(account), ids[i], toks[t], day), handler.ghostOut(ids[i], toks[t], day), "A1 ghost");
                }
            }
        }
    }

    /// A7: the module never holds funds.
    function invariant_moduleHoldsNothing() public view {
        assertEq(usdg.balanceOf(address(module)), 0);
        assertEq(weth.balanceOf(address(module)), 0);
        assertEq(address(module).balance, 0);
    }

    /// P5 + P6: every stored policy is valid and matches its hash.
    function invariant_storedPoliciesValid() public view {
        for (uint256 i; i < 3; ++i) {
            OrreryPolicyModule.Session memory s = module.getSession(address(account), ids[i]);
            if (s.signer == address(0)) continue;
            OrreryPolicyModule.Policy memory p = module.getPolicy(address(account), ids[i]);
            assertEq(keccak256(abi.encode(p)), s.policyHash, "P6 hash");
            assertGt(p.caps.length, 0);
            for (uint256 c; c < p.caps.length; ++c) {
                assertLe(p.caps[c].perTx, p.caps[c].perDay, "P5 perTx");
                assertLe(p.caps[c].floatMax, p.caps[c].perDay, "P5 float");
            }
            for (uint256 t; t < p.targets.length; ++t) {
                assertFalse(module.isForbiddenSelector(p.targets[t].selector), "P5 selector");
            }
            assertGe(p.increaseDelay, 1 hours);
        }
    }

    // ------------------------------------------------------------------ deterministic deep run

    function test_deepRun() public {
        uint256 seed = 0xC0FFEE;
        for (uint256 n; n < 4000; ++n) {
            seed = uint256(keccak256(abi.encode(seed, n)));
            uint256 a = seed % 100;
            uint256 x = seed >> 8;
            if (a < 10) handler.open(x, (x >> 3) % 2 == 0, (x >> 5) % 10 == 0);
            else if (a < 32) handler.topUp(x, x >> 40, (x >> 7) % 5 == 0);
            else if (a < 48) handler.execute(x, x >> 40, (x >> 9) % 3 == 0);
            else if (a < 58) handler.spendFloat(x);
            else if (a < 63) handler.decrease(x);
            else if (a < 65) handler.dropTokenAttempt(x);
            else if (a < 71) handler.propose(x);
            else if (a < 77) handler.applyIncrease(x);
            else if (a < 79) handler.cancel(x);
            else if (a < 82) handler.pauseToggle(x);
            else if (a < 85) handler.revoke(x);
            else if (a < 87) handler.reinstall(x);
            else if (a < 90) handler.ensureInstalled();
            else if (a < 91) handler.transferIdentity(x);
            else handler.warp(x);
        }
        invariant_flags();
        invariant_spentEqualsOutflow();
        invariant_moduleHoldsNothing();
        invariant_storedPoliciesValid();

        console2.log("open", handler.nOpen());
        console2.log("topUp", handler.nTopUp());
        console2.log("execute", handler.nExecute());
        console2.log("decrease", handler.nDecrease());
        console2.log("propose", handler.nPropose());
        console2.log("apply", handler.nApply());
        console2.log("revoke", handler.nRevoke());
        console2.log("pause", handler.nPause());
        console2.log("uninstall", handler.nUninstall());
        console2.log("identityTransfer", handler.nTransfer());
        console2.log("reverted", handler.nRevert());
        console2.log("days", handler.touchedDayCount());
        assertGt(handler.nOpen(), 20);
        assertGt(handler.nTopUp(), 50);
        assertGt(handler.nExecute(), 50);
        assertGt(handler.nDecrease(), 5);
        assertGt(handler.nApply(), 5);
        assertGt(handler.nRevoke(), 5);
        assertGt(handler.nUninstall(), 5);
        assertGt(handler.touchedDayCount(), 3);
    }
}
