// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {HonkVerifier} from "../../../src/markets/r2/shield/verifier/HonkVerifier.sol";
import {OrreryShield} from "../../../src/markets/r2/shield/OrreryShield.sol";
import {IOrreryShield} from "../../../src/markets/r2/interfaces/IShield.sol";
import {FeeTiers} from "../../../src/markets/FeeTiers.sol";
import {OrryPriceOracle} from "../../../src/markets/OrryPriceOracle.sol";
import {MockEarningStaking, OracleHookStandIn} from "../../markets/utils/MarketMocks.sol";
import {ShieldFixtureAddresses as A, ShieldFixture4663 as F} from "../shield/ShieldFixture.sol";

interface IUsdgF {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Shield V2 on a fork of Robinhood Chain 4663 with the real USDG (Paxos, 6 decimals) and real proofs made for
/// chain 4663 and the pool's fixed address (`services/scripts/r2-shield-fixture.ts`): deposit, private send, withdrawal
/// to a third address, a second withdrawal, fees flushed to the treasury, and the real fee tiers read through the R1 price
/// oracle on the real Chainlink ETH/USD feed.
/// Run: heavy forge test --match-path 'test/r2/fork/ShieldFork.t.sol' --fork-url <4663 RPC> --fork-block-number <head - 20> -vv
contract ShieldForkTest is Test {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    OrreryShield internal shield;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        OracleHookStandIn hook = new OracleHookStandIn();
        hook.set(138200, block.timestamp - 3 days);
        uint256[] memory mins = new uint256[](2);
        uint16[] memory ds = new uint16[](2);
        (mins[0], mins[1], ds[0], ds[1]) = (100e6, 1_000e6, 2500, 5000);
        FeeTiers tiers = new FeeTiers(
            address(new MockEarningStaking()), address(new OrryPriceOracle(address(hook), A.USDG, ETH_USD_FEED, 25 hours)), mins, ds
        );
        HonkVerifier verifier = new HonkVerifier();
        deployCodeTo(
            "OrreryShield.sol:OrreryShield", abi.encode(address(verifier), A.USDG, treasury, address(tiers), 50, 50), A.POOL
        );
        shield = OrreryShield(A.POOL);
        vm.prank(A.ALICE);
        shield.register(F.ALICE_NPK, F.aliceViewKey());
        vm.prank(A.BOB);
        shield.register(F.BOB_NPK, F.bobViewKey());
        deal(A.USDG, A.ALICE, 10_000e6);
        vm.prank(A.ALICE);
        IUsdgF(A.USDG).approve(A.POOL, type(uint256).max);
    }

    function _run(bytes memory data) internal returns (uint256 gasUsed) {
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) =
            abi.decode(data, (IOrreryShield.TxArgs, IOrreryShield.ExtData));
        uint256 g = gasleft();
        shield.transact(a, e);
        gasUsed = g - gasleft();
    }

    function test_fork_shield_with_real_usdg_and_real_proofs() public {
        vm.prank(A.ALICE);
        shield.deposit(A.DEPOSIT_AMOUNT, F.DEPOSIT_SECRET_COMMIT, F.depositNote());
        assertEq(IUsdgF(A.USDG).balanceOf(A.POOL), 1_000e6);
        console2.log("send gas", _run(F.send()));
        console2.log("withdraw gas", _run(F.withdraw()));
        assertEq(IUsdgF(A.USDG).balanceOf(A.CAROL), 500e6, "real USDG withdrawn to a third address");
        _run(F.bobWithdraw());
        assertEq(IUsdgF(A.USDG).balanceOf(A.BOB), 200e6);
        assertEq(IUsdgF(A.USDG).balanceOf(A.RELAYER), 3e6);
        uint256 fees = shield.accruedFees();
        assertEq(fees, 5e6 + 2.5e6 + 1e6, "deposit fee and both withdrawal fees");
        assertEq(IUsdgF(A.USDG).balanceOf(A.POOL), F.ALICE_BALANCE_AFTER + F.BOB_BALANCE_AFTER + fees, "SH-1");
        shield.flushFees();
        assertEq(IUsdgF(A.USDG).balanceOf(treasury), fees);
    }

    function test_fork_tampered_proof_is_refused() public {
        vm.prank(A.ALICE);
        shield.deposit(A.DEPOSIT_AMOUNT, F.DEPOSIT_SECRET_COMMIT, F.depositNote());
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) =
            abi.decode(F.send(), (IOrreryShield.TxArgs, IOrreryShield.ExtData));
        a.proof[200] ^= 0x01;
        vm.expectRevert(IOrreryShield.InvalidProof.selector);
        shield.transact(a, e);
    }
}
