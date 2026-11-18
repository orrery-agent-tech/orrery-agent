// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Fee discount from ORRY stake (`docs/ORRY-R1-SPEC.md` 2.4, lever L2). Reads OrryStaking.earningBalance.
/// Thresholds are USD values (utility 10, R-44, R-46): the account's earning balance is valued with `IOrryPriceOracle`,
/// so a tier stays reachable after ORRY's price moves. While the price oracle is not ready, every discount is 0.
interface IFeeTiers {
    function staking() external view returns (address);
    function orryPrice() external view returns (address);
    function tierCount() external view returns (uint256);
    /// @notice Tier `i`: the USD value (USDG base units, 6 decimals) of earning stake it needs, and its discount.
    function tier(uint256 i) external view returns (uint256 minStakeUsd, uint16 discountBps);
    /// @notice USD value of the account's earning balance now; 0 while the price oracle is not ready.
    function stakeUsd(address account) external view returns (uint256);
    /// @notice The highest tier the account's stake value reaches; 0 when none or while the oracle is not ready.
    function discountBps(address account) external view returns (uint16);
}

/// @notice ORRY in USD (`docs/ORRY-R1-SPEC.md` 2.3, with R-35): the ORRY/USDG hub's 30 minute mean tick
/// (`OrreryHook.consult(usdg, WINDOW)`, USDG taken at 1 USD) once that hub has `WINDOW` of history; until then the
/// ORRY/ETH hub's mean tick times the Chainlink ETH/USD feed. Hub ticks are the pool's own (currency1 per currency0);
/// `OrreryHook.pairOf(quote).orryIsCurrency0` gives the orientation.
interface IOrryPriceOracle {
    function hook() external view returns (address);
    function usdg() external view returns (address);
    function ethUsdFeed() external view returns (address);
    function WINDOW() external view returns (uint32); // 1800 seconds
    function ready() external view returns (bool);
    /// @notice The price `usdValue` and `orryFor` use now: 1 the USDG hub, 2 the ETH hub times ETH/USD, 0 not ready.
    function source() external view returns (uint8);
    /// @notice USD value, in USDG base units (6 decimals), of `orryAmount` ORRY; reverts when not ready.
    function usdValue(uint256 orryAmount) external view returns (uint256);
    /// @notice ORRY base units worth `usd` USDG base units, rounded up; reverts when not ready.
    function orryFor(uint256 usd) external view returns (uint256);
}
