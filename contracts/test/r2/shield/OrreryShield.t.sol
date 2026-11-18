// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {ShieldBase} from "./ShieldBase.sol";
import {OrreryShield} from "../../../src/markets/r2/shield/OrreryShield.sol";
import {IOrreryShield} from "../../../src/markets/r2/interfaces/IShield.sol";
import {FeeOnTransferToken} from "../../mocks/Mocks.sol";
import {FalseVerifier} from "../utils/R2Mocks.sol";
import {ShieldFixtureAddresses as A, ShieldFixture31337 as F} from "./ShieldFixture.sol";

/// @notice Unit tests of OrreryShield with real UltraHonk proofs (`docs/updates/L3-R2-SPEC.md` 6, SH-1 to SH-5).
contract OrreryShieldTest is ShieldBase {
    uint256 internal constant U = 1e6;

    function _held() internal view returns (uint256) {
        return usdg.balanceOf(A.POOL);
    }

    // ------------------------------------------------------------------ setup facts

    function test_domain_and_constants() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Orrery Shield"),
                keccak256("1"),
                block.chainid,
                A.POOL
            )
        );
        assertEq(shield.DOMAIN_SEPARATOR(), domain);
        assertEq(shield.asset(), A.USDG);
        assertEq(shield.verifier(), address(verifier));
        assertEq(shield.treasury(), treasury);
        assertEq(shield.depositFeeBps(), 50);
        assertEq(shield.withdrawFeeBps(), 50);
        assertEq(shield.MAX_FEE_BPS(), 100);
        assertEq(shield.DEPTH(), 20);
        (uint256 npk, bytes memory vk) = shield.accountOf(A.ALICE);
        assertEq(npk, F.ALICE_NPK);
        assertEq(vk, F.aliceViewKey());
    }

    /// EIP-170 and EIP-3860: the pool and the verifier deploy on a chain that enforces both limits.
    function test_code_fits_the_size_limits() public view {
        assertLe(A.POOL.code.length, 24_576, "shield runtime");
        assertLe(type(OrreryShield).creationCode.length, 49_152, "shield initcode");
        assertLe(address(verifier).code.length, 24_576, "verifier runtime");
        console2.log("shield runtime bytes", A.POOL.code.length);
        console2.log("verifier runtime bytes", address(verifier).code.length);
    }

    function test_constructor_checks() public {
        vm.expectRevert(bytes("fee"));
        new OrreryShield(address(verifier), A.USDG, treasury, address(tiers), 101, 50);
        vm.expectRevert(bytes("fee"));
        new OrreryShield(address(verifier), A.USDG, treasury, address(tiers), 50, 101);
        vm.expectRevert(bytes("zero address"));
        new OrreryShield(address(0), A.USDG, treasury, address(tiers), 50, 50);
        vm.expectRevert(bytes("zero address"));
        new OrreryShield(address(verifier), A.USDG, address(0), address(tiers), 50, 50);
    }

    // ------------------------------------------------------------------ deposits

    function test_deposit_inserted_at_once_with_the_fee_taken() public view {
        assertEq(shield.nextLeafIndex(), 1);
        assertEq(shield.accruedFees(), 5 * U, "0.5% of 1,000 USDG");
        assertEq(_held(), 1_000 * U);
        assertTrue(shield.knownRoots(shield.currentRoot()));
    }

    function test_deposit_event_and_commitment() public {
        uint256 sc = 0x1234;
        uint256 net = 100 * U - 0.5e6;
        vm.expectEmit(A.POOL);
        emit IOrreryShield.Deposited(A.ALICE, 100 * U, 0.5e6, sc, shield.noteCommitment(net, sc), 1, hex"aa");
        vm.prank(A.ALICE);
        assertEq(shield.deposit(100 * U, sc, hex"aa"), 1);
    }

    function test_staker_discount_lowers_the_deposit_fee() public {
        tiers.set(A.ALICE, 5000);
        uint256 fees = shield.accruedFees();
        vm.prank(A.ALICE);
        shield.deposit(100 * U, 0x99, "");
        assertEq(shield.accruedFees() - fees, 0.25e6, "0.5% less 50%");
        assertEq(shield.depositFee(A.ALICE, 100 * U), 0.25e6);
        tiers.setReverts(true);
        assertEq(shield.depositFee(A.ALICE, 100 * U), 0.5e6, "unreadable tiers charge the full fee");
    }

    function test_deposit_checks() public {
        uint256 field = shield.FIELD_SIZE();
        vm.startPrank(A.ALICE);
        vm.expectRevert(IOrreryShield.BadAmount.selector);
        shield.deposit(0, 1, "");
        vm.expectRevert(IOrreryShield.BadAmount.selector);
        shield.deposit(uint256(type(uint128).max) + 1, 1, "");
        vm.expectRevert(IOrreryShield.NotField.selector);
        shield.deposit(1 * U, 0, "");
        vm.expectRevert(IOrreryShield.NotField.selector);
        shield.deposit(1 * U, field, "");
        vm.expectRevert(IOrreryShield.NoteTooLarge.selector);
        shield.deposit(1 * U, 1, new bytes(1025));
        shield.deposit(1 * U, field - 1, new bytes(1024)); // the bounds themselves pass
        vm.stopPrank();
        address poor = makeAddr("poor");
        vm.prank(poor);
        vm.expectRevert(IOrreryShield.InexactTransfer.selector);
        shield.deposit(1 * U, 1, "");
    }

    function test_fee_on_transfer_asset_is_refused() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        OrreryShield s2 = new OrreryShield(address(verifier), address(fot), treasury, address(tiers), 50, 50);
        fot.mint(A.ALICE, 100e18);
        vm.startPrank(A.ALICE);
        fot.approve(address(s2), type(uint256).max);
        vm.expectRevert(IOrreryShield.InexactTransfer.selector);
        s2.deposit(1e18, 1, "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ accounts

    function test_register_checks() public {
        vm.prank(A.ALICE);
        vm.expectRevert(IOrreryShield.AlreadyRegistered.selector);
        shield.register(1, F.aliceViewKey());
        address c = makeAddr("c");
        vm.startPrank(c);
        vm.expectRevert(IOrreryShield.BadKey.selector);
        shield.register(0, F.aliceViewKey());
        uint256 field = shield.FIELD_SIZE();
        vm.expectRevert(IOrreryShield.BadKey.selector);
        shield.register(field, F.aliceViewKey());
        vm.expectRevert(IOrreryShield.BadKey.selector);
        shield.register(1, hex"04");
        bytes memory bad = F.aliceViewKey();
        bad[0] = 0x04;
        vm.expectRevert(IOrreryShield.BadKey.selector);
        shield.register(1, bad);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ transact with real proofs

    function test_send_withdraw_and_withdraw_with_real_proofs() public {
        uint256 g = gasleft();
        _run(F.send());
        console2.log("transact gas, a private send with its proof", g - gasleft());
        assertEq(usdg.balanceOf(A.RELAYER), 1 * U, "relayer fee");
        assertEq(shield.nextLeafIndex(), 3, "two outputs inserted");

        _run(F.withdraw());
        assertEq(usdg.balanceOf(A.CAROL), 500 * U, "withdrawn to any address");
        assertEq(shield.accruedFees(), 5 * U + 2.5e6, "deposit fee plus the 0.5% withdrawal fee");

        _run(F.bobWithdraw());
        assertEq(usdg.balanceOf(A.BOB), 200 * U);
        assertEq(usdg.balanceOf(A.RELAYER), 3 * U);
        // SH-1: the pool holds every unspent note and the fees
        assertEq(_held(), F.ALICE_BALANCE_AFTER + F.BOB_BALANCE_AFTER + shield.accruedFees() + 0);
        assertGt(F.ALICE_BALANCE_AFTER, 0);
    }

    function test_full_exit_leaves_no_outputs() public {
        _run(F.send());
        _run(F.withdraw());
        uint32 leaves = shield.nextLeafIndex();
        _run(F.bobExit());
        assertEq(shield.nextLeafIndex(), leaves, "both outputs omitted");
        (IOrreryShield.TxArgs memory a,) = _decode(F.bobExit());
        assertEq(usdg.balanceOf(A.BOB), a.withdrawAmount);
        assertEq(a.withdrawAmount + a.protocolFee + a.fee, 300 * U, "Bob's whole balance left");
    }

    function test_replays_are_refused() public {
        _run(F.send());
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.send());
        vm.expectRevert(IOrreryShield.NullifierSpent.selector);
        shield.transact(a, e);
        _run(F.withdraw());
        _run(F.bobWithdraw());
        // the exit spends the same note as Bob's withdrawal
        (a, e) = _decode(F.bobExit());
        vm.expectRevert(IOrreryShield.NullifierSpent.selector);
        shield.transact(a, e);
    }

    function test_tampered_inputs_fail_the_proof() public {
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.withdraw());
        _run(F.send());
        a.withdrawAmount += 1;
        vm.expectRevert(IOrreryShield.InvalidProof.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.withdraw());
        a.withdrawTo = makeAddr("thief");
        vm.expectRevert(IOrreryShield.InvalidProof.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.withdraw());
        e.relayer = makeAddr("otherRelayer"); // bound through extDataHash
        vm.expectRevert(IOrreryShield.InvalidProof.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.withdraw());
        a.intentNullifier += 1;
        vm.expectRevert(IOrreryShield.InvalidProof.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.withdraw());
        a.proof[100] = a.proof[100] ^ 0x01;
        vm.expectRevert(IOrreryShield.InvalidProof.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.withdraw());
        shield.transact(a, e); // the untouched one still passes
    }

    function test_shape_checks_before_the_proof() public {
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.send());
        a.asset = address(1);
        vm.expectRevert(IOrreryShield.WrongAsset.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.send());
        a.kind = 3;
        vm.expectRevert(IOrreryShield.BadKind.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.send());
        a.protocolFee = 1;
        vm.expectRevert(IOrreryShield.BadWithdraw.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.send());
        a.withdrawAmount = 1;
        vm.expectRevert(IOrreryShield.BadWithdraw.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.send());
        a.withdrawTo = address(1);
        vm.expectRevert(IOrreryShield.BadWithdraw.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.send());
        a.root = 12345;
        vm.expectRevert(IOrreryShield.UnknownRoot.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.send());
        e.encryptedOutput0 = new bytes(1025);
        vm.expectRevert(IOrreryShield.NoteTooLarge.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.send());
        a.outCommitments[1] = shield.FIELD_SIZE();
        vm.expectRevert(IOrreryShield.NotField.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.withdraw());
        a.withdrawTo = address(0);
        vm.expectRevert(IOrreryShield.BadWithdraw.selector);
        shield.transact(a, e);
        (a, e) = _decode(F.withdraw());
        a.withdrawAmount = 0;
        vm.expectRevert(IOrreryShield.BadWithdraw.selector);
        shield.transact(a, e);
    }

    function test_used_intent_is_refused() public {
        _run(F.send());
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.send());
        // fresh nullifiers would fail the proof anyway; the intent check comes first
        a.nullifiers[0] = 7;
        a.nullifiers[1] = 8;
        vm.expectRevert(IOrreryShield.IntentUsed.selector);
        shield.transact(a, e);
    }

    function test_protocol_fee_floor_follows_the_pool_and_the_recipient_tier() public {
        _run(F.send());
        // the same pool code redeployed in place charging 1% (its storage stays): the proof's 0.5% fee is too low
        _deployShield(50, 100);
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.withdraw());
        assertEq(shield.withdrawFeeFloor(A.CAROL, 500 * U), 5e6);
        vm.expectRevert(IOrreryShield.FeeTooLow.selector);
        shield.transact(a, e);
        // half off for the recipient brings the floor back to 0.5%, and the same proof passes
        tiers.set(A.CAROL, 5000);
        assertEq(shield.withdrawFeeFloor(A.CAROL, 500 * U), 2.5e6);
        shield.transact(a, e);
        assertEq(usdg.balanceOf(A.CAROL), 500 * U);
    }

    function test_frozen_recipient_moves_nothing() public {
        _run(F.send());
        usdg.setFrozen(A.CAROL, true);
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.withdraw());
        vm.expectRevert(IOrreryShield.InexactTransfer.selector);
        shield.transact(a, e);
        assertFalse(shield.nullifierSpent(a.nullifiers[0]), "nothing spent");
        usdg.setFrozen(A.CAROL, false);
        shield.transact(a, e);
    }

    function test_relayer_fee_goes_to_the_named_relayer() public {
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.send());
        assertEq(e.relayer, A.RELAYER);
        shield.transact(a, e);
        assertEq(usdg.balanceOf(A.RELAYER), 1 * U);
    }

    function test_deposit_fee_rounds_down() public {
        assertEq(shield.depositFee(A.ALICE, 199), 0);
        assertEq(shield.depositFee(A.ALICE, 1_000_001), 5000, "5000.005 rounds down");
        assertEq(shield.withdrawFeeFloor(A.CAROL, 1_000_001), 5000);
    }

    function test_a_verifier_answering_false_is_refused() public {
        deployCodeTo(
            "OrreryShield.sol:OrreryShield",
            abi.encode(address(new FalseVerifier()), A.USDG, treasury, address(tiers), uint16(50), uint16(50)),
            A.POOL
        );
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(F.send());
        vm.expectRevert(IOrreryShield.InvalidProof.selector);
        shield.transact(a, e);
    }

    /// The tree takes 2^20 leaves: the last one fits, the next deposit is refused (index set in storage, slot 42).
    function test_tree_full() public {
        vm.store(A.POOL, bytes32(uint256(42)), bytes32(uint256((1 << 20) - 1)));
        vm.prank(A.ALICE);
        assertEq(shield.deposit(1 * U, 1, ""), (1 << 20) - 1);
        vm.prank(A.ALICE);
        vm.expectRevert(IOrreryShield.TreeFull.selector);
        shield.deposit(1 * U, 1, "");
    }

    // ------------------------------------------------------------------ fees

    function test_flush_fees_to_the_treasury() public {
        _run(F.send());
        _run(F.withdraw());
        uint256 fees = shield.accruedFees();
        vm.expectEmit(A.POOL);
        emit IOrreryShield.FeesFlushed(treasury, fees);
        assertEq(shield.flushFees(), fees);
        assertEq(usdg.balanceOf(treasury), fees);
        assertEq(shield.accruedFees(), 0);
        vm.expectRevert(IOrreryShield.NothingToFlush.selector);
        shield.flushFees();
        // withdrawals still work after a flush (SH-5)
        _run(F.bobWithdraw());
    }
}
