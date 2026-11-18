// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {IOrryPriceOracle} from "./interfaces/IMarketPricing.sol";
import {IOrreryHook} from "../orry/interfaces/IOrreryHook.sol";
import {IChainlinkFeed} from "./ChainlinkFeed.sol";

/// @notice ORRY in USD (`docs/ORRY-R1-SPEC.md` 2.3, R-35, `docs/ORRY-PAIRS-B-INTERFACES.md`). USD amounts are USDG base
/// units (6 decimals); USDG is taken at 1 USD.
/// - Source 1: the ORRY/USDG hub's mean tick over `WINDOW` (`OrreryHook.consult(usdg, WINDOW)`), once that hub has the
///   history.
/// - Source 2, until then: the ORRY/ETH hub's mean tick over `WINDOW` (`consult(address(0), WINDOW)`) times the Chainlink
///   ETH/USD feed, while the feed is fresh.
/// Hub ticks are the pool's own (currency1 per currency0); `pairOf(quote).orryIsCurrency0` gives the orientation, so the
/// tick of "ORRY per quote" is the mean tick, negated when ORRY is currency0. No owner, no setter.
contract OrryPriceOracle is IOrryPriceOracle {
    uint32 public constant WINDOW = 1800;
    uint256 private constant USD_DECIMALS = 6;
    uint8 private constant SOURCE_NONE = 0;
    uint8 private constant SOURCE_USDG_HUB = 1;
    uint8 private constant SOURCE_ETH_HUB = 2;

    address public immutable hook;
    address public immutable usdg;
    address public immutable ethUsdFeed;
    uint256 private immutable _maxEthStaleness;
    /// @dev 10^(18 + feed decimals - 6): ETH base units times the feed answer, divided by this, is USDG base units.
    uint256 private immutable _usdScale;

    constructor(address hook_, address usdg_, address ethUsdFeed_, uint256 maxEthStaleness_) {
        require(hook_ != address(0) && usdg_ != address(0) && ethUsdFeed_ != address(0), "zero address");
        require(maxEthStaleness_ != 0, "zero staleness");
        uint8 d = IChainlinkFeed(ethUsdFeed_).decimals();
        require(d >= USD_DECIMALS && d <= 36, "feed decimals");
        hook = hook_;
        usdg = usdg_;
        ethUsdFeed = ethUsdFeed_;
        _maxEthStaleness = maxEthStaleness_;
        _usdScale = 10 ** (18 + d - USD_DECIMALS);
    }

    function ready() external view returns (bool) {
        return source() != SOURCE_NONE;
    }

    function source() public view returns (uint8) {
        (bool ok,) = _orryPerQuoteTick(usdg);
        if (ok) return SOURCE_USDG_HUB;
        (ok,) = _orryPerQuoteTick(address(0));
        if (!ok) return SOURCE_NONE;
        (bool fresh,) = _ethUsd();
        return fresh ? SOURCE_ETH_HUB : SOURCE_NONE;
    }

    function usdValue(uint256 orryAmount) external view returns (uint256) {
        (uint8 src, int24 tick, uint256 ethUsd) = _price();
        (uint256 ratio, bool x192) = _ratio(tick);
        // quote amount worth `orryAmount`, rounded down: orry / (ORRY per quote)
        uint256 quoteAmount = x192
            ? FullMath.mulDiv(orryAmount, 1 << 192, ratio)
            : FullMath.mulDiv(orryAmount, 1 << 128, ratio);
        return src == SOURCE_USDG_HUB ? quoteAmount : FullMath.mulDiv(quoteAmount, ethUsd, _usdScale);
    }

    function orryFor(uint256 usd) external view returns (uint256) {
        (uint8 src, int24 tick, uint256 ethUsd) = _price();
        uint256 quoteAmount = src == SOURCE_USDG_HUB ? usd : FullMath.mulDivRoundingUp(usd, _usdScale, ethUsd);
        (uint256 ratio, bool x192) = _ratio(tick);
        return x192
            ? FullMath.mulDivRoundingUp(ratio, quoteAmount, 1 << 192)
            : FullMath.mulDivRoundingUp(ratio, quoteAmount, 1 << 128);
    }

    /// @dev The source in use and its "ORRY per quote" mean tick; reverts `OracleNotReady` when there is none.
    function _price() private view returns (uint8 src, int24 tick, uint256 ethUsd) {
        bool ok;
        (ok, tick) = _orryPerQuoteTick(usdg);
        if (ok) return (SOURCE_USDG_HUB, tick, 0);
        (ok, tick) = _orryPerQuoteTick(address(0));
        bool fresh;
        (fresh, ethUsd) = _ethUsd();
        if (!ok || !fresh) revert IOrreryHook.OracleNotReady();
        return (SOURCE_ETH_HUB, tick, ethUsd);
    }

    /// @dev The hub of `quote` (address 0 = native ETH): its mean tick over WINDOW oriented as ORRY per quote, or not
    /// ok while the pair is unknown, not initialized or its history is shorter than WINDOW.
    function _orryPerQuoteTick(address quote) private view returns (bool ok, int24 tick) {
        IOrreryHook.Pair memory p;
        try IOrreryHook(hook).pairOf(quote) returns (IOrreryHook.Pair memory pair) {
            p = pair;
        } catch {
            return (false, 0);
        }
        if (!p.initialized) return (false, 0);
        try IOrreryHook(hook).consult(quote, WINDOW) returns (int24 meanTick, uint32) {
            return (true, p.orryIsCurrency0 ? -meanTick : meanTick);
        } catch {
            return (false, 0);
        }
    }

    /// @dev ORRY per quote at `tick`, as sqrtP^2 (X192) or, when sqrtP does not fit 128 bits, sqrtP^2 / 2^64 (X128), as
    /// in Uniswap's OracleLibrary.
    function _ratio(int24 tick) private pure returns (uint256 ratio, bool x192) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtP <= type(uint128).max) return (uint256(sqrtP) * sqrtP, true);
        return (FullMath.mulDiv(sqrtP, sqrtP, 1 << 64), false);
    }

    function _ethUsd() private view returns (bool fresh, uint256 answer) {
        try IChainlinkFeed(ethUsdFeed).latestRoundData() returns (uint80, int256 a, uint256, uint256 updatedAt, uint80) {
            if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);
            if (block.timestamp - updatedAt > _maxEthStaleness) return (false, 0);
            return (true, uint256(a));
        } catch {
            return (false, 0);
        }
    }
}
