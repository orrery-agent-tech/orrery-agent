// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// @notice Creates one SealedBatchMarket per stock token (`docs/ORRY-R1-SPEC.md` 2.2). The owner can only add markets.
interface IMarketFactory {
    event MarketCreated(address indexed asset, address indexed market, address priceFeed, bytes32 remainderPoolId);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error MarketExists(address market);
    error ZeroAddress();

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function marketOf(address asset) external view returns (address);
    function marketCount() external view returns (uint256);
    function marketAt(uint256 i) external view returns (address);

    /// @notice `remainderPool` with currency1 == address(0) means none. Fixed for the market's life.
    function create(address asset, address priceFeed, PoolKey calldata remainderPool) external returns (address market);
    function transferOwnership(address newOwner) external; // two-step
    function acceptOwnership() external;
}
