// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {HonkVerifier} from "../../../src/markets/r2/shield/verifier/HonkVerifier.sol";
import {OrreryShield} from "../../../src/markets/r2/shield/OrreryShield.sol";
import {IOrreryShield} from "../../../src/markets/r2/interfaces/IShield.sol";
import {MockUsdg} from "../../markets/utils/MarketMocks.sol";
import {MockFeeTiers} from "../utils/R2Mocks.sol";
import {ShieldFixtureAddresses as A, ShieldFixture31337 as F} from "./ShieldFixture.sol";

/// @notice OrreryShield at the fixture's fixed address with the real generated verifier, a USDG stand-in etched at the
/// real USDG address (the proofs commit to both addresses and to chain 31337), fee tiers that can be set per account,
/// deposit and withdrawal fees of 0.5% (the spec's guesses). Alice and Bob are registered and Alice has deposited
/// 1,000 USDG, as the proofs in `ShieldFixture.sol` expect.
abstract contract ShieldBase is Test {
    OrreryShield internal shield;
    HonkVerifier internal verifier;
    MockUsdg internal usdg;
    MockFeeTiers internal tiers;
    address internal treasury = makeAddr("treasury");

    function setUp() public virtual {
        verifier = new HonkVerifier();
        deployCodeTo("MarketMocks.sol:MockUsdg", A.USDG);
        usdg = MockUsdg(A.USDG);
        tiers = new MockFeeTiers();
        _deployShield(50, 50);
        vm.prank(A.ALICE);
        shield.register(F.ALICE_NPK, F.aliceViewKey());
        vm.prank(A.BOB);
        shield.register(F.BOB_NPK, F.bobViewKey());
        usdg.mint(A.ALICE, 10_000e6);
        vm.prank(A.ALICE);
        usdg.approve(A.POOL, type(uint256).max);
        vm.prank(A.ALICE);
        shield.deposit(A.DEPOSIT_AMOUNT, F.DEPOSIT_SECRET_COMMIT, F.depositNote());
    }

    function _deployShield(uint16 depositBps, uint16 withdrawBps) internal {
        deployCodeTo(
            "OrreryShield.sol:OrreryShield",
            abi.encode(address(verifier), A.USDG, treasury, address(tiers), depositBps, withdrawBps),
            A.POOL
        );
        shield = OrreryShield(A.POOL);
    }

    function _decode(bytes memory data) internal pure returns (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) {
        (a, e) = abi.decode(data, (IOrreryShield.TxArgs, IOrreryShield.ExtData));
    }

    function _run(bytes memory data) internal {
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(data);
        shield.transact(a, e);
    }
}
