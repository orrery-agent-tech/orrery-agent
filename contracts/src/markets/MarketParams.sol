// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The fixed parameters of a `SealedBatchMarket`, set once by the `MarketFactory` (`docs/ORRY-R1-SPEC.md` 2.1).
struct MarketParams {
    uint32 commitSeconds;
    uint32 revealSeconds;
    uint16 feeBps; // per side, at most MAX_MARKET_FEE_BPS
    uint256 minNotionalUsdg;
    uint32 maxStaleness; // seconds between the clearing round's update and the reveal window's end
    uint256 commitFeeUsd; // USDG base units of ORRY burned per commit, 0 disables
    uint16 orryFeeDiscountBps; // further discount when the fee is paid in ORRY (L3)
    uint16 maxDeviationBps; // largest gap between a remainder-pool fill and the clearing price (R1b, DP-11)
}

uint16 constant MAX_MARKET_FEE_BPS = 50;
uint16 constant MAX_DEVIATION_BPS = 1000;

function checkMarketParams(MarketParams memory p) pure {
    require(p.commitSeconds >= 60 && p.revealSeconds >= 60, "windows");
    require(p.feeBps <= MAX_MARKET_FEE_BPS, "fee");
    require(p.maxStaleness != 0, "staleness");
    require(p.orryFeeDiscountBps <= 10_000, "orry discount");
    require(p.maxDeviationBps <= MAX_DEVIATION_BPS, "deviation");
}
