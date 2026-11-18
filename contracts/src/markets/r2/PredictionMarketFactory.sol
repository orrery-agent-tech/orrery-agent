// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPredictionMarketFactory, PredictionParams, MAX_PREDICTION_FEE_BPS} from "./interfaces/IPrediction.sol";
import {IOrryPriceOracle} from "../interfaces/IMarketPricing.sol";
import {IOrryToken} from "../../orry/interfaces/IOrryToken.sol";
import {IChainlinkFeed} from "../ChainlinkFeed.sol";
import {PredictionMarket, MarketInit} from "./PredictionMarket.sol";

/// @notice Makes one `PredictionMarket` contract per market (`docs/updates/L3-R2-SPEC.md` 3.1, L3-1, L3-2). The owner (the
/// treasury owner key) can only list feeds, each bound once to the stock token whose corporate actions refund its markets
/// (address 0 for a non-stock feed); it cannot unlist a feed, change a market or move a stake. Anyone creates a market on
/// a listed feed and burns `creationFeeUsd` of ORRY for it (L3, source 30) while the ORRY price is ready.
contract PredictionMarketFactory is IPredictionMarketFactory {
    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 120 days;
    uint8 private constant BURN_CREATION_FEE = 30;

    address public owner;
    address public pendingOwner;
    address public immutable usdg;
    address public immutable treasury;
    address public immutable feeTiers;
    address public immutable orryPrice;
    address public immutable orry;

    uint16 private immutable _feeBps;
    uint32 private immutable _lockSeconds;
    uint256 private immutable _minStake;
    uint256 private immutable _creationFeeUsd;
    uint16 private immutable _orryFeeDiscountBps;

    mapping(address feed => bool) public feedListed;
    mapping(address feed => address) public assetOfFeed;
    address[] private _feeds;
    address[] private _markets;
    mapping(address market => bool) public isMarket;

    constructor(
        address owner_,
        address usdg_,
        address treasury_,
        address feeTiers_,
        address orryPrice_,
        address orry_,
        PredictionParams memory p
    ) {
        if (
            owner_ == address(0) || usdg_ == address(0) || treasury_ == address(0) || feeTiers_ == address(0)
                || orryPrice_ == address(0) || orry_ == address(0)
        ) revert ZeroAddress();
        if (
            p.feeBps > MAX_PREDICTION_FEE_BPS || p.lockSeconds < 60 || p.lockSeconds >= MIN_DURATION || p.minStake == 0
                || p.orryFeeDiscountBps > 10_000
        ) revert BadParams();
        owner = owner_;
        usdg = usdg_;
        treasury = treasury_;
        feeTiers = feeTiers_;
        orryPrice = orryPrice_;
        orry = orry_;
        _feeBps = p.feeBps;
        _lockSeconds = p.lockSeconds;
        _minStake = p.minStake;
        _creationFeeUsd = p.creationFeeUsd;
        _orryFeeDiscountBps = p.orryFeeDiscountBps;
        emit OwnershipTransferred(address(0), owner_);
    }

    function params() external view returns (PredictionParams memory) {
        return PredictionParams(_feeBps, _lockSeconds, _minStake, _creationFeeUsd, _orryFeeDiscountBps);
    }

    function feedCount() external view returns (uint256) {
        return _feeds.length;
    }

    function feedAt(uint256 i) external view returns (address) {
        return _feeds[i];
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 i) external view returns (address) {
        return _markets[i];
    }

    // ------------------------------------------------------------------ owner: feeds only, add only

    function listFeed(address feed, address asset) external {
        if (msg.sender != owner) revert NotOwner();
        if (feed == address(0)) revert ZeroAddress();
        if (feedListed[feed]) revert AlreadyListed();
        // a feed must answer like a Chainlink aggregator before it can be listed
        (, int256 answer,, uint256 updatedAt,) = IChainlinkFeed(feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert BadPrice();
        feedListed[feed] = true;
        assetOfFeed[feed] = asset;
        _feeds.push(feed);
        emit FeedListed(feed, asset);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ markets

    function create(address feed, int256 strike, uint64 closeTime) external returns (address market) {
        if (!feedListed[feed]) revert FeedNotListed();
        if (strike <= 0) revert BadParams();
        if (closeTime < block.timestamp + MIN_DURATION || closeTime > block.timestamp + MAX_DURATION) revert BadParams();

        uint256 burned = _burnCreationFee();
        market = address(
            new PredictionMarket(
                MarketInit({
                    usdg: usdg,
                    treasury: treasury,
                    feeTiers: feeTiers,
                    orryPrice: orryPrice,
                    orry: orry,
                    feed: feed,
                    asset: assetOfFeed[feed],
                    strike: strike,
                    closeTime: closeTime,
                    lockTime: closeTime - _lockSeconds,
                    feeBps: _feeBps,
                    minStake: _minStake,
                    orryFeeDiscountBps: _orryFeeDiscountBps
                })
            )
        );
        _markets.push(market);
        isMarket[market] = true;
        emit MarketCreated(
            market, feed, assetOfFeed[feed], strike, closeTime, closeTime - _lockSeconds, msg.sender, burned
        );
    }

    /// @dev Burns ORRY worth `creationFeeUsd` from the creator; nothing while the price is not ready or the fee is 0.
    function _burnCreationFee() private returns (uint256 amount) {
        if (_creationFeeUsd == 0) return 0;
        try IOrryPriceOracle(orryPrice).ready() returns (bool isReady) {
            if (!isReady) return 0;
        } catch {
            return 0;
        }
        try IOrryPriceOracle(orryPrice).orryFor(_creationFeeUsd) returns (uint256 a) {
            amount = a;
        } catch {
            return 0;
        }
        if (amount == 0) return 0;
        uint256 supply = IOrryToken(orry).totalSupply();
        IOrryToken(orry).burnFrom(msg.sender, amount);
        if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();
        emit Burned(BURN_CREATION_FEE, amount);
    }
}
