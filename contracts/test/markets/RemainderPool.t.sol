// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {SealedBatchMarket} from "../../src/markets/SealedBatchMarket.sol";
import {MarketFactory} from "../../src/markets/MarketFactory.sol";
import {ISealedBatchMarket} from "../../src/markets/interfaces/ISealedBatchMarket.sol";
import {IMarketFactory} from "../../src/markets/interfaces/IMarketFactory.sol";
import {PoolMarketBase} from "./utils/PoolMarketBase.sol";
import {MockStock} from "./utils/MarketMocks.sol";
import {MockERC20} from "../mocks/Mocks.sol";

/// @notice R1b (D-R1-5, DP-11): Swap-mode remainders fill against the market's v4 pool, within each order's limit and
/// within `maxDeviationBps` of the clearing price.
contract RemainderPoolTest is PoolMarketBase {
    using PoolIdLibrary for PoolKey;

    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public override {
        super.setUp();
        (alice, bob, carol) = (traders[0], traders[1], traders[2]);
    }

    // ------------------------------------------------------------------ tests

    /// @dev A 6-decimal asset: one base unit is worth about 358 USDG base units, so a buyer can be left with USDG after the
    /// cross even when sellers are the larger side. That leftover is refunded; only the sellers' remainder meets the pool.
    function test_low_decimal_asset_leftover_on_the_smaller_side_is_refunded() public {
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        (address c0, address c1) = address(six) < address(usdg) ? (address(six), address(usdg)) : (address(usdg), address(six));
        PoolKey memory k6 = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 500, 10, IHooks(address(0)));
        uint256 p6 = uint256(uint256(TSLA_ANSWER)) * 1e6 * 1e18 / 1e14; // USDG base units per 1e18 asset base units
        uint256 ratio = address(six) < address(usdg) ? FullMath.mulDiv(p6, 2 ** 192, 1e18) : FullMath.mulDiv(1e18, 2 ** 192, p6);
        IPoolManager(pm).initialize(k6, uint160(Math.sqrt(ratio)));
        six.mint(address(this), 10_000e6);
        six.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            k6,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(10),
                tickUpper: TickMath.maxUsableTick(10),
                liquidityDelta: int256(uint256(4e10)), // about 2,100 SIX and 760,000 USDG
                salt: 0
            }),
            ""
        );
        vm.prank(owner);
        SealedBatchMarket m6 = SealedBatchMarket(pf.create(address(six), address(feed), k6));
        six.mint(alice, 100e6);
        vm.prank(alice);
        six.approve(address(m6), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(m6), type(uint256).max);
        vm.prank(alice);
        orry.approve(address(m6), type(uint256).max);
        vm.prank(bob);
        orry.approve(address(m6), type(uint256).max);

        ISealedBatchMarket.Order memory sell = _swapSell(5e6, 1); // 5 SIX, the larger side
        ISealedBatchMarket.Order memory buy = _swapBuy(1_000e6 + 123, type(uint256).max);
        (uint256 b,,) = m6.phase();
        bytes32 ca = m6.commitmentFor(b, alice, sell, _salt(alice));
        bytes32 cb = m6.commitmentFor(b, bob, buy, _salt(bob));
        vm.prank(alice);
        m6.commit(ca);
        vm.prank(bob);
        m6.commit(cb);
        vm.warp(m6.revealEnd(b) - 60);
        vm.prank(alice);
        m6.reveal(sell, _salt(alice));
        vm.prank(bob);
        m6.reveal(buy, _salt(bob));
        vm.warp(m6.revealEnd(b));
        uint256 bU = usdg.balanceOf(bob);
        uint80 rid = feed.latestRoundId();
        m6.clear(b, rid);

        ISealedBatchMarket.BatchResult memory r = m6.result(b);
        uint256 crossed = (1_000e6 + 123) * 1e18 / p6; // A = floor(buys / price)
        uint256 paid = (crossed * p6 + 1e18 - 1) / 1e18; // U = ceil(A * price)
        assertGt(1_000e6 + 123 - paid, 0, "the buyer has USDG left after the cross");
        assertEq(r.assetFilled, crossed);
        assertEq(six.balanceOf(bob), crossed, "the buyer gets only the crossed asset");
        assertEq(bU - usdg.balanceOf(bob), paid + paid * 15 / 10_000, "and its leftover is refunded");
        assertEq(r.assetViaPool, 5e6 - crossed, "the seller's remainder went to the pool");
        assertEq(six.balanceOf(address(m6)), 0);
        assertEq(usdg.balanceOf(address(m6)), 0);
    }

    function test_getters_and_listing() public view {
        (PoolKey memory k, bool listed) = pmkt.remainderPool();
        assertTrue(listed);
        assertEq(PoolId.unwrap(k.toId()), PoolId.unwrap(key.toId()));
        assertEq(pmkt.maxDeviationBps(), 50);
        assertEq(pmkt.orryFeeDiscountBps(), 2500);
    }

    function test_swap_seller_alone_fills_in_the_pool_within_the_band() public {
        uint256 b = _one(alice, _swapSell(1e18, 1));
        uint256 aU = usdg.balanceOf(alice);
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        assertEq(r.assetFilled, 0, "no cross");
        assertEq(r.assetViaPool, 1e18, "all through the pool");
        assertEq(stock.balanceOf(alice), 999e18);
        uint256 fee = r.usdgViaPool * 15 / 10_000;
        assertEq(usdg.balanceOf(alice) - aU, r.usdgViaPool - fee, "proceeds net of the Orrery fee");
        assertEq(usdg.balanceOf(treasury), fee);
        // DP-11: realised price within 0.5% of the clearing price
        assertGe(r.usdgViaPool * 10_000, TSLA_PRICE * 9950);
        assertLe(r.usdgViaPool * 10_000, TSLA_PRICE * 10_050);
        assertEq(stock.balanceOf(address(pmkt)), 0);
        assertEq(usdg.balanceOf(address(pmkt)), 0);
    }

    function test_swap_buyer_alone_buys_from_the_pool_within_the_band() public {
        uint256 b = _one(bob, _swapBuy(500e6, type(uint256).max));
        uint256 bU = usdg.balanceOf(bob);
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        assertEq(r.usdgViaPool, 500e6, "all through the pool");
        assertEq(stock.balanceOf(bob) - 1_000e18, r.assetViaPool);
        assertEq(bU - usdg.balanceOf(bob), 500e6 + 500e6 * 15 / 10_000);
        // realised USDG per TSLA within the band
        assertLe(r.usdgViaPool * 1e18 * 10_000, TSLA_PRICE * 10_050 * r.assetViaPool);
        assertGe(r.usdgViaPool * 1e18 * 10_000, TSLA_PRICE * 9950 * r.assetViaPool);
    }

    function test_a_large_buy_stops_at_the_band_and_refunds_the_rest() public {
        // 3,000 USDG would move this pool about 1.6%: the fill stops near the top of the band
        uint256 b = _one(bob, _swapBuy(3_000e6, type(uint256).max));
        uint256 bU = usdg.balanceOf(bob);
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        assertGt(r.usdgViaPool, 0);
        assertLt(r.usdgViaPool, 3_000e6);
        assertEq(bU - usdg.balanceOf(bob), r.usdgViaPool + r.usdgViaPool * 15 / 10_000, "the rest refunded");
        assertLe(r.usdgViaPool * 1e18 * 10_000, TSLA_PRICE * 10_050 * r.assetViaPool);
        // the limit is the band top less the pool's fee (0.05%): about 1.00450 of the clearing price, not 1.005
        assertLe(_poolPrice() * 10_000, TSLA_PRICE * 10_046, "the pool stops inside the band, less its fee");
    }

    function test_limit_mode_never_touches_the_pool() public {
        uint256 b = _one(alice, _sell(1e18, 1));
        _clearP(b);
        assertEq(pmkt.result(b).assetViaPool, 0);
        assertEq(stock.balanceOf(alice), 1_000e18);
    }

    function test_cross_first_then_the_swap_remainder() public {
        address[] memory who = new address[](3);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](3);
        (who[0], who[1], who[2]) = (alice, bob, carol);
        os[0] = _swapSell(2e18, 1);
        os[1] = _sell(1e18, 1);
        os[2] = _buy(TSLA_PRICE, type(uint256).max);
        uint256 b = _placeIn(who, os);
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        assertEq(r.assetFilled, 1e18);
        // the Swap seller crossed 2/3 TSLA and sold its other 4/3 to the pool; the Limit seller kept 2/3
        assertApproxEqAbs(r.assetViaPool, 2e18 - uint256(2e18) / 3, 1);
        assertApproxEqAbs(stock.balanceOf(alice), 998e18, 1);
        assertApproxEqAbs(stock.balanceOf(bob), 1_000e18 - uint256(1e18) / 3, 1);
        assertEq(stock.balanceOf(carol), 1_001e18);
    }

    /// @dev DP-11: an attacker pushes the pool against the order in the same block as `clear`. Beyond the band the leg
    /// does not trade at all; inside it the fill stops at the band.
    function test_DP11_a_pool_push_moves_the_fill_at_most_the_band() public {
        uint256 b = _one(alice, _swapSell(20e18, 1));
        _pushTo(TSLA_PRICE * 97 / 100); // 3% down: the whole band is below the bound already
        _clearP(b);
        assertEq(pmkt.result(b).assetViaPool, 0, "nothing sold below the band");
        assertEq(stock.balanceOf(alice), 1_000e18);

        b = _one(alice, _swapSell(20e18, 1));
        feed.push(TSLA_ANSWER, _now() - 1);
        _pushTo(TSLA_PRICE * 9_980 / 10_000); // 0.2% down
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        assertGt(r.assetViaPool, 0);
        assertLt(r.assetViaPool, 20e18, "the band stops the fill");
        assertGe(r.usdgViaPool * 1e18 * 10_000, TSLA_PRICE * 9950 * r.assetViaPool, "realised within the band");
        // the limit is the band bottom over (1 - fee): about 0.99550 of the clearing price, not 0.995
        assertGe(_poolPrice() * 10_000, TSLA_PRICE * 9_953, "the pool ends at the band edge, adjusted for its fee");
    }

    function test_a_pool_beyond_the_band_on_the_favourable_side_undoes_the_leg() public {
        uint256 b = _one(alice, _swapSell(1e18, 1));
        _pushTo(TSLA_PRICE * 103 / 100);
        _clearP(b);
        assertEq(pmkt.result(b).assetViaPool, 0, "DeviationTooHigh undid the pool leg");
        assertEq(stock.balanceOf(alice), 1_000e18);
        assertTrue(pmkt.result(b).cleared);
    }

    function test_the_order_limit_is_tighter_than_the_band() public {
        // a seller at exactly the clearing price: with the pool's fee no pool fill can reach it
        uint256 b = _one(alice, _swapSell(1e18, TSLA_PRICE));
        _clearP(b);
        assertEq(pmkt.result(b).assetViaPool, 0);
        // a buyer capped at the clearing price likewise
        b = _one(bob, _swapBuy(1_000e6, TSLA_PRICE));
        feed.push(TSLA_ANSWER, _now() - 1);
        _clearP(b);
        assertEq(pmkt.result(b).usdgViaPool, 0);
    }

    function test_one_order_past_its_bound_does_not_stop_the_others() public {
        // alice's limit sits above the pool; bob's does not: bob still sells through the pool
        address[] memory who = new address[](2);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](2);
        (who[0], who[1]) = (alice, bob);
        os[0] = _swapSell(1e18, TSLA_PRICE * 10_040 / 10_000);
        os[1] = _swapSell(1e18, 1);
        // the clearing price is 0.45% above the pool's start, the pool sits 0.2% above it: inside bob's band, below
        // alice's limit
        feed.push(TSLA_ANSWER * 10_045 / 10_000, START - 30);
        _pushTo(TSLA_PRICE * 10_020 / 10_000);
        uint256 b = _placeIn(who, os);
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        assertEq(stock.balanceOf(alice), 1_000e18, "alice: the pool is below her bound");
        assertEq(stock.balanceOf(bob), 999e18, "bob: sold through the pool");
        assertEq(r.assetViaPool, 1e18);
    }

    function test_orry_fee_on_a_pool_fill_above_the_clearing_price() public {
        _pushTo(TSLA_PRICE * 10_030 / 10_000); // the pool pays 0.3% more than the feed: still inside the band
        ISealedBatchMarket.Order memory o = _swapSell(1e18, 1);
        o.payFeeInOrry = true;
        uint256 b = _one(alice, o);
        uint256 supply = orry.totalSupply();
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        assertGt(r.usdgViaPool, TSLA_PRICE, "sold above the clearing price");
        uint256 usdFee = r.usdgViaPool * 15 / 10_000;
        assertEq(supply - orry.totalSupply(), orryPrice.orryFor(usdFee * 7500 / 10_000), "fee on what was earned");
    }

    function test_fee_in_orry_covers_the_pool_leg() public {
        ISealedBatchMarket.Order memory o = _swapSell(1e18, 1);
        o.payFeeInOrry = true;
        uint256 b = _one(alice, o);
        uint256 supply = orry.totalSupply();
        _clearP(b);
        ISealedBatchMarket.BatchResult memory r = pmkt.result(b);
        uint256 usdFee = r.usdgViaPool * 15 / 10_000;
        assertEq(supply - orry.totalSupply(), orryPrice.orryFor(usdFee * 7500 / 10_000));
        assertEq(r.orryFeesBurned, supply - orry.totalSupply());
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_an_issuer_block_on_the_pool_manager_skips_the_leg() public {
        uint256 b = _one(alice, _swapSell(1e18, 1));
        registry.setBlocked(pm, true);
        _clearP(b);
        assertEq(pmkt.result(b).assetViaPool, 0);
        assertEq(stock.balanceOf(alice), 1_000e18);
    }

    function test_unlock_callback_refuses_outsiders() public {
        vm.expectRevert(ISealedBatchMarket.WrongPhase.selector);
        pmkt.unlockCallback("");
        vm.prank(pm);
        vm.expectRevert(ISealedBatchMarket.WrongPhase.selector);
        pmkt.unlockCallback("");
    }

    function test_factory_checks_the_pool_and_reports_its_id() public {
        MockStock other = new MockStock(registry);
        PoolKey memory wrong = PoolKey(key.currency0, key.currency1, 500, 10, IHooks(address(0)));
        vm.prank(owner);
        vm.expectRevert(bytes("pool currencies"));
        pf.create(address(other), address(feed), wrong);
        (address c0, address c1) =
            address(other) < address(usdg) ? (address(other), address(usdg)) : (address(usdg), address(other));
        PoolKey memory hooked = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 500, 10, IHooks(address(0x1234)));
        vm.prank(owner);
        vm.expectRevert(bytes("pool hooks"));
        pf.create(address(other), address(feed), hooked);
        PoolKey memory good = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(pf)); // the market address is not known yet; the data is checked
        emit IMarketFactory.MarketCreated(address(other), address(0), address(feed), PoolId.unwrap(good.toId()));
        pf.create(address(other), address(feed), good);
    }
}
