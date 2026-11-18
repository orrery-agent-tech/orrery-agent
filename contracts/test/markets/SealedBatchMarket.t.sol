// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {ISealedBatchMarket} from "../../src/markets/interfaces/ISealedBatchMarket.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";
import {SealedBatchMarket} from "../../src/markets/SealedBatchMarket.sol";
import {MarketParams} from "../../src/markets/MarketParams.sol";
import {MarketBase} from "./utils/MarketBase.sol";
import {FeeOnTransferToken, MockFeed} from "./utils/MarketMocks.sol";
import {MarketFactory} from "../../src/markets/MarketFactory.sol";
import {HalfBurnOrry} from "../orry/stake/utils/StakeMocks.sol";

contract SealedBatchMarketTest is MarketBase {
    address internal alice;
    address internal bob;
    address internal carol;
    address internal dave;

    function setUp() public override {
        super.setUp();
        (alice, bob, carol, dave) = (traders[0], traders[1], traders[2], traders[3]);
    }

    function _two(address a, ISealedBatchMarket.Order memory oa, address b, ISealedBatchMarket.Order memory ob)
        internal
        returns (uint256)
    {
        address[] memory who = new address[](2);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](2);
        (who[0], who[1], os[0], os[1]) = (a, b, oa, ob);
        return _place(who, os);
    }

    function _clearReverts(uint256 b, bytes4 selector) internal {
        uint80 rid = feed.latestRoundId(); // read first: an external call would take the expectRevert
        vm.expectRevert(selector);
        market.clear(b, rid);
    }

    // ------------------------------------------------------------------ deployment and timing

    function test_constructor_reads_and_params() public view {
        assertEq(market.asset(), address(stock));
        assertEq(market.usdg(), address(usdg));
        assertEq(market.priceFeed(), address(feed));
        assertEq(market.treasury(), treasury);
        assertEq(market.feeTiers(), address(tiers));
        assertEq(market.orryPrice(), address(orryPrice));
        assertEq(market.orry(), address(orry));
        assertEq(market.start(), START);
        assertEq(market.commitSeconds(), 240);
        assertEq(market.revealSeconds(), 60);
        assertEq(market.feeBps(), 15);
        assertEq(market.minNotionalUsdg(), 10e6);
        assertEq(market.maxStaleness(), 25 hours);
        assertEq(market.commitFeeUsd(), 0.05e6);
        assertEq(market.MAX_ORDERS(), 64);
        assertEq(market.orryFeeDiscountBps(), 2500);
        assertEq(market.maxDeviationBps(), 50);
        (, bool listed) = market.remainderPool();
        assertFalse(listed);
        assertEq(market.EXPIRY(), 1 days);
    }

    function test_phase_and_reveal_end() public {
        (uint256 b, bool inCommit, uint64 endsAt) = market.phase();
        assertEq(b, 0);
        assertTrue(inCommit);
        assertEq(endsAt, START + 240);
        vm.warp(START + 240);
        (b, inCommit, endsAt) = market.phase();
        assertEq(b, 0);
        assertFalse(inCommit);
        assertEq(endsAt, START + 300);
        assertEq(market.revealEnd(0), START + 300);
        vm.warp(START + 300);
        (b, inCommit, endsAt) = market.phase();
        assertEq(b, 1);
        assertTrue(inCommit);
        assertEq(endsAt, START + 540);
        assertEq(market.revealEnd(7), START + 8 * 300);
    }

    // ------------------------------------------------------------------ commit

    function test_commit_stores_and_burns_the_commit_fee() public {
        uint256 fee = orryPrice.orryFor(0.05e6);
        assertGt(fee, 20e18);
        assertLt(fee, 25e18); // 0.05 USD at about 0.00223 USD per ORRY
        bytes32 c = keccak256("c");
        uint256 supply = orry.totalSupply();
        vm.expectEmit(address(market));
        emit IOrryBurnEvents.Burned(5, fee);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.Committed(0, alice, c, fee);
        vm.prank(alice);
        market.commit(c);
        assertEq(supply - orry.totalSupply(), fee);
        assertEq(market.commitmentOf(0, alice), c);
    }

    function test_commit_is_free_while_the_orry_price_is_not_ready() public {
        hook.set(HUB_TICK, START - 10 minutes); // under 30 minutes of hub history
        uint256 supply = orry.totalSupply();
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.Committed(0, alice, keccak256("c"), 0);
        vm.prank(alice);
        market.commit(keccak256("c"));
        assertEq(orry.totalSupply(), supply);
    }

    function test_commit_reverts() public {
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.ZeroAmount.selector);
        market.commit(bytes32(0));

        vm.prank(alice);
        market.commit(keccak256("a"));
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.AlreadyCommitted.selector);
        market.commit(keccak256("b"));

        vm.warp(START + 240);
        vm.prank(bob);
        vm.expectRevert(ISealedBatchMarket.WrongPhase.selector);
        market.commit(keccak256("b"));

        // without ORRY allowance the commit fee cannot be burned
        vm.warp(START + 300);
        vm.prank(alice);
        orry.approve(address(market), 0);
        vm.prank(alice);
        vm.expectRevert(bytes("allowance"));
        market.commit(keccak256("a"));
    }

    function test_batch_full_at_max_orders() public {
        hook.set(HUB_TICK, 0); // no ORRY price: commits are free
        for (uint256 i; i < 64; ++i) {
            address t = address(uint160(0x1000 + i));
            vm.prank(t);
            market.commit(keccak256(abi.encode(i)));
        }
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.BatchFull.selector);
        market.commit(keccak256("one more"));
    }

    // ------------------------------------------------------------------ reveal

    function test_reveal_stores_the_order() public {
        ISealedBatchMarket.Order memory o = _sell(1e18, 300e6);
        uint256 b = _commit(alice, o);
        _toReveal(b);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.Revealed(b, alice, o);
        _reveal(alice, o);
        assertEq(market.orderCount(b), 1);
        (address who, ISealedBatchMarket.Order memory got) = market.orderAt(b, 0);
        assertEq(who, alice);
        assertEq(abi.encode(got), abi.encode(o));
        assertEq(market.commitmentOf(b, alice), bytes32(0));
        // nothing moves at reveal
        assertEq(stock.balanceOf(address(market)), 0);
    }

    function test_reveal_for_an_account_by_a_relay() public {
        ISealedBatchMarket.Order memory o = _sell(1e18, 300e6);
        uint256 b = _commit(alice, o);
        address relay = makeAddr("relay");
        vm.prank(relay);
        vm.expectRevert(ISealedBatchMarket.WrongPhase.selector);
        market.revealFor(alice, o, _salt(alice));
        _toReveal(b);
        vm.prank(relay); // the commitment binds alice: bob's account does not open it
        vm.expectRevert(ISealedBatchMarket.BadReveal.selector);
        market.revealFor(bob, o, _salt(alice));
        vm.prank(relay); // nor does a wrong salt
        vm.expectRevert(ISealedBatchMarket.BadReveal.selector);
        market.revealFor(alice, o, _salt(bob));
        vm.prank(relay);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.Revealed(b, alice, o);
        market.revealFor(alice, o, _salt(alice));
        (address who,) = market.orderAt(b, 0);
        assertEq(who, alice);
        vm.prank(alice); // revealed once only, by whoever sent it
        vm.expectRevert(ISealedBatchMarket.BadReveal.selector);
        market.reveal(o, _salt(alice));
    }

    function test_reveal_reverts() public {
        ISealedBatchMarket.Order memory o = _sell(1e18, 300e6);
        uint256 b = _commit(alice, o);
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.WrongPhase.selector);
        market.reveal(o, _salt(alice));
        _toReveal(b);
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.BadReveal.selector);
        market.reveal(o, bytes32("wrong salt"));
        vm.prank(bob); // no commitment
        vm.expectRevert(ISealedBatchMarket.BadReveal.selector);
        market.reveal(o, _salt(bob));
        _reveal(alice, o);
        vm.prank(alice); // second reveal
        vm.expectRevert(ISealedBatchMarket.BadReveal.selector);
        market.reveal(o, _salt(alice));
    }

    function test_reveal_rejects_zero_and_below_minimum() public {
        ISealedBatchMarket.Order memory zeroAmount = _buy(0, 400e6);
        ISealedBatchMarket.Order memory zeroLimit = _buy(100e6, 0);
        ISealedBatchMarket.Order memory smallBuy = _buy(10e6 - 1, 400e6);
        ISealedBatchMarket.Order memory smallSell = _sell(0.0279e18, 1); // 9.995 USDG at 358.25
        ISealedBatchMarket.Order memory okSell = _sell(0.028e18, 1); // 10.031 USDG
        _commit(alice, zeroAmount);
        _commit(bob, zeroLimit);
        _commit(carol, smallBuy);
        _commit(dave, smallSell);
        uint256 b = _commit(traders[4], okSell);
        _toReveal(b);
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.ZeroAmount.selector);
        market.reveal(zeroAmount, _salt(alice));
        vm.prank(bob);
        vm.expectRevert(ISealedBatchMarket.ZeroAmount.selector);
        market.reveal(zeroLimit, _salt(bob));
        vm.prank(carol);
        vm.expectRevert(ISealedBatchMarket.BelowMinimum.selector);
        market.reveal(smallBuy, _salt(carol));
        vm.prank(dave);
        vm.expectRevert(ISealedBatchMarket.BelowMinimum.selector);
        market.reveal(smallSell, _salt(dave));
        _reveal(traders[4], okSell);
        assertEq(market.orderCount(b), 1);
    }

    function test_reveal_of_a_sell_needs_a_positive_feed_answer() public {
        ISealedBatchMarket.Order memory o = _sell(1e18, 300e6);
        uint256 b = _commit(alice, o);
        feed.push(0, START + 10);
        _toReveal(b);
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.StalePrice.selector);
        market.reveal(o, _salt(alice));
    }

    // ------------------------------------------------------------------ clear: fills

    function test_exact_cross_one_seller_one_buyer() public {
        uint256 b = _two(alice, _sell(1e18, 350e6), bob, _buy(TSLA_PRICE, 360e6));
        uint256 fee = TSLA_PRICE * 15 / 10_000; // 537,375
        uint256 aS = stock.balanceOf(alice);
        uint256 aU = usdg.balanceOf(alice);
        uint256 bS = stock.balanceOf(bob);
        uint256 bU = usdg.balanceOf(bob);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.OrderFilled(b, alice, 1e18, TSLA_PRICE - fee, fee, 0);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.OrderFilled(b, bob, TSLA_PRICE, 1e18, fee, 0);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.BatchCleared(b, TSLA_PRICE, feed.latestRoundId(), 1e18, TSLA_PRICE);
        _clear(b);
        assertEq(aS - stock.balanceOf(alice), 1e18);
        assertEq(usdg.balanceOf(alice) - aU, TSLA_PRICE - fee);
        assertEq(stock.balanceOf(bob) - bS, 1e18);
        assertEq(bU - usdg.balanceOf(bob), TSLA_PRICE + fee);
        assertEq(usdg.balanceOf(treasury), 2 * fee);
        assertEq(stock.balanceOf(address(market)), 0);
        assertEq(usdg.balanceOf(address(market)), 0);
        ISealedBatchMarket.BatchResult memory r = market.result(b);
        assertTrue(r.cleared);
        assertEq(r.price, TSLA_PRICE);
        assertEq(r.roundId, feed.latestRoundId());
        assertEq(r.assetFilled, 1e18);
        assertEq(r.usdgFilled, TSLA_PRICE);
        assertEq(r.usdgFees, 2 * fee);
        assertEq(r.ordersDropped, 0);
    }

    function test_sellers_larger_side_fill_pro_rata() public {
        // sellers offer 3 + 1 TSLA, the buyer can afford 2 at 358.25: each seller fills half
        address[] memory who = new address[](3);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](3);
        (who[0], who[1], who[2]) = (alice, bob, carol);
        os[0] = _sell(3e18, 1);
        os[1] = _sell(1e18, 1);
        os[2] = _buy(2 * TSLA_PRICE, type(uint256).max);
        uint256 b = _place(who, os);
        uint256 aS = stock.balanceOf(alice);
        uint256 bS = stock.balanceOf(bob);
        _clear(b);
        assertEq(aS - stock.balanceOf(alice), 1.5e18);
        assertEq(bS - stock.balanceOf(bob), 0.5e18);
        assertEq(stock.balanceOf(carol), 1_002e18);
        assertEq(market.result(b).assetFilled, 2e18);
    }

    function test_buyers_larger_side_fill_pro_rata_and_pay_the_same_price() public {
        // one seller of 1 TSLA, buyers offer 3x and 1x its value: they get 0.75 and 0.25 TSLA
        address[] memory who = new address[](3);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](3);
        (who[0], who[1], who[2]) = (alice, bob, carol);
        os[0] = _sell(1e18, 1);
        os[1] = _buy(3 * TSLA_PRICE, type(uint256).max);
        os[2] = _buy(TSLA_PRICE, type(uint256).max);
        uint256 b = _place(who, os);
        uint256 bU = usdg.balanceOf(bob);
        uint256 cU = usdg.balanceOf(carol);
        _clear(b);
        assertEq(stock.balanceOf(bob) - 1_000e18, 0.75e18);
        assertEq(stock.balanceOf(carol) - 1_000e18, 0.25e18);
        uint256 bobPaid = TSLA_PRICE * 3 / 4;
        uint256 carolPaid = TSLA_PRICE / 4;
        assertEq(bU - usdg.balanceOf(bob), bobPaid + bobPaid * 15 / 10_000);
        assertEq(cU - usdg.balanceOf(carol), carolPaid + carolPaid * 15 / 10_000);
    }

    function test_rounding_dust_goes_to_the_treasury_in_usdg_only() public {
        // three buyers of awkward sizes against one seller: asset splits add up exactly, USDG dust is non-negative
        address[] memory who = new address[](4);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](4);
        (who[0], who[1], who[2], who[3]) = (alice, bob, carol, dave);
        os[0] = _sell(1e18 + 7, 1);
        os[1] = _buy(100e6 + 1, type(uint256).max);
        os[2] = _buy(200e6 + 3, type(uint256).max);
        os[3] = _buy(300e6 + 5, type(uint256).max);
        uint256 b = _place(who, os);
        uint256 supplyHeld = stock.balanceOf(alice) + stock.balanceOf(bob) + stock.balanceOf(carol)
            + stock.balanceOf(dave);
        _clear(b);
        assertEq(
            stock.balanceOf(alice) + stock.balanceOf(bob) + stock.balanceOf(carol) + stock.balanceOf(dave), supplyHeld
        );
        assertEq(stock.balanceOf(treasury), 0);
        assertEq(stock.balanceOf(address(market)), 0);
        assertEq(usdg.balanceOf(address(market)), 0);
        // buyers together pay the crossed asset at the price, rounded up
        ISealedBatchMarket.BatchResult memory r = market.result(b);
        assertEq(r.usdgFilled, (r.assetFilled * TSLA_PRICE + 1e18 - 1) / 1e18);
        assertGt(r.usdgFees, 0);
    }

    function test_limits_not_met_are_left_untouched() public {
        // seller wants 400, buyer pays at most 300: neither is pulled
        uint256 b = _two(alice, _sell(1e18, 400e6), bob, _buy(TSLA_PRICE, 300e6));
        _clear(b);
        assertEq(stock.balanceOf(alice), 1_000e18);
        assertEq(usdg.balanceOf(bob), 1_000_000e6);
        assertEq(market.result(b).assetFilled, 0);
        assertEq(market.result(b).ordersDropped, 0);
    }

    function test_one_sided_batch_refunds_everything() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _sell(2e18, 1));
        vm.recordLogs();
        _clear(b);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != ISealedBatchMarket.OrderFilled.selector, "no fill event without a fill");
        }
        assertEq(stock.balanceOf(alice), 1_000e18);
        assertEq(stock.balanceOf(bob), 1_000e18);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    // ------------------------------------------------------------------ clear: fees

    function test_fee_tiers_discount_the_usdg_fee() public {
        staking.set(alice, 100_000e18); // 25% off
        staking.set(bob, 1_000_000e18); // 50% off
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        uint256 aU = usdg.balanceOf(alice);
        uint256 bU = usdg.balanceOf(bob);
        _clear(b);
        uint256 sellerFee = TSLA_PRICE * 15 * 7500 / 1e8;
        uint256 buyerFee = TSLA_PRICE * 15 * 5000 / 1e8;
        assertEq(usdg.balanceOf(alice) - aU, TSLA_PRICE - sellerFee);
        assertEq(bU - usdg.balanceOf(bob), TSLA_PRICE + buyerFee);
        assertEq(usdg.balanceOf(treasury), sellerFee + buyerFee);
    }

    function test_fee_paid_in_orry_is_burned_with_the_extra_discount() public {
        ISealedBatchMarket.Order memory s = _sell(1e18, 1);
        s.payFeeInOrry = true;
        ISealedBatchMarket.Order memory bb = _buy(TSLA_PRICE, type(uint256).max);
        bb.payFeeInOrry = true;
        uint256 b = _two(alice, s, bob, bb);
        uint256 usdFee = TSLA_PRICE * 15 / 10_000;
        uint256 orryFee = orryPrice.orryFor(usdFee * 7500 / 10_000);
        uint256 supply = orry.totalSupply();
        uint256 aU = usdg.balanceOf(alice);
        uint256 bU = usdg.balanceOf(bob);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.OrderFilled(b, alice, 1e18, TSLA_PRICE, 0, orryFee);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.OrderFilled(b, bob, TSLA_PRICE, 1e18, 0, orryFee);
        vm.expectEmit(address(market));
        emit IOrryBurnEvents.Burned(6, 2 * orryFee);
        _clear(b);
        assertEq(supply - orry.totalSupply(), 2 * orryFee);
        assertEq(usdg.balanceOf(alice) - aU, TSLA_PRICE);
        assertEq(bU - usdg.balanceOf(bob), TSLA_PRICE);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(market.result(b).orryFeesBurned, 2 * orryFee);
    }

    function test_orry_fee_falls_back_to_usdg_when_the_price_is_not_ready() public {
        ISealedBatchMarket.Order memory s = _sell(1e18, 1);
        s.payFeeInOrry = true;
        uint256 b = _two(alice, s, bob, _buy(TSLA_PRICE, type(uint256).max));
        ethFeed.push(ETH_ANSWER, _now() - 26 hours); // stale ETH/USD
        uint256 supply = orry.totalSupply();
        _clear(b);
        assertEq(orry.totalSupply(), supply);
        assertEq(usdg.balanceOf(treasury), 2 * (TSLA_PRICE * 15 / 10_000));
    }

    function test_orry_fee_order_without_orry_allowance_is_dropped() public {
        ISealedBatchMarket.Order memory s = _sell(1e18, 1);
        s.payFeeInOrry = true;
        uint256 b = _two(alice, s, bob, _buy(TSLA_PRICE, type(uint256).max));
        vm.prank(alice);
        orry.approve(address(market), 0);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.OrderDropped(b, alice);
        _clear(b);
        assertEq(stock.balanceOf(alice), 1_000e18);
        assertEq(market.result(b).ordersDropped, 1);
    }

    // ------------------------------------------------------------------ clear: drops (DP-6)

    function test_revoked_allowance_drops_only_that_order() public {
        address[] memory who = new address[](3);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](3);
        (who[0], who[1], who[2]) = (alice, bob, carol);
        os[0] = _sell(1e18, 1);
        os[1] = _sell(1e18, 1);
        os[2] = _buy(TSLA_PRICE, type(uint256).max);
        uint256 b = _place(who, os);
        vm.prank(alice);
        stock.approve(address(market), 0);
        _clear(b);
        assertEq(stock.balanceOf(alice), 1_000e18);
        assertEq(stock.balanceOf(bob), 999e18);
        assertEq(stock.balanceOf(carol), 1_001e18);
        assertEq(market.result(b).ordersDropped, 1);
    }

    function test_moved_balance_drops_only_that_order() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        vm.prank(bob);
        usdg.transfer(carol, 1_000_000e6);
        _clear(b);
        assertEq(stock.balanceOf(alice), 1_000e18);
        assertEq(market.result(b).ordersDropped, 1);
        assertEq(market.result(b).assetFilled, 0);
    }

    function test_issuer_block_drops_the_blocked_seller_and_buyer() public {
        address[] memory who = new address[](4);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](4);
        (who[0], who[1], who[2], who[3]) = (alice, bob, carol, dave);
        os[0] = _sell(1e18, 1);
        os[1] = _sell(1e18, 1);
        os[2] = _buy(TSLA_PRICE, type(uint256).max);
        os[3] = _buy(TSLA_PRICE, type(uint256).max);
        uint256 b = _place(who, os);
        registry.setBlocked(alice, true); // a blocked seller cannot send the asset
        registry.setBlocked(dave, true); // a blocked buyer cannot receive it: dropped before any USDG is pulled
        uint256 dU = usdg.balanceOf(dave);
        _clear(b);
        assertEq(stock.balanceOf(bob), 999e18);
        assertEq(stock.balanceOf(carol), 1_001e18);
        assertEq(usdg.balanceOf(dave), dU);
        assertEq(market.result(b).ordersDropped, 2);
    }

    function test_frozen_usdg_seller_is_dropped_before_its_asset_is_pulled() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        usdg.setFrozen(alice, true);
        _clear(b);
        assertEq(stock.balanceOf(alice), 1_000e18);
        assertEq(market.result(b).ordersDropped, 1);
    }

    function test_paused_asset_drops_every_order_and_moves_nothing() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        stock.setPaused(true);
        uint256 bU = usdg.balanceOf(bob);
        _clear(b);
        assertEq(usdg.balanceOf(bob), bU);
        assertEq(market.result(b).ordersDropped, 2);
        assertEq(market.result(b).assetFilled, 0);
        registry.setPaused(true); // the registry-wide pause reads the same way
        assertTrue(stock.paused());
    }

    function test_unfundable_amount_is_dropped() public {
        // amountIn plus its fee would overflow: the order is dropped, the batch still clears
        ISealedBatchMarket.Order memory huge = _buy(type(uint256).max, type(uint256).max);
        uint256 b = _two(alice, _sell(1e18, 1), bob, huge);
        _clear(b);
        assertEq(market.result(b).ordersDropped, 1);
    }

    // ------------------------------------------------------------------ clear: price round (DP-2)

    function test_round_must_be_the_latest_at_or_before_reveal_end() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        uint80 first = feed.latestRoundId();
        feed.push(TSLA_ANSWER + 1e8, _now() - 10); // a newer round still before reveal end
        uint80 second = feed.latestRoundId();
        feed.push(TSLA_ANSWER + 2e8, _now() + 30); // after reveal end
        vm.warp(_now() + 60);
        vm.expectRevert(ISealedBatchMarket.BadRound.selector);
        market.clear(b, first); // not the latest before the end
        vm.expectRevert(ISealedBatchMarket.BadRound.selector);
        market.clear(b, second + 1); // updated after the end
        vm.expectRevert(ISealedBatchMarket.BadRound.selector);
        market.clear(b, second + 5); // does not exist
        market.clear(b, second);
        assertEq(market.result(b).price, TSLA_PRICE + 1_000000);
        assertEq(market.result(b).roundId, second);
    }

    function test_a_round_updated_exactly_at_reveal_end_is_the_latest_one() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        uint80 before = feed.latestRoundId();
        uint80 atEnd = feed.push(TSLA_ANSWER + 1e8, market.revealEnd(b));
        vm.expectRevert(ISealedBatchMarket.BadRound.selector);
        market.clear(b, before);
        market.clear(b, atEnd);
        assertEq(market.result(b).roundId, atEnd);
    }

    function test_round_hint_across_a_phase_change() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        uint80 oldPhase = feed.latestRoundId(); // last round of phase 1
        feed.newPhase();
        uint80 newer = feed.push(TSLA_ANSWER, market.revealEnd(b) - 5); // phase 2, still before the end
        feed.push(TSLA_ANSWER, market.revealEnd(b) + 5);
        vm.warp(market.revealEnd(b) + 10);
        // the old phase's round has no successor in its phase: it cannot be proven the latest
        vm.expectRevert(ISealedBatchMarket.BadRound.selector);
        market.clear(b, oldPhase);
        market.clear(b, newer);
    }

    function test_a_failing_fee_tier_read_charges_the_full_fee() public {
        staking.set(alice, 1_000_000e18);
        staking.setReverts(true);
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        _clear(b);
        assertEq(usdg.balanceOf(treasury), 2 * (TSLA_PRICE * 15 / 10_000));
    }

    function test_stale_round_is_refused() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        uint80 old = feed.push(TSLA_ANSWER, market.revealEnd(b) - 25 hours - 1);
        vm.expectRevert(ISealedBatchMarket.StalePrice.selector);
        market.clear(b, old);
        feed.push(TSLA_ANSWER, market.revealEnd(b) - 25 hours);
        _clear(b);
    }

    function test_non_positive_answer_is_refused() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        feed.push(-1, _now() - 1);
        _clearReverts(b, ISealedBatchMarket.StalePrice.selector);
    }

    function test_corporate_action_blocks_clearing() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        stock.setOraclePaused(true);
        _clearReverts(b, ISealedBatchMarket.StalePrice.selector);
        stock.setOraclePaused(false);
        // a 2-for-1 multiplier took effect after the round's update: the round prices the old token
        stock.scheduleMultiplier(2e18, _now() - 1);
        _clearReverts(b, ISealedBatchMarket.StalePrice.selector);
        // a round published after the change prices it
        feed.push(TSLA_ANSWER * 2, _now());
        _clear(b);
        assertEq(market.result(b).price, 2 * TSLA_PRICE);
    }

    // ------------------------------------------------------------------ clear and expire timing (DP-8)

    function test_clear_timing_and_once() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        vm.warp(_now() - 1);
        _clearReverts(b, ISealedBatchMarket.WrongPhase.selector);
        vm.warp(_now() + 1);
        _clear(b);
        _clearReverts(b, ISealedBatchMarket.AlreadyCleared.selector);
        vm.warp(_now() + 1 days);
        vm.expectRevert(ISealedBatchMarket.AlreadyCleared.selector);
        market.expire(b);
    }

    function test_expiry() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        vm.warp(market.revealEnd(b) + 1 days - 1);
        vm.expectRevert(ISealedBatchMarket.WrongPhase.selector);
        market.expire(b);
        vm.warp(market.revealEnd(b) + 1 days);
        feed.push(TSLA_ANSWER, market.revealEnd(b) - 1);
        _clearReverts(b, ISealedBatchMarket.Expired.selector);
        vm.expectEmit(address(market));
        emit ISealedBatchMarket.BatchExpired(b);
        market.expire(b);
        vm.expectRevert(ISealedBatchMarket.AlreadyCleared.selector);
        market.expire(b);
        assertFalse(market.result(b).cleared);
        assertEq(stock.balanceOf(alice), 1_000e18);
    }

    // ------------------------------------------------------------------ custody (X-1)

    function test_a_donation_does_not_block_clearing() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        stock.mint(address(market), 1);
        usdg.mint(address(market), 1);
        _clear(b);
        assertEq(stock.balanceOf(address(market)), 1);
        assertEq(usdg.balanceOf(address(market)), 1);
        assertEq(stock.balanceOf(bob), 1_001e18);
    }

    function test_fee_on_transfer_asset_cannot_clear() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.prank(owner);
        SealedBatchMarket m = SealedBatchMarket(factory.create(address(fot), address(feed), noPool));
        fot.mint(alice, 10e18);
        vm.startPrank(alice);
        fot.approve(address(m), type(uint256).max);
        orry.approve(address(m), type(uint256).max);
        vm.stopPrank();
        ISealedBatchMarket.Order memory o = _sell(1e18, 1);
        (uint256 b,,) = m.phase();
        bytes32 c = m.commitmentFor(b, alice, o, _salt(alice));
        vm.prank(alice);
        m.commit(c);
        vm.warp(m.revealEnd(b) - 60);
        vm.prank(alice);
        m.reveal(o, _salt(alice));
        vm.warp(m.revealEnd(b));
        uint80 rid = feed.latestRoundId();
        vm.expectRevert(ISealedBatchMarket.InexactTransfer.selector);
        m.clear(b, rid);
    }

    function test_tiny_answer_that_prices_to_zero_is_refused() public {
        uint256 b = _two(alice, _sell(1e18, 1), bob, _buy(TSLA_PRICE, type(uint256).max));
        feed.push(99, _now()); // 0.00000099 USD: below one USDG base unit per token
        _clearReverts(b, ISealedBatchMarket.StalePrice.selector);
    }

    function test_a_burn_that_does_not_reduce_supply_is_refused() public {
        HalfBurnOrry half = new HalfBurnOrry(address(this), 1e27);
        MarketFactory f2 = new MarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(half), pm, _params()
        );
        vm.prank(owner);
        SealedBatchMarket m = SealedBatchMarket(f2.create(address(stock), address(feed), noPool));
        half.transfer(alice, 1_000e18);
        vm.prank(alice);
        half.approve(address(m), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(ISealedBatchMarket.InexactTransfer.selector);
        m.commit(keccak256("c"));
    }

    function test_a_clear_time_orry_burn_that_does_not_reduce_supply_is_refused() public {
        HalfBurnOrry half = new HalfBurnOrry(address(this), 1e27);
        MarketParams memory p = _params();
        p.commitFeeUsd = 0;
        MarketFactory f2 =
            new MarketFactory(owner, address(usdg), treasury, address(tiers), address(orryPrice), address(half), pm, p);
        vm.prank(owner);
        SealedBatchMarket m = SealedBatchMarket(f2.create(address(stock), address(feed), noPool));
        half.transfer(alice, 1_000e18);
        ISealedBatchMarket.Order memory s = _sell(1e18, 1);
        s.payFeeInOrry = true;
        ISealedBatchMarket.Order memory bb = _buy(TSLA_PRICE, type(uint256).max);
        vm.startPrank(alice);
        half.approve(address(m), type(uint256).max);
        stock.approve(address(m), type(uint256).max);
        vm.stopPrank();
        vm.prank(bob);
        usdg.approve(address(m), type(uint256).max);
        (uint256 b,,) = m.phase();
        bytes32 ca = m.commitmentFor(b, alice, s, _salt(alice));
        bytes32 cb = m.commitmentFor(b, bob, bb, _salt(bob));
        vm.prank(alice);
        m.commit(ca);
        vm.prank(bob);
        m.commit(cb);
        vm.warp(m.revealEnd(b) - 60);
        vm.prank(alice);
        m.reveal(s, _salt(alice));
        vm.prank(bob);
        m.reveal(bb, _salt(bob));
        vm.warp(m.revealEnd(b));
        uint80 rid = feed.latestRoundId();
        vm.expectRevert(ISealedBatchMarket.InexactTransfer.selector);
        m.clear(b, rid);
    }

    function test_no_owner_no_setter_no_withdrawal() public view {
        // the full ABI is checked against the frozen one by test/markets/check_abi.py; here: no owner-like getters
        (bool ok,) = address(market).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
        (ok,) = address(market).staticcall(abi.encodeWithSignature("paused()"));
        assertFalse(ok);
    }
}
