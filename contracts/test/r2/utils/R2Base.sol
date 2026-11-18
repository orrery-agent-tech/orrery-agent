// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MarketBase} from "../../markets/utils/MarketBase.sol";
import {PredictionMarketFactory} from "../../../src/markets/r2/PredictionMarketFactory.sol";
import {PredictionMarket} from "../../../src/markets/r2/PredictionMarket.sol";
import {PredictionParams} from "../../../src/markets/r2/interfaces/IPrediction.sol";

/// @notice Prediction markets on the R1 test world (`MarketBase`, read only): TSLA-like stock with its feed at 358.25 USD,
/// USDG, ORRY at about 223 USD per 100,000 ORRY, fee tiers 100 USD -> 25% and 1,000 USD -> 50%. The factory uses the
/// spec's guesses (`docs/updates/L3-R2-SPEC.md` 3.1): fee 2%, lock 30 minutes, minimum stake 1 USDG, creation fee 1 USD
/// of ORRY, ORRY fee discount 25%.
abstract contract PredictionBase is MarketBase {
    int256 internal constant STRIKE = 360_00000000; // 360 USD in the feed's 8 decimals

    PredictionMarketFactory internal pmf;

    function _predictionParams() internal pure virtual returns (PredictionParams memory) {
        return PredictionParams({
            feeBps: 200, lockSeconds: 1800, minStake: 1e6, creationFeeUsd: 1e6, orryFeeDiscountBps: 2500
        });
    }

    function setUp() public virtual override {
        super.setUp();
        pmf = new PredictionMarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), _predictionParams()
        );
        vm.startPrank(owner);
        pmf.listFeed(address(feed), address(stock));
        pmf.listFeed(address(ethFeed), address(0));
        vm.stopPrank();
        for (uint256 i; i < traders.length; ++i) {
            vm.prank(traders[i]);
            orry.approve(address(pmf), type(uint256).max);
        }
    }

    /// @dev A TSLA market created by trader 0, closing `secs` from now; every trader approves it.
    function _create(int256 strike, uint256 secs) internal returns (PredictionMarket m) {
        uint64 close = uint64(_now() + secs);
        vm.prank(traders[0]);
        m = PredictionMarket(pmf.create(address(feed), strike, close));
        for (uint256 i; i < traders.length; ++i) {
            vm.startPrank(traders[i]);
            usdg.approve(address(m), type(uint256).max);
            orry.approve(address(m), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _stake(PredictionMarket m, address who, bool yes, uint256 amount) internal {
        vm.prank(who);
        m.stake(yes, amount);
    }

    /// @dev Publishes a round just before the close and one `after_` seconds after it; warps past the close.
    function _roundsAround(PredictionMarket m, int256 before_, int256 at, uint256 after_) internal returns (uint80 id) {
        uint64 close = m.closeTime();
        vm.warp(close - 100);
        feed.push(before_, close - 100);
        vm.warp(close + after_);
        id = feed.push(at, close + after_);
        vm.warp(close + after_ + 1);
    }
}
