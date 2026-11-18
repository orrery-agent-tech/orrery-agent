// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PredictionBase} from "./utils/R2Base.sol";
import {PredictionMarket} from "../../src/markets/r2/PredictionMarket.sol";
import {PredictionMarketFactory} from "../../src/markets/r2/PredictionMarketFactory.sol";
import {
    IPredictionMarket,
    IPredictionMarketFactory,
    PredictionParams
} from "../../src/markets/r2/interfaces/IPrediction.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";
import {FeeOnTransferToken} from "../mocks/Mocks.sol";
import {MockFeed} from "../markets/utils/MarketMocks.sol";
import {ShortBurnOrry, AnyRoundFeed} from "./utils/R2Mocks.sol";

/// @notice Unit tests of `PredictionMarketFactory` and `PredictionMarket` (`docs/updates/L3-R2-SPEC.md` 3, PM-1 to PM-8).
contract PredictionMarketTest is PredictionBase {
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public override {
        super.setUp();
        (alice, bob, carol) = (traders[1], traders[2], traders[3]);
    }

    // ------------------------------------------------------------------ factory

    function test_factory_constructor_rejects_bad_params() public {
        PredictionParams memory p = _predictionParams();
        p.feeBps = 301;
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        new PredictionMarketFactory(owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p);
        p = _predictionParams();
        p.lockSeconds = 3600; // not below MIN_DURATION
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        new PredictionMarketFactory(owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p);
        p = _predictionParams();
        p.lockSeconds = 59;
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        new PredictionMarketFactory(owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p);
        p = _predictionParams();
        p.minStake = 0;
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        new PredictionMarketFactory(owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p);
        p = _predictionParams();
        p.orryFeeDiscountBps = 10_001;
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        new PredictionMarketFactory(owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p);
        vm.expectRevert(IPredictionMarketFactory.ZeroAddress.selector);
        new PredictionMarketFactory(
            address(0), address(usdg), treasury, address(tiers), address(orryPrice), address(orry), _predictionParams()
        );
        vm.expectRevert(IPredictionMarketFactory.ZeroAddress.selector);
        new PredictionMarketFactory(
            owner, address(usdg), address(0), address(tiers), address(orryPrice), address(orry), _predictionParams()
        );
    }

    function test_factory_getters() public view {
        PredictionParams memory p = pmf.params();
        assertEq(p.feeBps, 200);
        assertEq(p.lockSeconds, 1800);
        assertEq(p.minStake, 1e6);
        assertEq(p.creationFeeUsd, 1e6);
        assertEq(p.orryFeeDiscountBps, 2500);
        assertEq(pmf.owner(), owner);
        assertEq(pmf.feedCount(), 2);
        assertEq(pmf.feedAt(0), address(feed));
        assertEq(pmf.assetOfFeed(address(feed)), address(stock));
        assertEq(pmf.assetOfFeed(address(ethFeed)), address(0));
        assertTrue(pmf.feedListed(address(feed)));
        assertEq(pmf.MIN_DURATION(), 1 hours);
        assertEq(pmf.MAX_DURATION(), 120 days);
    }

    function test_list_feed_is_owner_only_and_add_only() public {
        MockFeed f = new MockFeed(8);
        f.push(100e8, _now());
        vm.prank(alice);
        vm.expectRevert(IPredictionMarketFactory.NotOwner.selector);
        pmf.listFeed(address(f), address(0));
        vm.prank(owner);
        vm.expectRevert(IPredictionMarketFactory.AlreadyListed.selector);
        pmf.listFeed(address(feed), address(0));
        vm.prank(owner);
        vm.expectRevert(IPredictionMarketFactory.ZeroAddress.selector);
        pmf.listFeed(address(0), address(0));
        MockFeed bad = new MockFeed(8);
        bad.push(0, _now());
        vm.prank(owner);
        vm.expectRevert(IPredictionMarketFactory.BadPrice.selector);
        pmf.listFeed(address(bad), address(0));
        vm.prank(owner);
        vm.expectEmit(address(pmf));
        emit IPredictionMarketFactory.FeedListed(address(f), address(0));
        pmf.listFeed(address(f), address(0));
        assertEq(pmf.feedCount(), 3);
    }

    function test_two_step_ownership() public {
        vm.prank(alice);
        vm.expectRevert(IPredictionMarketFactory.NotOwner.selector);
        pmf.transferOwnership(alice);
        vm.prank(owner);
        pmf.transferOwnership(alice);
        assertEq(pmf.pendingOwner(), alice);
        vm.prank(bob);
        vm.expectRevert(IPredictionMarketFactory.NotOwner.selector);
        pmf.acceptOwnership();
        vm.prank(alice);
        pmf.acceptOwnership();
        assertEq(pmf.owner(), alice);
        assertEq(pmf.pendingOwner(), address(0));
    }

    function test_create_checks_inputs() public {
        vm.startPrank(alice);
        vm.expectRevert(IPredictionMarketFactory.FeedNotListed.selector);
        pmf.create(address(0xBEEF), STRIKE, uint64(_now() + 1 days));
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        pmf.create(address(feed), 0, uint64(_now() + 1 days));
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        pmf.create(address(feed), STRIKE, uint64(_now() + 1 hours - 1));
        vm.expectRevert(IPredictionMarketFactory.BadParams.selector);
        pmf.create(address(feed), STRIKE, uint64(_now() + 120 days + 1));
        // the bounds themselves are allowed
        pmf.create(address(feed), STRIKE, uint64(_now() + 1 hours));
        pmf.create(address(feed), STRIKE, uint64(_now() + 120 days));
        vm.stopPrank();
    }

    function test_create_burns_the_creation_fee_in_orry() public {
        uint256 expected = orryPrice.orryFor(1e6);
        assertGt(expected, 0);
        uint256 supply = orry.totalSupply();
        uint256 bal = orry.balanceOf(alice);
        vm.expectEmit(address(pmf));
        emit IOrryBurnEvents.Burned(30, expected);
        vm.prank(alice);
        address m = pmf.create(address(feed), STRIKE, uint64(_now() + 1 days));
        assertEq(supply - orry.totalSupply(), expected, "supply falls by the fee");
        assertEq(bal - orry.balanceOf(alice), expected);
        assertTrue(pmf.isMarket(m));
        assertEq(pmf.marketCount(), 1);
        assertEq(pmf.marketAt(0), m);
        IPredictionMarket.Info memory i = PredictionMarket(m).info();
        assertEq(i.feed, address(feed));
        assertEq(i.asset, address(stock));
        assertEq(i.strike, STRIKE);
        assertEq(i.closeTime, _now() + 1 days);
        assertEq(i.lockTime, _now() + 1 days - 1800);
        assertEq(i.createdAt, _now());
        assertEq(i.factory, address(pmf));
        assertEq(uint8(i.status), uint8(IPredictionMarket.Status.Open));
    }

    function test_create_burns_nothing_while_the_price_is_not_ready() public {
        hook.set(HUB_TICK, 0); // no history
        uint256 supply = orry.totalSupply();
        vm.prank(alice);
        pmf.create(address(feed), STRIKE, uint64(_now() + 1 days));
        assertEq(orry.totalSupply(), supply);
    }

    function test_create_without_orry_allowance_reverts() public {
        vm.prank(alice);
        orry.approve(address(pmf), 0);
        vm.prank(alice);
        vm.expectRevert();
        pmf.create(address(feed), STRIKE, uint64(_now() + 1 days));
    }

    function test_create_with_zero_creation_fee_burns_nothing() public {
        PredictionParams memory p = _predictionParams();
        p.creationFeeUsd = 0;
        PredictionMarketFactory f = new PredictionMarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p
        );
        vm.prank(owner);
        f.listFeed(address(feed), address(stock));
        uint256 supply = orry.totalSupply();
        vm.prank(carol);
        f.create(address(feed), STRIKE, uint64(_now() + 1 days));
        assertEq(orry.totalSupply(), supply);
    }

    // ------------------------------------------------------------------ staking

    function test_stake_moves_usdg_and_counts_both_sides() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        uint256 a = usdg.balanceOf(alice);
        vm.expectEmit(address(m));
        emit IPredictionMarket.Staked(alice, true, 100e6);
        _stake(m, alice, true, 100e6);
        _stake(m, alice, false, 5e6);
        _stake(m, bob, false, 300e6);
        assertEq(a - usdg.balanceOf(alice), 105e6);
        (uint256 y, uint256 n) = m.stakeOf(alice);
        assertEq(y, 100e6);
        assertEq(n, 5e6);
        IPredictionMarket.Info memory i = m.info();
        assertEq(i.yesPool, 100e6);
        assertEq(i.noPool, 305e6);
        assertEq(usdg.balanceOf(address(m)), 405e6);
        assertEq(m.owed(), 405e6, "PM-1: everything is owed while open");
        assertEq(m.grossOf(alice), 0, "nothing claimable while open");
    }

    function test_stake_rules() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        vm.prank(alice);
        vm.expectRevert(IPredictionMarket.StakeTooSmall.selector);
        m.stake(true, 1e6 - 1);
        _stake(m, alice, true, 1e6); // the minimum itself
        vm.warp(m.lockTime() - 1);
        _stake(m, alice, true, 1e6);
        vm.warp(m.lockTime());
        vm.prank(alice);
        vm.expectRevert(IPredictionMarket.StakingClosed.selector);
        m.stake(true, 10e6);
    }

    function test_stake_rejects_a_fee_on_transfer_stake_token() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        PredictionMarketFactory f = new PredictionMarketFactory(
            owner, address(fot), treasury, address(tiers), address(orryPrice), address(orry), _predictionParams()
        );
        vm.prank(owner);
        f.listFeed(address(feed), address(0));
        vm.prank(alice);
        orry.approve(address(f), type(uint256).max);
        vm.prank(alice);
        PredictionMarket m = PredictionMarket(f.create(address(feed), STRIKE, uint64(_now() + 1 days)));
        fot.mint(alice, 100e6);
        vm.startPrank(alice);
        fot.approve(address(m), type(uint256).max);
        vm.expectRevert(IPredictionMarket.InexactTransfer.selector);
        m.stake(true, 10e6);
        vm.stopPrank();
    }

    function test_stake_fails_on_a_frozen_staker() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        usdg.setFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(IPredictionMarket.InexactTransfer.selector);
        m.stake(true, 10e6);
    }

    // ------------------------------------------------------------------ settlement

    function test_settle_yes_strictly_above_the_strike_pays_winners_pro_rata() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, carol, true, 300e6);
        _stake(m, bob, false, 600e6);
        uint80 id = _roundsAround(m, 350e8, STRIKE + 1, 30);
        vm.expectEmit(address(m));
        emit IPredictionMarket.Settled(IPredictionMarket.Status.Yes, STRIKE + 1, id);
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Yes));
        assertEq(m.grossOf(alice), 250e6, "100 of 400 winning stake takes a quarter of 1,000");
        assertEq(m.grossOf(carol), 750e6);
        assertEq(m.grossOf(bob), 0);

        uint256 a = usdg.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = m.claim(false);
        assertEq(paid, 245e6, "2% fee on the gross");
        assertEq(usdg.balanceOf(alice) - a, 245e6);
        assertEq(usdg.balanceOf(treasury), 5e6);
        vm.prank(alice);
        vm.expectRevert(IPredictionMarket.NothingToClaim.selector);
        m.claim(false);
        vm.prank(bob);
        vm.expectRevert(IPredictionMarket.NothingToClaim.selector);
        m.claim(false);
        vm.prank(carol);
        m.claim(false);
        assertEq(usdg.balanceOf(treasury), 20e6, "fees total 2% of the pool, as on the whole pool");
        assertEq(usdg.balanceOf(address(m)), 0);
        assertEq(m.owed(), 0);
    }

    function test_answer_equal_to_the_strike_is_no() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        uint80 id = _roundsAround(m, 370e8, STRIKE, 30);
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.No));
        assertEq(m.grossOf(bob), 200e6);
        IPredictionMarket.Info memory i = m.info();
        assertEq(i.settlePrice, STRIKE);
        assertEq(i.settleRound, id);
    }

    function test_settle_must_use_the_first_round_at_or_after_the_close() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        uint64 close = m.closeTime();
        vm.warp(close - 100);
        uint80 before_ = feed.push(370e8, close - 100);
        vm.warp(close);
        uint80 first = feed.push(350e8, close); // exactly at the close counts as after
        vm.warp(close + 60);
        uint80 second = feed.push(380e8, close + 60);
        vm.warp(close + 61);
        vm.expectRevert(IPredictionMarket.BadPrice.selector);
        m.settle(before_);
        vm.expectRevert(IPredictionMarket.NotFirstRound.selector);
        m.settle(second);
        vm.expectRevert(IPredictionMarket.BadPrice.selector);
        m.settle(second + 5); // a round that does not exist
        m.settle(first);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.No));
        vm.expectRevert(IPredictionMarket.NotOpen.selector);
        m.settle(first);
    }

    function test_settle_rejects_the_first_round_of_a_phase_and_round_zero() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        uint64 close = m.closeTime();
        vm.warp(close + 10);
        feed.newPhase();
        uint80 id = feed.push(370e8, close + 10);
        vm.expectRevert(IPredictionMarket.NotFirstRound.selector);
        m.settle(id);
        vm.expectRevert(IPredictionMarket.BadPrice.selector);
        m.settle(0);
    }

    function test_settle_rejects_a_non_positive_answer() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        uint80 id = _roundsAround(m, 370e8, 0, 30);
        vm.expectRevert(IPredictionMarket.BadPrice.selector);
        m.settle(id);
    }

    function test_settle_timing() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        vm.warp(m.closeTime() - 1);
        vm.expectRevert(IPredictionMarket.NotClosed.selector);
        m.settle(1);
        uint80 id = _roundsAround(m, 370e8, 350e8, 30);
        vm.warp(m.closeTime() + 7 days);
        vm.expectRevert(IPredictionMarket.WindowClosed.selector);
        m.settle(id);
        vm.warp(m.closeTime() + 7 days - 1);
        m.settle(id);
    }

    function test_one_sided_market_refunds_everyone_in_full() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, carol, true, 50e6);
        vm.warp(m.closeTime());
        m.settle(0); // no round needed
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Refund));
        uint256 a = usdg.balanceOf(alice);
        vm.prank(alice);
        assertEq(m.claim(true), 100e6, "PM-5: the stake back, no fee, even when asking to pay in ORRY");
        assertEq(usdg.balanceOf(alice) - a, 100e6);
        assertEq(m.owed(), 50e6);
        vm.prank(carol);
        m.claim(false);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_oracle_pause_blocks_settlement_until_it_lifts() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        uint80 id = _roundsAround(m, 370e8, 370e8, 30);
        stock.setOraclePaused(true);
        vm.expectRevert(IPredictionMarket.StalePrice.selector);
        m.settle(id);
        stock.setOraclePaused(false);
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Yes));
    }

    function test_a_corporate_action_after_creation_refunds_the_market() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        stock.scheduleMultiplier(2e18, _now() + 1 hours); // a split takes effect before the close
        uint80 id = _roundsAround(m, 180e8, 185e8, 30);
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Refund));
        assertEq(m.grossOf(alice), 100e6);
    }

    function test_corporate_actions_outside_the_window_do_not_refund() public {
        stock.scheduleMultiplier(2e18, _now() - 1); // took effect before the market existed
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        uint80 id = _roundsAround(m, 370e8, 370e8, 30);
        stock.scheduleMultiplier(3e18, m.closeTime() + 1 days); // scheduled after the settlement round
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Yes));
    }

    function test_corporate_action_exactly_at_the_round_refunds_and_at_creation_does_not() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        uint64 close = m.closeTime();
        stock.scheduleMultiplier(2e18, close + 30);
        uint80 id = _roundsAround(m, 370e8, 370e8, 30);
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Refund), "effectiveAt == round time");

        stock.scheduleMultiplier(3e18, _now());
        PredictionMarket m2 = _create(STRIKE, 1 days); // created at the effective second
        _stake(m2, alice, true, 100e6);
        _stake(m2, bob, false, 100e6);
        uint80 id2 = _roundsAround(m2, 370e8, 370e8, 30);
        m2.settle(id2);
        assertEq(uint8(m2.status()), uint8(IPredictionMarket.Status.Yes), "effectiveAt == createdAt");
    }

    function test_non_stock_feed_settles_without_issuer_checks() public {
        uint64 close = uint64(_now() + 2 hours);
        vm.prank(alice);
        PredictionMarket m = PredictionMarket(pmf.create(address(ethFeed), 2300e8, close));
        vm.startPrank(alice);
        usdg.approve(address(m), type(uint256).max);
        m.stake(true, 10e6);
        vm.stopPrank();
        vm.startPrank(bob);
        usdg.approve(address(m), type(uint256).max);
        m.stake(false, 10e6);
        vm.stopPrank();
        stock.setOraclePaused(true); // unrelated
        vm.warp(close + 5);
        uint80 id = ethFeed.push(2400e8, close + 5);
        m.settle(id);
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Yes));
    }

    function test_expire_after_the_window_refunds() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        vm.warp(m.closeTime() + 7 days - 1);
        vm.expectRevert(IPredictionMarket.WindowOpen.selector);
        m.expire();
        vm.warp(m.closeTime() + 7 days);
        m.expire();
        assertEq(uint8(m.status()), uint8(IPredictionMarket.Status.Refund));
        vm.expectRevert(IPredictionMarket.NotOpen.selector);
        m.expire();
        vm.prank(bob);
        assertEq(m.claim(false), 100e6);
    }

    // ------------------------------------------------------------------ fees and levers

    function test_staker_discount_lowers_the_usdg_fee() public {
        // 100,000 ORRY is about 223 USD: tier 1 (25% off); 1,000,000 ORRY: tier 2 (50% off)
        staking.set(alice, 100_000e18);
        staking.set(carol, 1_000_000e18);
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, carol, true, 100e6);
        _stake(m, bob, false, 200e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        vm.prank(alice);
        assertEq(m.claim(false), 200e6 - 3e6, "2% of 200 less 25%");
        vm.prank(carol);
        assertEq(m.claim(false), 200e6 - 2e6, "2% of 200 less 50%");
        assertEq(usdg.balanceOf(treasury), 5e6);
    }

    function test_fee_paid_in_orry_is_burned_and_the_gross_is_paid() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        // fee 4 USDG, 25% off in ORRY: 3 USD of ORRY
        uint256 orryFee = orryPrice.orryFor(3e6);
        uint256 supply = orry.totalSupply();
        uint256 a = usdg.balanceOf(alice);
        vm.expectEmit(address(m));
        emit IOrryBurnEvents.Burned(31, orryFee);
        vm.expectEmit(address(m));
        emit IPredictionMarket.Claimed(alice, 200e6, 0, orryFee);
        vm.prank(alice);
        assertEq(m.claim(true), 200e6);
        assertEq(usdg.balanceOf(alice) - a, 200e6, "PM-6: the full gross");
        assertEq(supply - orry.totalSupply(), orryFee, "supply falls by exactly the ORRY fee");
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(address(m)), 0);
    }

    function test_orry_fee_falls_back_to_usdg_while_the_price_is_not_ready() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        hook.set(HUB_TICK, 0);
        uint256 supply = orry.totalSupply();
        vm.prank(alice);
        assertEq(m.claim(true), 196e6);
        assertEq(orry.totalSupply(), supply);
        assertEq(usdg.balanceOf(treasury), 4e6);
    }

    function test_orry_fee_without_allowance_reverts_and_usdg_claim_still_works() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        vm.prank(alice);
        orry.approve(address(m), 0);
        vm.prank(alice);
        vm.expectRevert();
        m.claim(true);
        vm.prank(alice);
        assertEq(m.claim(false), 196e6);
    }

    function test_full_orry_discount_waives_the_fee() public {
        PredictionParams memory p = _predictionParams();
        p.orryFeeDiscountBps = 10_000;
        PredictionMarketFactory f = new PredictionMarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p
        );
        vm.prank(owner);
        f.listFeed(address(feed), address(0));
        vm.prank(alice);
        orry.approve(address(f), type(uint256).max);
        vm.prank(alice);
        PredictionMarket m = PredictionMarket(f.create(address(feed), STRIKE, uint64(_now() + 1 days)));
        vm.prank(alice);
        usdg.approve(address(m), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(m), type(uint256).max);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        uint256 supply = orry.totalSupply();
        vm.prank(alice);
        assertEq(m.claim(true), 200e6);
        assertEq(orry.totalSupply(), supply);
    }

    function test_zero_fee_market_pays_the_gross() public {
        PredictionParams memory p = _predictionParams();
        p.feeBps = 0;
        PredictionMarketFactory f = new PredictionMarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), p
        );
        vm.prank(owner);
        f.listFeed(address(feed), address(0));
        vm.prank(alice);
        orry.approve(address(f), type(uint256).max);
        vm.prank(alice);
        PredictionMarket m = PredictionMarket(f.create(address(feed), STRIKE, uint64(_now() + 1 days)));
        vm.prank(alice);
        usdg.approve(address(m), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(m), type(uint256).max);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        vm.prank(alice);
        assertEq(m.claim(true), 200e6);
    }

    // ------------------------------------------------------------------ solvency, dust and sweep

    function test_rounding_dust_is_owed_until_every_winner_claims_then_swept() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 1e6);
        _stake(m, carol, true, 2e6);
        _stake(m, traders[4], true, 4e6);
        _stake(m, bob, false, 10e6 + 1);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        vm.expectRevert(IPredictionMarket.NothingToClaim.selector);
        m.sweep();
        uint256 g = m.grossOf(alice);
        vm.prank(alice);
        assertEq(m.claim(false), g - g * 200 / 10_000, "PM-6: the fee is rounded down");
        assertGt(g * 200 % 10_000, 0, "this gross has a fractional fee");
        assertGe(usdg.balanceOf(address(m)), m.owed(), "PM-1");
        vm.prank(carol);
        m.claim(false);
        assertGe(usdg.balanceOf(address(m)), m.owed(), "PM-1");
        vm.prank(traders[4]);
        m.claim(false);
        assertEq(m.owed(), 0);
        uint256 dust = usdg.balanceOf(address(m));
        assertLt(dust, 3, "below one base unit per winner");
        if (dust != 0) {
            uint256 t = usdg.balanceOf(treasury);
            m.sweep();
            assertEq(usdg.balanceOf(treasury) - t, dust);
        }
    }

    function test_donations_are_swept_but_never_what_is_owed() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        usdg.mint(address(m), 7e6);
        vm.expectRevert(IPredictionMarket.NotSettled.selector);
        m.sweep();
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        vm.expectEmit(address(m));
        emit IPredictionMarket.Swept(7e6);
        assertEq(m.sweep(), 7e6);
        assertEq(usdg.balanceOf(treasury), 7e6);
        assertEq(usdg.balanceOf(address(m)), 200e6);
        vm.prank(alice);
        m.claim(false);
    }

    function test_refund_market_sweeps_only_donations() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        usdg.mint(address(m), 1e6);
        vm.warp(m.closeTime());
        m.settle(0);
        assertEq(m.sweep(), 1e6);
        vm.prank(alice);
        assertEq(m.claim(false), 100e6);
    }

    function test_claim_before_settlement_reverts() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        vm.prank(alice);
        vm.expectRevert(IPredictionMarket.NotSettled.selector);
        m.claim(false);
    }

    function test_a_frozen_winner_cannot_block_others() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, carol, true, 100e6);
        _stake(m, bob, false, 100e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        usdg.setFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(IPredictionMarket.InexactTransfer.selector);
        m.claim(false);
        vm.prank(carol);
        assertEq(m.claim(false), 147e6);
        assertFalse(m.claimed(alice));
    }

    /// A feed that answers round 0: settlement with it is refused by name, before `roundId - 1` could underflow.
    function test_round_zero_answered_by_a_feed_is_refused() public {
        AnyRoundFeed f = new AnyRoundFeed();
        f.set(370e8, _now());
        vm.prank(owner);
        pmf.listFeed(address(f), address(0));
        vm.prank(alice);
        PredictionMarket m = PredictionMarket(pmf.create(address(f), STRIKE, uint64(_now() + 2 hours)));
        vm.startPrank(alice);
        usdg.approve(address(m), type(uint256).max);
        m.stake(true, 10e6);
        vm.stopPrank();
        vm.startPrank(bob);
        usdg.approve(address(m), type(uint256).max);
        m.stake(false, 10e6);
        vm.stopPrank();
        vm.warp(m.closeTime() + 1);
        f.set(370e8, _now());
        vm.expectRevert(IPredictionMarket.NotFirstRound.selector);
        m.settle(0);
    }

    /// The fee tiers cannot be read (staking reverts): the full fee applies, never a free claim.
    function test_unreadable_tiers_charge_the_full_fee() public {
        staking.set(alice, 1_000_000e18);
        PredictionMarket m = _create(STRIKE, 1 days);
        _stake(m, alice, true, 100e6);
        _stake(m, bob, false, 100e6);
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        staking.setReverts(true);
        vm.prank(alice);
        assertEq(m.claim(false), 196e6);
    }

    /// A token that does not burn what it says: claim and create both refuse it.
    function test_orry_burns_are_checked_on_the_supply() public {
        ShortBurnOrry sr = new ShortBurnOrry(address(this), 1e27);
        PredictionMarketFactory f = new PredictionMarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(sr), _predictionParams()
        );
        vm.prank(owner);
        f.listFeed(address(feed), address(0));
        sr.transfer(alice, 1_000_000e18);
        vm.prank(alice);
        sr.approve(address(f), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(IPredictionMarketFactory.InexactTransfer.selector);
        f.create(address(feed), STRIKE, uint64(_now() + 1 days));

        PredictionParams memory p = _predictionParams();
        p.creationFeeUsd = 0;
        PredictionMarketFactory f2 = new PredictionMarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(sr), p
        );
        vm.prank(owner);
        f2.listFeed(address(feed), address(0));
        vm.prank(alice);
        PredictionMarket m = PredictionMarket(f2.create(address(feed), STRIKE, uint64(_now() + 1 days)));
        vm.startPrank(alice);
        usdg.approve(address(m), type(uint256).max);
        sr.approve(address(m), type(uint256).max);
        m.stake(true, 100e6);
        vm.stopPrank();
        vm.startPrank(bob);
        usdg.approve(address(m), type(uint256).max);
        m.stake(false, 100e6);
        vm.stopPrank();
        m.settle(_roundsAround(m, 370e8, 380e8, 30));
        vm.prank(alice);
        vm.expectRevert(IPredictionMarket.InexactTransfer.selector);
        m.claim(true);
    }

    function test_constants() public {
        PredictionMarket m = _create(STRIKE, 1 days);
        assertEq(m.SETTLE_WINDOW(), 7 days);
        assertEq(m.usdg(), address(usdg));
        assertEq(m.treasury(), treasury);
        assertEq(m.feeTiers(), address(tiers));
        assertEq(m.orryPrice(), address(orryPrice));
        assertEq(m.orry(), address(orry));
        assertEq(m.feeBps(), 200);
        assertEq(m.minStake(), 1e6);
        assertEq(m.orryFeeDiscountBps(), 2500);
    }

    // ------------------------------------------------------------------ fuzz

    /// PM-1, PM-2 over random stakes and outcome.
    function testFuzz_payouts_never_exceed_the_pool(uint96[4] memory amounts, bool[4] memory sides, bool up) public {
        PredictionMarket m = _create(STRIKE, 1 days);
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            uint256 a = bound(uint256(amounts[i]), 1e6, 100_000e6);
            _stake(m, traders[i + 1], sides[i], a);
            total += a;
        }
        m.settle(_roundsAround(m, 370e8, up ? STRIKE + 1 : STRIKE - 1, 30));
        uint256 out;
        for (uint256 i; i < 4; ++i) {
            if (m.grossOf(traders[i + 1]) == 0) continue;
            assertGe(usdg.balanceOf(address(m)), m.owed(), "PM-1");
            vm.prank(traders[i + 1]);
            out += m.claim(i % 2 == 0);
        }
        uint256 fees = usdg.balanceOf(treasury);
        assertLe(out + fees, total, "PM-2");
        assertEq(out + fees + usdg.balanceOf(address(m)), total, "conservation");
        if (m.status() != IPredictionMarket.Status.Refund) assertLt(usdg.balanceOf(address(m)), 4);
    }
}
