// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ShieldBase} from "./ShieldBase.sol";
import {OrreryShield} from "../../../src/markets/r2/shield/OrreryShield.sol";
import {IOrreryShield} from "../../../src/markets/r2/interfaces/IShield.sol";
import {MockUsdg} from "../../markets/utils/MarketMocks.sol";
import {ShieldFixtureAddresses as A, ShieldFixture31337 as F} from "./ShieldFixture.sol";

/// @notice Bounded actions on the shield after Alice's send and withdrawal (real proofs): deposits, fee flushes,
/// donations, replays and tampered copies of real proofs, and Bob's last action (a withdrawal or a full exit, real
/// proofs, at most one of them can run). Ghost accounting of every USDG in and out (`docs/updates/L3-R2-SPEC.md` 6).
contract ShieldHandler is Test {
    OrreryShield internal shield;
    MockUsdg internal usdg;
    address internal treasury;
    address[] internal actors;

    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 public inserts;
    bool public bobDone;

    uint256 public nDeposits;
    uint256 public nFlushes;
    uint256 public nRefused;
    uint256 public nBob;

    constructor(OrreryShield shield_, MockUsdg usdg_, address treasury_, uint256 in_, uint256 out_, uint256 inserts_) {
        (shield, usdg, treasury, ghostIn, ghostOut, inserts) = (shield_, usdg_, treasury_, in_, out_, inserts_);
        for (uint256 i; i < 3; ++i) {
            address a = makeAddr(string(abi.encodePacked("depositor", vm.toString(i))));
            actors.push(a);
            usdg.mint(a, 100_000_000e6);
            vm.prank(a);
            usdg.approve(address(shield_), type(uint256).max);
        }
    }

    function deposit(uint256 seed, uint256 amount, uint256 sc) external {
        amount = bound(amount, 1, 100_000e6);
        sc = bound(sc, 1, shield.FIELD_SIZE() - 1);
        vm.prank(actors[seed % actors.length]);
        shield.deposit(amount, sc, "");
        ghostIn += amount;
        inserts += 1;
        ++nDeposits;
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1_000e6);
        usdg.mint(address(shield), amount);
        ghostIn += amount;
    }

    function flush() external {
        if (shield.accruedFees() == 0) return;
        uint256 got = shield.flushFees();
        ghostOut += got;
        ++nFlushes;
    }

    function _decode(bytes memory data) internal pure returns (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) {
        (a, e) = abi.decode(data, (IOrreryShield.TxArgs, IOrreryShield.ExtData));
    }

    /// @dev A spent proof, or a tampered copy of an unspent one: refused, and nothing moves.
    function refused(uint256 which, uint256 byteSeed) external {
        uint256 bal = usdg.balanceOf(address(shield));
        uint32 leaves = shield.nextLeafIndex();
        IOrreryShield.TxArgs memory a;
        IOrreryShield.ExtData memory e;
        uint256 w = which % 4;
        if (w == 0) (a, e) = _decode(F.send());
        else if (w == 1) (a, e) = _decode(F.withdraw());
        else {
            (a, e) = _decode(w == 2 ? F.bobWithdraw() : F.bobExit());
            uint256 field = byteSeed % 3;
            if (field == 0) a.proof[byteSeed % a.proof.length] ^= bytes1(uint8(1 + (byteSeed >> 8) % 255));
            else if (field == 1) a.withdrawAmount += 1 + (byteSeed >> 8) % 1e6;
            else a.fee += 1;
        }
        try shield.transact(a, e) {
            revert("a spent or tampered proof was accepted");
        } catch {
            ++nRefused;
        }
        require(usdg.balanceOf(address(shield)) == bal && shield.nextLeafIndex() == leaves, "a refused call moved something");
    }

    /// @dev Bob's withdrawal or his full exit, real proofs; whichever runs first, the other is then refused.
    function bob(bool exit) external {
        (IOrreryShield.TxArgs memory a, IOrreryShield.ExtData memory e) = _decode(exit ? F.bobExit() : F.bobWithdraw());
        if (bobDone) {
            vm.expectRevert(IOrreryShield.NullifierSpent.selector);
            shield.transact(a, e);
            return;
        }
        shield.transact(a, e);
        bobDone = true;
        ghostOut += a.withdrawAmount + a.fee;
        for (uint256 i; i < 2; ++i) if (a.outCommitments[i] != 0) inserts += 1;
        ++nBob;
    }
}

contract ShieldInvariantTest is ShieldBase {
    ShieldHandler internal h;

    function setUp() public override {
        super.setUp();
        _run(F.send());
        _run(F.withdraw());
        // in: Alice's deposit; out: Carol's 500 and two relayer fees; leaves: the deposit and four outputs
        h = new ShieldHandler(shield, usdg, treasury, 1_000e6, 502e6, 5);
        targetContract(address(h));
    }

    function _check() internal view {
        uint256 bal = usdg.balanceOf(A.POOL);
        assertEq(bal, h.ghostIn() - h.ghostOut(), "every USDG in and out is accounted for");
        assertGe(bal, shield.accruedFees(), "fees are held");
        assertEq(shield.nextLeafIndex(), h.inserts(), "one leaf per deposit and per non-empty output");
        assertTrue(shield.knownRoots(shield.currentRoot()));
    }

    function invariant_accounting() public view {
        _check();
    }

    function test_deep_run() public {
        uint256 seed = 0x5131e1d;
        for (uint256 step; step < 400; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = seed % 100;
            if (pick < 40) h.deposit(seed >> 8, seed >> 40, seed >> 90);
            else if (pick < 50) h.donate(seed >> 8);
            else if (pick < 62) h.flush();
            else if (pick < 95) h.refused(seed >> 8, seed >> 64);
            else h.bob((seed >> 8) % 2 == 0);
            if (step % 25 == 0) _check();
        }
        _check();
        console2.log("deposits / flushes / refused / bob", h.nDeposits(), h.nFlushes(), h.nRefused());
        assertGt(h.nDeposits(), 50);
        assertGt(h.nFlushes(), 0);
        assertGt(h.nRefused(), 50);
        assertEq(h.nBob(), 1);
    }
}
