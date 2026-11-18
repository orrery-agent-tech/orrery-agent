// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IFeeTiers, IOrryPriceOracle} from "./interfaces/IMarketPricing.sol";

/// @notice Stands in for the ORRY token, its price oracle and the stake fee tiers so the wave R1 markets can run before
/// ORRY exists (USDG-only mode, owner decision 2026-11-17). Pass this one address as `orry`, `orryPrice` and `feeTiers`
/// to `MarketFactory`.
///
/// A market built on it reads ORRY as never ready, so every ORRY path stays shut through code that already exists:
/// `commit` burns no sealing fee (`_orryFor` returns not ok), an order with `payFeeInOrry` pays its fee in USDG
/// (`_pullOne` needs `orryReady`), and every stake discount is 0. `clear` reads `totalSupply` before and after and
/// finds 0 both times. The token transfer functions (`burnFrom`, `transferFrom`) do not exist here, so a path that
/// reached them would revert rather than move anything.
///
/// No storage, no owner, nothing to configure. The factory's ORRY addresses are immutable, so when ORRY launches the
/// markets move to a new factory built on the real contracts (`deploy-markets-4663.ts` without `--usdg-only`).
contract OrryUnset is IOrryPriceOracle, IFeeTiers {
    error OrryNotSet();

    // ------------------------------------------------------------------ IOrryPriceOracle: never ready

    function hook() external pure returns (address) {
        return address(0);
    }

    function usdg() external pure returns (address) {
        return address(0);
    }

    function ethUsdFeed() external pure returns (address) {
        return address(0);
    }

    function WINDOW() external pure returns (uint32) {
        return 1800;
    }

    function ready() external pure returns (bool) {
        return false;
    }

    function source() external pure returns (uint8) {
        return 0;
    }

    function usdValue(uint256) external pure returns (uint256) {
        revert OrryNotSet();
    }

    function orryFor(uint256) external pure returns (uint256) {
        revert OrryNotSet();
    }

    // ------------------------------------------------------------------ IFeeTiers: no tiers, no discount

    function staking() external view returns (address) {
        return address(this);
    }

    function orryPrice() external view returns (address) {
        return address(this);
    }

    function tierCount() external pure returns (uint256) {
        return 0;
    }

    function tier(uint256) external pure returns (uint256, uint16) {
        revert OrryNotSet();
    }

    function stakeUsd(address) external pure returns (uint256) {
        return 0;
    }

    function discountBps(address) external pure returns (uint16) {
        return 0;
    }

    // ------------------------------------------------------------------ the token and staking reads a market makes

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function earningBalance(address) external pure returns (uint256) {
        return 0;
    }
}
