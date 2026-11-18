// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {FeeTiers} from "../../src/markets/FeeTiers.sol";
import {OrryPriceOracle} from "../../src/markets/OrryPriceOracle.sol";
import {MarketFactory} from "../../src/markets/MarketFactory.sol";
import {SealedBatchMarket} from "../../src/markets/SealedBatchMarket.sol";
import {MarketParams} from "../../src/markets/MarketParams.sol";
import {IMarketFactory} from "../../src/markets/interfaces/IMarketFactory.sol";
import {IOrreryHook} from "../../src/orry/interfaces/IOrreryHook.sol";
import {MarketBase} from "./utils/MarketBase.sol";
import {MockEarningStaking, MockFeed, OracleHookStandIn, MockStock, MockAccessRegistry} from "./utils/MarketMocks.sol";

/// @dev Reports `ready` as set, and always quotes 1 USD per ORRY.
contract LyingOracle {
    bool public ready;

    function setReady(bool r) external {
        ready = r;
    }

    function usdValue(uint256 orryAmount) external pure returns (uint256) {
        return orryAmount / 1e12;
    }
}

contract FeeTiersTest is Test {
    MockEarningStaking internal staking = new MockEarningStaking();
    OracleHookStandIn internal hook = new OracleHookStandIn();
    MockFeed internal ethFeed = new MockFeed(8);
    OrryPriceOracle internal oracle;
    FeeTiers internal t;
    address internal a = makeAddr("a");
    uint256 internal constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        oracle = new OrryPriceOracle(address(hook), makeAddr("usdg"), address(ethFeed), 25 hours);
        ethFeed.push(2235e8, T0 - 60);
        hook.set(138200, T0 - 1 hours); // about 0.00223 USD per ORRY
        t = _tiers(100e6, 1_000e6, 2500, 5000);
    }

    function _tiers(uint256 lo, uint256 hi, uint16 dlo, uint16 dhi) internal returns (FeeTiers) {
        uint256[] memory mins = new uint256[](2);
        uint16[] memory ds = new uint16[](2);
        (mins[0], mins[1], ds[0], ds[1]) = (lo, hi, dlo, dhi);
        return new FeeTiers(address(staking), address(oracle), mins, ds);
    }

    function _tiersReverts(uint256 lo, uint256 hi, uint16 dlo, uint16 dhi, string memory why) internal {
        uint256[] memory mins = new uint256[](2);
        uint16[] memory ds = new uint16[](2);
        (mins[0], mins[1], ds[0], ds[1]) = (lo, hi, dlo, dhi);
        try new FeeTiers(address(staking), address(oracle), mins, ds) returns (FeeTiers) {
            revert("constructor did not revert");
        } catch Error(string memory reason) {
            assertEq(reason, why);
        }
    }

    function test_tiers_and_usd_boundaries() public {
        assertEq(t.staking(), address(staking));
        assertEq(t.orryPrice(), address(oracle));
        assertEq(t.tierCount(), 2);
        (uint256 m, uint16 d) = t.tier(1);
        assertEq(m, 1_000e6);
        assertEq(d, 5000);
        assertEq(t.discountBps(a), 0);
        // the least stake worth 100 USD, and a little less
        uint256 atLow = oracle.orryFor(100e6);
        staking.set(a, atLow);
        assertEq(t.stakeUsd(a), oracle.usdValue(atLow));
        assertGe(t.stakeUsd(a), 100e6);
        assertEq(t.discountBps(a), 2500);
        staking.set(a, atLow - 1_000e18); // about 2.2 USD less
        assertLt(t.stakeUsd(a), 100e6);
        assertEq(t.discountBps(a), 0);
        uint256 atHigh = oracle.orryFor(1_000e6);
        staking.set(a, atHigh - 1_000e18);
        assertEq(t.discountBps(a), 2500);
        staking.set(a, atHigh);
        assertEq(t.discountBps(a), 5000);
        staking.set(a, type(uint128).max);
        assertEq(t.discountBps(a), 5000);
    }

    function test_no_discount_while_the_oracle_is_not_ready() public {
        staking.set(a, 10_000_000e18); // about 22,000 USD
        assertEq(t.discountBps(a), 5000);
        hook.set(138200, T0 - 10 minutes); // under 30 minutes of hub history
        assertEq(t.stakeUsd(a), 0);
        assertEq(t.discountBps(a), 0);
        hook.set(138200, T0 - 1 hours);
        ethFeed.push(2235e8, T0 - 26 hours); // ETH/USD stale and no USDG hub
        assertEq(t.discountBps(a), 0);
    }

    function test_ready_is_checked_even_if_the_oracle_still_quotes() public {
        // an oracle that reports not ready but would still quote a value: the tiers ignore the quote
        LyingOracle lying = new LyingOracle();
        uint256[] memory mins = new uint256[](1);
        uint16[] memory ds = new uint16[](1);
        (mins[0], ds[0]) = (100e6, 2500);
        FeeTiers ft = new FeeTiers(address(staking), address(lying), mins, ds);
        staking.set(a, 1e24);
        assertEq(ft.stakeUsd(a), 0);
        assertEq(ft.discountBps(a), 0);
        lying.setReady(true);
        assertEq(ft.stakeUsd(a), 1_000_000e6);
        assertEq(ft.discountBps(a), 2500);
    }

    function test_a_price_move_changes_the_tier() public {
        staking.set(a, 50_000e18); // about 111 USD
        assertEq(t.discountBps(a), 2500);
        hook.set(138200 + 6932, T0 - 1 hours); // twice as much ORRY per ETH: ORRY halves, about 56 USD
        assertEq(t.discountBps(a), 0);
        hook.set(138200 - 23027, T0 - 1 hours); // ten times fewer ORRY per ETH: ORRY x10, about 1,115 USD
        assertEq(t.discountBps(a), 5000);
    }

    function test_constructor_rules() public {
        uint256[] memory mins = new uint256[](0);
        uint16[] memory ds = new uint16[](0);
        FeeTiers none = new FeeTiers(address(staking), address(oracle), mins, ds);
        staking.set(address(1), 1e30);
        assertEq(none.discountBps(address(1)), 0);
        _ctorReverts(address(0), address(oracle), mins, ds, "zero address");
        _ctorReverts(address(staking), address(0), mins, ds, "zero address");
        _tiersReverts(2e6, 1e6, 100, 200, "unordered tiers");
        _tiersReverts(1e6, 2e6, 200, 100, "unordered tiers");
        _tiersReverts(0, 2e6, 100, 200, "bad tier");
        _tiersReverts(1e6, 2e6, 100, 10_001, "bad tier");
        uint256[] memory one = new uint256[](1);
        _ctorReverts(address(staking), address(oracle), one, ds, "bad tiers");
    }

    /// @dev try/catch rather than expectRevert: with dynamic test linking a `new` becomes `vm.deployCode`, and an
    /// expected revert there ends the test, so later checks would never run.
    function _ctorReverts(address st, address op, uint256[] memory mins, uint16[] memory ds, string memory why) internal {
        try new FeeTiers(st, op, mins, ds) returns (FeeTiers) {
            revert("constructor did not revert");
        } catch Error(string memory reason) {
            assertEq(reason, why);
        }
    }

}

contract OrryPriceOracleTest is Test {
    OracleHookStandIn internal hook = new OracleHookStandIn();
    MockFeed internal ethFeed = new MockFeed(8);
    OrryPriceOracle internal oracle;
    address internal usdgToken = makeAddr("usdg");
    uint256 internal constant T0 = 1_800_000_000;
    int24 internal constant USDG_HUB_TICK = 337400; // about 4.48e14 ORRY base units per USDG base unit (448 per USDG)

    function setUp() public {
        vm.warp(T0);
        oracle = new OrryPriceOracle(address(hook), usdgToken, address(ethFeed), 25 hours);
        ethFeed.push(2235e8, T0 - 60);
        hook.set(138200, T0 - 1 hours);
    }

    /// @dev Independent reference: 1.0001^tick in 1e18 fixed point by repeated squaring.
    function _pow(int24 tick) internal pure returns (uint256 r) {
        uint256 base = 1.0001e18;
        uint256 e = uint256(int256(tick < 0 ? -tick : tick));
        r = 1e18;
        while (e != 0) {
            if (e & 1 == 1) r = FullMath.mulDiv(r, base, 1e18);
            e >>= 1;
            if (e != 0) base = FullMath.mulDiv(base, base, 1e18);
        }
        if (tick < 0) r = 1e36 / r;
    }

    function test_values_match_an_independent_reference() public view {
        assertTrue(oracle.ready());
        assertEq(oracle.WINDOW(), 1800);
        assertEq(oracle.hook(), address(hook));
        assertEq(oracle.ethUsdFeed(), address(ethFeed));
        assertEq(oracle.usdg(), usdgToken);
        assertEq(oracle.source(), 2, "the USDG hub is not registered here: the ETH path");
        uint256 orryPerEth = _pow(138200); // 1e18 scaled
        // 1,000 ORRY in USDG: 1000 / orryPerEth ETH * 2235 USD
        uint256 expected = uint256(1000e18) * 1e18 / orryPerEth * 2235 / 1e12;
        uint256 got = oracle.usdValue(1000e18);
        assertApproxEqRel(got, expected, 1e12); // 1e-6 relative: the reference compounds rounding
        // 1 USD in ORRY
        uint256 rc = oracle.orryFor(1e6);
        uint256 expectedRc = orryPerEth * 1e18 / 2235e18 * 1e18 / 1e18;
        assertApproxEqRel(rc, expectedRc, 1e12);
    }

    function test_rounding_favours_the_protocol() public view {
        for (uint256 usd = 1; usd < 2e6; usd += 99_991) {
            uint256 r = oracle.orryFor(usd);
            assertGe(oracle.usdValue(r), usd); // never charges less than asked
            assertLe(oracle.usdValue(r), usd + 1); // and at most one base unit more
        }
    }

    function test_high_ticks_take_the_x128_path_and_match_the_reference() public {
        int24[3] memory ticks = [int24(443000), int24(500000), int24(800000)];
        for (uint256 i; i < 3; ++i) {
            hook.set(ticks[i], T0 - 1 hours);
            uint256 orryPerEth = _pow(ticks[i]);
            uint256 expected = orryPerEth / 2235; // 1 USD of ORRY
            assertApproxEqRel(oracle.orryFor(1e6), expected, 1e12);
        }
    }

    function test_negative_and_extreme_ticks() public {
        hook.set(-50000, T0 - 1 hours);
        assertGt(oracle.orryFor(1e6), 0);
        hook.set(887000, T0 - 1 hours); // sqrtP above 2^128 takes the X128 path
        uint256 r = oracle.orryFor(1e6);
        assertGe(oracle.usdValue(r), 1e6);
        hook.set(-887000, T0 - 1 hours);
        assertGe(oracle.orryFor(1e6), 1);
    }

    function test_not_ready_cases() public {
        hook.set(138200, T0 - 29 minutes);
        assertFalse(oracle.ready());
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        oracle.orryFor(1e6);
        hook.set(138200, T0 - 1 hours);
        ethFeed.push(2235e8, T0 - 25 hours - 1);
        assertFalse(oracle.ready());
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        oracle.usdValue(1e18);
        ethFeed.push(0, T0);
        assertFalse(oracle.ready());
        ethFeed.push(2235e8, T0 + 10); // from the future
        assertFalse(oracle.ready());
        ethFeed.push(2235e8, T0);
        assertTrue(oracle.ready());
    }

    function test_constructor_rules() public {
        _oracleReverts(address(0), usdgToken, address(ethFeed), 1, "zero address");
        _oracleReverts(address(hook), address(0), address(ethFeed), 1, "zero address");
        _oracleReverts(address(hook), usdgToken, address(0), 1, "zero address");
        _oracleReverts(address(hook), usdgToken, address(ethFeed), 0, "zero staleness");
        MockFeed odd = new MockFeed(4);
        _oracleReverts(address(hook), usdgToken, address(odd), 1, "feed decimals");
    }

    /// @dev try/catch rather than expectRevert: with dynamic test linking a `new` becomes `vm.deployCode`, and an
    /// expected revert there ends the test, so later checks would never run.
    function _oracleReverts(address h, address u, address f, uint256 st, string memory why) internal {
        try new OrryPriceOracle(h, u, f, st) returns (OrryPriceOracle) {
            revert("constructor did not revert");
        } catch Error(string memory reason) {
            assertEq(reason, why);
        }
    }

    // ---------------------------------------------------------------- the USDG hub first (R-35)

    function test_usdg_hub_is_preferred_once_it_has_the_history() public {
        hook.setHub(usdgToken, true, false, USDG_HUB_TICK, T0 - 1 hours); // USDG is currency0
        assertEq(oracle.source(), 1);
        assertTrue(oracle.ready());
        uint256 orryPerUsdg = _pow(USDG_HUB_TICK); // 1e18 scaled, ORRY base units per USDG base unit
        // 1,000 ORRY in USDG base units: 1000e18 / orryPerUsdg
        uint256 expected = uint256(1000e18) * 1e18 / orryPerUsdg;
        assertApproxEqRel(oracle.usdValue(1000e18), expected, 1e12);
        assertApproxEqRel(oracle.orryFor(1e6), orryPerUsdg * 1e6 / 1e18, 1e12);
        // the ETH feed does not matter on this source
        ethFeed.push(2235e8, T0 - 30 hours);
        assertEq(oracle.source(), 1);
        assertGt(oracle.orryFor(1e6), 0);
    }

    function test_usdg_hub_orientation_is_flipped_when_orry_is_currency0() public {
        hook.setHub(usdgToken, true, false, USDG_HUB_TICK, T0 - 1 hours);
        uint256 a = oracle.usdValue(1000e18);
        uint256 r = oracle.orryFor(5e6);
        hook.setHub(usdgToken, true, true, -USDG_HUB_TICK, T0 - 1 hours); // the same price, ORRY as currency0
        assertEq(oracle.usdValue(1000e18), a);
        assertEq(oracle.orryFor(5e6), r);
    }

    function test_falls_back_to_the_eth_path() public {
        hook.setHub(usdgToken, true, false, USDG_HUB_TICK, T0 - 10 minutes); // under 30 minutes of history
        assertEq(oracle.source(), 2);
        uint256 viaEth = oracle.usdValue(1000e18);
        uint256 orryPerEth = _pow(138200);
        assertApproxEqRel(viaEth, uint256(1000e18) * 1e18 / orryPerEth * 2235 / 1e12, 1e12);
        hook.setHub(usdgToken, false, false, USDG_HUB_TICK, T0 - 1 hours); // registered, not initialized
        assertEq(oracle.source(), 2);
        ethFeed.push(2235e8, T0 - 26 hours);
        assertEq(oracle.source(), 0);
        assertFalse(oracle.ready());
        vm.expectRevert(IOrreryHook.OracleNotReady.selector);
        oracle.usdValue(1e18);
        hook.setHub(usdgToken, true, false, USDG_HUB_TICK, T0 - 1 hours);
        assertEq(oracle.source(), 1, "the USDG hub alone is enough");
    }
}

contract MarketFactoryTest is MarketBase {
    function test_create_records_one_market_per_asset() public {
        assertEq(factory.owner(), owner);
        assertEq(factory.marketCount(), 1);
        assertEq(factory.marketAt(0), address(market));
        assertEq(factory.marketOf(address(stock)), address(market));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMarketFactory.MarketExists.selector, address(market)));
        factory.create(address(stock), address(feed), noPool);

        MockStock other = new MockStock(registry);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IMarketFactory.NotOwner.selector);
        factory.create(address(other), address(feed), noPool);
        vm.prank(owner);
        vm.expectRevert(IMarketFactory.ZeroAddress.selector);
        factory.create(address(0), address(feed), noPool);
        vm.prank(owner);
        vm.expectRevert(IMarketFactory.ZeroAddress.selector);
        factory.create(address(other), address(0), noPool);

        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(factory));
        emit IMarketFactory.MarketCreated(address(other), address(0), address(feed), bytes32(0));
        address m = factory.create(address(other), address(feed), noPool);
        assertEq(factory.marketCount(), 2);
        assertEq(SealedBatchMarket(m).asset(), address(other));
        assertEq(SealedBatchMarket(m).feeBps(), 15);
        assertEq(SealedBatchMarket(m).treasury(), treasury);
    }

    function test_two_step_ownership() public {
        address next = makeAddr("next");
        vm.prank(next);
        vm.expectRevert(IMarketFactory.NotOwner.selector);
        factory.transferOwnership(next);
        vm.prank(owner);
        vm.expectEmit(address(factory));
        emit IMarketFactory.OwnershipTransferStarted(owner, next);
        factory.transferOwnership(next);
        assertEq(factory.pendingOwner(), next);
        vm.prank(owner);
        vm.expectRevert(IMarketFactory.NotOwner.selector);
        factory.acceptOwnership();
        vm.prank(next);
        vm.expectEmit(address(factory));
        emit IMarketFactory.OwnershipTransferred(owner, next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
        assertEq(factory.pendingOwner(), address(0));
        vm.prank(next);
        factory.transferOwnership(address(0)); // cancel: nobody can accept
        vm.prank(address(0));
        vm.expectRevert(IMarketFactory.NotOwner.selector);
        factory.acceptOwnership();
    }

    function test_constructor_rules() public {
        MarketParams memory p = _params();
        _factoryReverts(address(0), p, abi.encodeWithSelector(IMarketFactory.ZeroAddress.selector));
        p.feeBps = 51;
        _factoryReverts(owner, p, abi.encodeWithSignature("Error(string)", "fee"));
        p = _params();
        p.revealSeconds = 59;
        _factoryReverts(owner, p, abi.encodeWithSignature("Error(string)", "windows"));
        p = _params();
        p.commitSeconds = 59;
        _factoryReverts(owner, p, abi.encodeWithSignature("Error(string)", "windows"));
        p = _params();
        p.maxStaleness = 0;
        _factoryReverts(owner, p, abi.encodeWithSignature("Error(string)", "staleness"));
        p = _params();
        p.maxDeviationBps = 1001;
        _factoryReverts(owner, p, abi.encodeWithSignature("Error(string)", "deviation"));
        p = _params();
        p.orryFeeDiscountBps = 10_001;
        _factoryReverts(owner, p, abi.encodeWithSignature("Error(string)", "orry discount"));
        p = _params();
        p.feeBps = 50; // the cap itself is allowed
        new MarketFactory(owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), pm, p);
    }

    /// @dev try/catch rather than expectRevert (see `_tiersReverts`): every check runs.
    function _factoryReverts(address o, MarketParams memory p, bytes memory expected) internal {
        try new MarketFactory(o, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), pm, p)
        returns (MarketFactory) {
            revert("constructor did not revert");
        } catch (bytes memory data) {
            assertEq(data, expected);
        }
    }

    function test_market_constructor_rules() public {
        MarketParams memory p = _params();
        _marketReverts(address(stock), address(feed), treasury, p, "zero address", true);
        _marketReverts(address(usdg), address(feed), treasury, p, "same token", false);
        p.maxDeviationBps = 1001;
        _marketReverts(address(stock), address(feed), treasury, p, "deviation", false);
    }

    /// @dev try/catch rather than expectRevert (see `_tiersReverts`): every check runs.
    function _marketReverts(address asset, address f, address tr, MarketParams memory p, string memory why, bool zeroTreasury)
        internal
    {
        try new SealedBatchMarket(
            asset,
            address(usdg),
            f,
            zeroTreasury ? address(0) : tr,
            address(tiers),
            address(orryPrice),
            address(orry),
            pm,
            noPool,
            p
        ) returns (SealedBatchMarket) {
            revert("constructor did not revert");
        } catch Error(string memory reason) {
            assertEq(reason, why);
        }
    }

}
