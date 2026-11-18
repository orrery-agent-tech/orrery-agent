// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {SealedBatchMarket} from "../../../src/markets/SealedBatchMarket.sol";
import {MarketFactory} from "../../../src/markets/MarketFactory.sol";
import {FeeTiers} from "../../../src/markets/FeeTiers.sol";
import {OrryPriceOracle} from "../../../src/markets/OrryPriceOracle.sol";
import {MarketParams} from "../../../src/markets/MarketParams.sol";
import {ISealedBatchMarket} from "../../../src/markets/interfaces/ISealedBatchMarket.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {
    MockAccessRegistry,
    MockStock,
    MockUsdg,
    MockFeed,
    MockEarningStaking,
    OracleHookStandIn
} from "./MarketMocks.sol";
import {PoolManagerCode} from "../../orry/stake/utils/PoolManagerCode.sol";

/// @notice One TSLA-like market against USDG with the spec's default parameters (`docs/ORRY-R1-SPEC.md` 2.1, guesses),
/// fee tiers by USD value of stake (100 USD -> 25%, 1,000 USD -> 50%), and ORRY priced by the hub stand-in (tick 138200,
/// about 1,002,600 ORRY per ETH) times ETH at 2,235 USD, so 100,000 ORRY is about 223 USD.
abstract contract MarketBase is Test {
    uint256 internal constant START = 1_800_000_000;
    int256 internal constant TSLA_ANSWER = 358_25000000; // 358.25 USD, 8 decimals
    uint256 internal constant TSLA_PRICE = 358_250000; // USDG base units per 1e18 asset base units
    int256 internal constant ETH_ANSWER = 2235_00000000;
    int24 internal constant HUB_TICK = 138200;

    MockAccessRegistry internal registry;
    MockStock internal stock;
    MockUsdg internal usdg;
    MockOrry internal orry;
    MockFeed internal feed;
    MockFeed internal ethFeed;
    MockEarningStaking internal staking;
    OracleHookStandIn internal hook;
    FeeTiers internal tiers;
    OrryPriceOracle internal orryPrice;
    MarketFactory internal factory;
    SealedBatchMarket internal market;
    address internal pm; // the 4663 PoolManager runtime, etched at its address
    PoolKey internal noPool; // currency1 == 0: no remainder pool

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address[] internal traders;

    function _params() internal pure virtual returns (MarketParams memory) {
        return MarketParams({
            commitSeconds: 240,
            revealSeconds: 60,
            feeBps: 15,
            minNotionalUsdg: 10e6,
            maxStaleness: 25 hours,
            commitFeeUsd: 0.05e6,
            orryFeeDiscountBps: 2500,
            maxDeviationBps: 50
        });
    }

    function setUp() public virtual {
        vm.warp(START);
        vm.etch(PoolManagerCode.ADDRESS, PoolManagerCode.runtime());
        pm = PoolManagerCode.ADDRESS;
        registry = new MockAccessRegistry();
        stock = new MockStock(registry);
        usdg = new MockUsdg();
        orry = new MockOrry(address(this), 1e27);
        feed = new MockFeed(8);
        ethFeed = new MockFeed(8);
        staking = new MockEarningStaking();
        hook = new OracleHookStandIn();
        uint256[] memory mins = new uint256[](2);
        uint16[] memory discounts = new uint16[](2);
        // USD thresholds (utility 10): 100 USD of stake gives 25% off, 1,000 USD gives 50% (USDG base units)
        (mins[0], mins[1], discounts[0], discounts[1]) = (100e6, 1_000e6, 2500, 5000);
        orryPrice = new OrryPriceOracle(address(hook), address(usdg), address(ethFeed), 25 hours);
        tiers = new FeeTiers(address(staking), address(orryPrice), mins, discounts);
        factory = new MarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), pm, _params()
        );
        feed.push(TSLA_ANSWER, START - 60);
        ethFeed.push(ETH_ANSWER, START - 60);
        hook.set(HUB_TICK, START - 2 hours);
        vm.prank(owner);
        market = SealedBatchMarket(factory.create(address(stock), address(feed), noPool));

        for (uint256 i; i < 8; ++i) {
            address t = makeAddr(string(abi.encodePacked("trader", vm.toString(i))));
            traders.push(t);
            stock.mint(t, 1_000e18);
            usdg.mint(t, 1_000_000e6);
            orry.transfer(t, 10_000_000e18);
            vm.startPrank(t);
            stock.approve(address(market), type(uint256).max);
            usdg.approve(address(market), type(uint256).max);
            orry.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ helpers

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _sell(uint256 amount, uint256 limit) internal pure returns (ISealedBatchMarket.Order memory) {
        return ISealedBatchMarket.Order(true, amount, limit, ISealedBatchMarket.Mode.Limit, false);
    }

    function _buy(uint256 amount, uint256 limit) internal pure returns (ISealedBatchMarket.Order memory) {
        return ISealedBatchMarket.Order(false, amount, limit, ISealedBatchMarket.Mode.Limit, false);
    }

    function _salt(address t) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", t));
    }

    function _commit(address t, ISealedBatchMarket.Order memory o) internal returns (uint256 batch) {
        (batch,,) = market.phase();
        bytes32 c = market.commitmentFor(batch, t, o, _salt(t)); // computed first: an external call would take the prank
        vm.prank(t);
        market.commit(c);
    }

    function _reveal(address t, ISealedBatchMarket.Order memory o) internal {
        vm.prank(t);
        market.reveal(o, _salt(t));
    }

    function _toReveal(uint256 batch) internal {
        vm.warp(market.revealEnd(batch) - market.revealSeconds());
    }

    function _toClear(uint256 batch) internal {
        vm.warp(market.revealEnd(batch));
    }

    /// @dev Commit every order, reveal every order, then move to the reveal window's end.
    function _place(address[] memory who, ISealedBatchMarket.Order[] memory orders) internal returns (uint256 batch) {
        for (uint256 i; i < who.length; ++i) {
            batch = _commit(who[i], orders[i]);
        }
        _toReveal(batch);
        for (uint256 i; i < who.length; ++i) {
            _reveal(who[i], orders[i]);
        }
        _toClear(batch);
    }

    function _clear(uint256 batch) internal {
        market.clear(batch, feed.latestRoundId());
    }
}
