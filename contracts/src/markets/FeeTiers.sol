// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IFeeTiers, IOrryPriceOracle} from "./interfaces/IMarketPricing.sol";
import {IOrryStaking} from "../orry/interfaces/IOrryStaking.sol";

/// @notice Fee discount from ORRY stake (`docs/ORRY-R1-SPEC.md` 2.4, lever L2; utility 10, R-44, R-46). An account's
/// earning balance in `OrryStaking` (plain stake plus agent stakes as staker) is valued in USD at `orryPrice`, and that
/// value selects the highest tier it reaches, so a tier stays reachable after ORRY's price moves. While the price oracle
/// is not ready, the value and every discount are 0. Tiers are fixed at deployment: no owner, no setter.
contract FeeTiers is IFeeTiers {
    struct Tier {
        uint256 minStakeUsd; // USDG base units (6 decimals)
        uint16 discountBps;
    }

    uint256 private constant MAX_TIERS = 8;

    address public immutable staking;
    address public immutable orryPrice;
    Tier[] private _tiers;

    /// @param minStakesUsd ascending, each above zero, in USDG base units; @param discounts non-decreasing, each at most
    /// 10,000.
    constructor(address staking_, address orryPrice_, uint256[] memory minStakesUsd, uint16[] memory discounts) {
        require(staking_ != address(0) && orryPrice_ != address(0), "zero address");
        uint256 n = minStakesUsd.length;
        require(n == discounts.length && n <= MAX_TIERS, "bad tiers");
        for (uint256 i; i < n; ++i) {
            require(minStakesUsd[i] != 0 && discounts[i] <= 10_000, "bad tier");
            if (i != 0) {
                require(minStakesUsd[i] > minStakesUsd[i - 1] && discounts[i] >= discounts[i - 1], "unordered tiers");
            }
            _tiers.push(Tier(minStakesUsd[i], discounts[i]));
        }
        staking = staking_;
        orryPrice = orryPrice_;
    }

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tier(uint256 i) external view returns (uint256 minStakeUsd, uint16 discountBps_) {
        Tier storage t = _tiers[i];
        return (t.minStakeUsd, t.discountBps);
    }

    function stakeUsd(address account) public view returns (uint256) {
        try IOrryPriceOracle(orryPrice).ready() returns (bool isReady) {
            if (!isReady) return 0;
        } catch {
            return 0;
        }
        uint256 balance = IOrryStaking(staking).earningBalance(account);
        if (balance == 0) return 0;
        try IOrryPriceOracle(orryPrice).usdValue(balance) returns (uint256 usd) {
            return usd;
        } catch {
            return 0;
        }
    }

    function discountBps(address account) external view returns (uint16) {
        uint256 usd = stakeUsd(account);
        if (usd == 0) return 0;
        for (uint256 i = _tiers.length; i != 0; --i) {
            if (usd >= _tiers[i - 1].minStakeUsd) return _tiers[i - 1].discountBps;
        }
        return 0;
    }
}
