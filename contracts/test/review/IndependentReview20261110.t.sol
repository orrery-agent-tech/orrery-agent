// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IProtocolFees} from "v4-core/src/interfaces/IProtocolFees.sol";
import {PairsBase} from "../orry/earn/PairsBase.sol";
import {BuybackBase, StakeBase} from "../orry/stake/utils/StakeBase.sol";
import {RejectEth} from "../orry/stake/utils/StakeMocks.sol";
import {IOrryBuyback} from "../../src/orry/interfaces/IOrryBuyback.sol";
import {IEarnVault} from "../../src/orry/interfaces/IEarnVault.sol";
import {IOrreryHook} from "../../src/orry/interfaces/IOrreryHook.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev Independent review 2026-11-10 (docs/reviews/2026-11-10-independent-review.md). Each test asserts the property
/// the code should have and FAILS on the current code; the failure is the proof of the finding.
/// Run: cd contracts && heavy forge test --match-path test/review/IndependentReview20261110.t.sol -vv

/// @dev USDG stand-in with an issuer pause (the real USDG issuer can freeze, wipe and pause; 08-contract-spec.md section 1).
/// Same storage layout as the MockUsdg it replaces (OpenZeppelin ERC20, then `paused`), so balances survive the etch.
contract PausableUsdg is ERC20 {
    bool public paused;

    constructor() ERC20("Global Dollar", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "USDG: paused");
        super._update(from, to, value);
    }
}

/// @dev Finding M-1: the LP fee that a zap's own swap pays to the vault's existing position is collected by the
/// zap's `modifyLiquidity(+liq)` call, counted as part of the zapper's principal and refunded to the zapper, instead of
/// being harvested into the fee streams of the existing LPs (EarnVault.sol:356-361).
contract ReviewZapFeeLeak is PairsBase {
    /// The same 4 ETH sold into the hub pays the vault's LPs the same LP fee whether a trader or a zap sells it.
    function test_M1_zapSwapLpFeeReachesExistingLps() public {
        depositBalanced(bob, 40 ether); // bob holds the whole hub liquidity
        wait(1);
        nextBlock();

        uint256 snap = vm.snapshotState();
        // control: a trader sells 4 ETH into the hub; the vault's position earns the 0.85% LP fee on it
        sellQuote(4 ether);
        (uint256 controlFee,) = vault.harvest();
        assertGt(controlFee, 0.033 ether, "control: about 0.034 ETH of LP fees harvested");
        vm.revertToState(snap);

        // an 8 ETH zap from ETH swaps 4 ETH through the same hub
        uint256 aliceBefore = alice.balance;
        vm.recordLogs();
        zap(alice, true, 8 ether, 0, 0);
        uint256 aliceSpent = aliceBefore - alice.balance;
        // after the fix the zap's own add collects that fee and streams it at once (FeesHarvested), so the LPs' share
        // is what the zap streamed plus anything a harvest still finds
        uint256 zapStreamed;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == IEarnVault.FeesHarvested.selector) {
                (uint256 q,,) = abi.decode(logs[i].data, (uint256, uint256, uint64));
                zapStreamed += q;
            }
        }
        (uint256 harvested,) = vault.harvest();
        uint256 zapFee = zapStreamed + harvested;
        emit log_named_uint("LP fee harvested after a plain 4 ETH sell (wei)", controlFee);
        emit log_named_uint("LP fee harvested after an 8 ETH zap (wei)      ", zapFee);
        emit log_named_uint("ETH the zapper got back as refund (wei)        ", 8 ether - aliceSpent);

        assertApproxEqRel(zapFee, controlFee, 0.02e18, "M-1: the zap's LP fee never reaches the existing LPs");
    }
}

/// @dev Finding M-2: `OrreryHook.collect()` settles every registered currency in one unlock (OrreryHook.sol:324-364).
/// When one quote token cannot be transferred (USDG paused, or the issuer freezes the hook or the router; a stock token
/// paused or blocked once one is listed), the whole call reverts, so the ETH and ORRY fees of every hub stay in the
/// PoolManager. Pairs can never be removed (R-36) and the hook has no other path, so a permanent freeze is permanent.
contract ReviewCollectAllOrNothing is PairsBase {
    /// collectOne is the hook's own per-currency step inside collect(): nobody else may call it.
    function test_M2_collectOneIsSelfOnly() public {
        vm.prank(alice);
        vm.expectRevert(IOrreryHook.NotSelf.selector);
        hook.collectOne(address(orry));
    }

    function test_M2_pausedQuoteDoesNotBlockEthAndOrryFees() public {
        // ETH hub: liquidity and two swaps, so the hook holds ETH and ORRY claims
        depositBalanced(bob, 40 ether);
        sellQuote(5 ether); // fee in ORRY (the output)
        nextBlock();
        wait(2);
        sellOrry(orryFor(5 ether)); // fee in ETH (the output)
        uint256 ethClaims = claims(address(hook), address(0));
        uint256 orryClaims = claims(address(hook), address(orry));
        assertGt(ethClaims, 0);
        assertGt(orryClaims, 0);

        // USDG hub: opened and traded, so the hook also holds USDG claims
        initHub(address(usdg));
        addLiquidity(address(usdg), 1e18);
        swapIn(address(usdg), false, 1e22); // sells ORRY for USDG: fee in USDG
        assertGt(claims(address(hook), address(usdg)), 0);

        // the USDG issuer pauses the token (same storage, real USDG has this power)
        vm.etch(address(usdg), address(new PausableUsdg()).code);
        PausableUsdg(address(usdg)).setPaused(true);

        uint256 routerEthBefore = address(router).balance;
        try hook.collect() {}
        catch {
            emit log("collect() reverted: no ETH or ORRY fee can leave the hook while USDG is paused");
        }
        assertEq(address(router).balance - routerEthBefore, ethClaims, "M-2: ETH fees blocked by a paused quote");
        assertEq(orry.balanceOf(address(router)), orryClaims, "M-2: ORRY fees blocked by a paused quote");
    }
}

/// @dev Finding M-3 (launch procedure): `deploy-orry-4663.ts` initializes both hubs but adds no liquidity, and the hubs
/// stay empty until the first Earn deposit. Anyone can move an empty v4 pool's price for free (a swap with no liquidity
/// moves only the price), and `EarnVault.deposit` has no price bound of its own (EarnVault.sol:146-159): the web takes
/// the deposit ratio from the hub price and `minShares` from a simulation of the same state, so neither protects. The
/// first depositor adds liquidity at the attacker's price and the attacker trades it back to the market price.
contract ReviewEmptyHubFirstDeposit is PairsBase {
    function test_M3_boundedFirstDepositRevertsOnAMovedHub() public {
        uint160 fair = sqrtPrice();
        assertEq(positionLiquidity(), 0, "hub opened empty, as the mainnet script leaves it");

        // 1. anyone moves the empty hub to 4x the price, for free
        uint256 tEth0 = address(trader).balance;
        uint256 tRc0 = orry.balanceOf(address(trader));
        trader.swapTo(key, false, -1, fair * 2);
        assertEq(address(trader).balance, tEth0, "moving the empty hub cost no ETH");
        assertEq(orry.balanceOf(address(trader)), tRc0, "moving the empty hub cost no ORRY");

        // 2. after the fix the depositor passes bounds from a reference outside the hub (2% around the fair price):
        // the moved hub makes the deposit revert, so nothing is lost
        uint160 lo = uint160(uint256(fair) * 9899 / 10_000); // sqrt(0.98) is about 0.98995
        uint160 hi = uint160(uint256(fair) * 10_100 / 10_000); // sqrt(1.02) is about 1.00995
        uint256 rMax = orryFor(10 ether) * 101 / 100;
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(alice);
        vm.expectRevert(IEarnVault.PriceOutOfBounds.selector);
        vault.deposit{value: 10 ether}(10 ether, rMax, 0, lo, hi, ts);

        // without bounds (the old behaviour) the deposit enters and loses value to the move
        uint256 aE0 = alice.balance;
        uint256 aR0 = orry.balanceOf(alice);
        deposit(alice, 10 ether, rMax);
        uint256 ethIn = aE0 - alice.balance;
        uint256 orryIn = aR0 - orry.balanceOf(alice);

        // 3. the attacker trades the hub back to the fair price
        nextBlock();
        wait(12);
        trader.swapTo(key, true, -int256(500 ether), fair);

        // alice's position plus every fee it earned, valued at the fair price (4,000,000 ORRY per ETH)
        vault.harvest();
        wait(8 days);
        (uint256 qOut, uint256 rOut) = vault.previewWithdraw(vault.sharesOf(alice));
        (uint256 fq, uint256 fr) = vault.pendingFees(alice);
        uint256 valueIn = ethIn + orryIn / ORRY_PER_ETH;
        uint256 valueNow = qOut + fq + (rOut + fr) / ORRY_PER_ETH;
        int256 attacker = int256(address(trader).balance) - int256(tEth0)
            + (int256(orry.balanceOf(address(trader))) - int256(tRc0)) / int256(ORRY_PER_ETH);
        emit log_named_decimal_uint("first deposit, value in at the fair price (ETH)  ", valueIn, 18);
        emit log_named_decimal_uint("first deposit, value now with fees (ETH)         ", valueNow, 18);
        emit log_named_decimal_int("attacker gain at the fair price (ETH)            ", attacker, 18);
        assertLt(valueNow * 100, valueIn * 99, "control: an unbounded deposit into the moved hub does lose value");
    }

    /// Both bounds hold: a pool price under the lower bound or over the upper bound is refused.
    function test_M3_bothBoundsAreChecked() public {
        uint160 fair = sqrtPrice();
        uint256 rMax = orryFor(10 ether) * 101 / 100;
        uint256 ts = vm.getBlockTimestamp();
        vm.prank(alice);
        vm.expectRevert(IEarnVault.PriceOutOfBounds.selector);
        vault.deposit{value: 10 ether}(10 ether, rMax, 0, uint160(uint256(fair) * 10_050 / 10_000), uint160(uint256(fair) * 10_100 / 10_000), ts);
        vm.prank(alice);
        vm.expectRevert(IEarnVault.PriceOutOfBounds.selector);
        vault.deposit{value: 10 ether}(10 ether, rMax, 0, uint160(uint256(fair) * 9900 / 10_000), uint160(uint256(fair) * 9950 / 10_000), ts);
    }

    /// The same bounds let a deposit through at the fair price.
    function test_M3_boundedDepositAtTheFairPriceEnters() public {
        uint160 fair = sqrtPrice();
        uint160 lo = uint160(uint256(fair) * 9899 / 10_000);
        uint160 hi = uint160(uint256(fair) * 10_100 / 10_000);
        uint256 ts = vm.getBlockTimestamp();
        uint256 rMax = orryFor(10 ether) * 101 / 100; // before the prank: orryFor makes calls of its own
        vm.prank(alice);
        uint256 shares = vault.deposit{value: 10 ether}(10 ether, rMax, 0, lo, hi, ts);
        assertGt(shares, 0);
    }
}

/// @dev Finding M-4: every hub hop is sized at `reserve * fee / 2e6`, which moves the price by about `fee / 2`, but its
/// `minOut` keeps a fixed 0.5% for price impact (OrryBuyback.sol:424-436). In the hub `fee` is 1.00% (LP 0.85% + hook
/// 0.15%), so the slack is used up exactly; any PoolManager protocol fee on the hub (the 4663 controller already
/// charges 125 pips on the ETH/USDG pools) pushes the output of a full-cap hop below `minOut`. `burnEth` always spends
/// min(balance, cap), so once the router has sent more than one cap of ETH every call reverts and the ETH waits for
/// good; `buyWithQuote` and capped slices fail the same way. Nobody can change the fee terms (no owner).
contract ReviewBuybackCapVersusMinOut is BuybackBase {
    function setUp() public override {
        super.setUp();
        _setCoin(address(buyback));
    }

    function test_M4_burnEthStillWorksWithASmallProtocolFeeOnTheHub() public {
        vm.prank(address(0)); // the etched PoolManager has no owner in storage
        IProtocolFees(address(pm)).setProtocolFeeController(address(this));
        // 200 pips (0.02%) each way, a fifth of the PoolManager's 1000-pip maximum
        IProtocolFees(address(pm)).setProtocolFee(hubKey, uint24(200 | (200 << 12)));

        vm.deal(address(buyback), 10 ether); // more than one hub cap of ETH from the router
        try buyback.burnEth() returns (uint256 burned) {
            assertGt(burned, 0);
        } catch (bytes memory err) {
            assertEq(bytes4(err), IOrryBuyback.SlippageExceeded.selector, "unexpected revert");
            emit log("burnEth reverted SlippageExceeded: a full-cap hub hop cannot meet its own minOut");
            fail();
        }
    }

    /// Regression for M-4 across the whole range: a full-cap hub burn passes at every protocol fee the PoolManager allows.
    function test_M4_fullCapBurnPassesAtEveryProtocolFee() public {
        vm.prank(address(0));
        IProtocolFees(address(pm)).setProtocolFeeController(address(this));
        uint24[6] memory pips = [uint24(0), 125, 175, 300, 500, 1000];
        for (uint256 i; i < pips.length; ++i) {
            uint256 snap = vm.snapshotState();
            IProtocolFees(address(pm)).setProtocolFee(hubKey, uint24(pips[i] | (pips[i] << 12)));
            vm.deal(address(buyback), 10 ether);
            assertGt(buyback.burnEth(), 0, "full-cap burn at this protocol fee");
            vm.revertToState(snap);
        }
    }

    function test_M4_controlWithoutProtocolFee() public {
        vm.deal(address(buyback), 10 ether);
        assertGt(buyback.burnEth(), 0, "control: no protocol fee, the full-cap burn passes");
    }
}

/// @dev Finding L-1: `OrryStaking._claim` pays ORRY and ETH in one call and reverts when the ETH transfer fails
/// (OrryStaking.sol:240-256). A staker that cannot take ETH (a contract wallet without `receive`, a vault, a
/// multisig module) can never take its ORRY rewards either, and nobody can send them elsewhere; `ClaimAll` reverts for
/// it too. The existing test `test_claim_to_contract_refusing_eth_reverts_its_own_call` covers only the ETH side.
contract ReviewStakingClaimBundle is StakeBase {
    function test_L1_orryRewardsReachAStakerThatRefusesEth() public {
        RejectEth rej = new RejectEth();
        orry.transfer(address(rej), 10e18);
        rej.call(address(orry), abi.encodeCall(orry.approve, (address(staking), type(uint256).max)));
        rej.call(address(staking), abi.encodeCall(staking.stake, (10e18)));
        _notify(1 ether, 1_000e18);
        vm.warp(_now() + 8 days);
        (, uint256 owedOrry) = staking.pendingRewards(address(rej));
        assertGt(owedOrry, 0);

        try staking.claimFor(address(rej)) {} catch {}
        assertEq(orry.balanceOf(address(rej)), owedOrry, "L-1: ORRY rewards locked behind the ETH transfer");
    }
}
