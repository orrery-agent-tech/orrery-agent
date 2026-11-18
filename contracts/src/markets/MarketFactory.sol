// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {IMarketFactory} from "./interfaces/IMarketFactory.sol";
import {SealedBatchMarket} from "./SealedBatchMarket.sol";
import {MarketParams, checkMarketParams} from "./MarketParams.sol";

/// @notice Creates one `SealedBatchMarket` per stock token with the parameters fixed here at deployment
/// (`docs/ORRY-R1-SPEC.md` 2.2). The owner (one wallet) can only add markets; a market has no owner, so nobody can
/// change, pause or remove one (X-3). One two-step owner; every market takes the factory's fixed parameters.
contract MarketFactory is IMarketFactory {
    using PoolIdLibrary for PoolKey;

    address public owner;
    address public pendingOwner;
    mapping(address asset => address) public marketOf;
    address[] private _markets;

    address private immutable _usdg;
    address private immutable _treasury;
    address private immutable _feeTiers;
    address private immutable _orryPrice;
    address private immutable _orry;
    address private immutable _poolManager;
    uint32 private immutable _commitSeconds;
    uint32 private immutable _revealSeconds;
    uint16 private immutable _feeBps;
    uint256 private immutable _minNotionalUsdg;
    uint32 private immutable _maxStaleness;
    uint256 private immutable _commitFeeUsd;
    uint16 private immutable _orryFeeDiscountBps;
    uint16 private immutable _maxDeviationBps;

    constructor(
        address owner_,
        address usdg_,
        address treasury_,
        address feeTiers_,
        address orryPrice_,
        address orry_,
        address poolManager_,
        MarketParams memory p
    ) {
        if (
            owner_ == address(0) || usdg_ == address(0) || treasury_ == address(0) || feeTiers_ == address(0)
                || orryPrice_ == address(0) || orry_ == address(0) || poolManager_ == address(0)
        ) revert ZeroAddress();
        checkMarketParams(p);
        owner = owner_;
        _usdg = usdg_;
        _treasury = treasury_;
        _feeTiers = feeTiers_;
        _orryPrice = orryPrice_;
        _orry = orry_;
        _poolManager = poolManager_;
        _commitSeconds = p.commitSeconds;
        _revealSeconds = p.revealSeconds;
        _feeBps = p.feeBps;
        _minNotionalUsdg = p.minNotionalUsdg;
        _maxStaleness = p.maxStaleness;
        _commitFeeUsd = p.commitFeeUsd;
        _orryFeeDiscountBps = p.orryFeeDiscountBps;
        _maxDeviationBps = p.maxDeviationBps;
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 i) external view returns (address) {
        return _markets[i];
    }

    /// @param remainderPool the v4 stock/USDG pool for Swap-mode remainders (R1b); currency1 == address(0) means none.
    /// The market checks it holds exactly the asset and USDG and has no hooks.
    function create(address asset, address priceFeed, PoolKey calldata remainderPool)
        external
        onlyOwner
        returns (address market)
    {
        if (asset == address(0) || priceFeed == address(0)) revert ZeroAddress();
        address existing = marketOf[asset];
        if (existing != address(0)) revert MarketExists(existing);
        market = address(
            new SealedBatchMarket(
                asset,
                _usdg,
                priceFeed,
                _treasury,
                _feeTiers,
                _orryPrice,
                _orry,
                _poolManager,
                remainderPool,
                MarketParams({
                    commitSeconds: _commitSeconds,
                    revealSeconds: _revealSeconds,
                    feeBps: _feeBps,
                    minNotionalUsdg: _minNotionalUsdg,
                    maxStaleness: _maxStaleness,
                    commitFeeUsd: _commitFeeUsd,
                    orryFeeDiscountBps: _orryFeeDiscountBps,
                    maxDeviationBps: _maxDeviationBps
                })
            )
        );
        marketOf[asset] = market;
        _markets.push(market);
        bytes32 poolId =
            Currency.unwrap(remainderPool.currency1) == address(0) ? bytes32(0) : PoolId.unwrap(remainderPool.toId());
        emit MarketCreated(asset, market, priceFeed, poolId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner; // zero cancels a pending transfer
        emit OwnershipTransferStarted(msg.sender, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
