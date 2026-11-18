// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryBurnEvents} from "../../../orry/interfaces/IOrryToken.sol";

/// @notice Signed limit orders for the stock tokens R1 lists, filled by anyone through the asset's Uniswap v4 pool and
/// settled wallet to wallet (`docs/updates/L3-R2-SPEC.md` 4, custody pattern A of R-27). Holds nothing between calls.
interface ILimitOrderBook is IOrryBurnEvents {
    struct Order {
        address owner;
        address asset; // a stock token with an R1 market whose remainder pool is listed
        bool sellAsset; // true: sell the asset for USDG; false: buy it with USDG
        uint256 amountIn; // asset units when selling; USDG units spent in the swap (fee and tip excluded) when buying
        uint256 limitPrice; // USDG base units per 1e18 asset base units; sell: lowest gross price, buy: highest
        uint16 tipBps; // of the USDG notional, to whoever fills, at most MAX_TIP_BPS
        bool payFeeInOrry;
        uint256 nonce;
        uint64 expiry; // last second the order can fill
    }

    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed owner,
        address indexed asset,
        bool sellAsset,
        uint256 nonce,
        uint256 amountIn,
        uint256 amountOut,
        uint256 usdgFee,
        uint256 orryFee,
        uint256 tip,
        address keeper
    );
    event NonceCancelled(address indexed owner, uint256 nonce);

    error BadOrder();
    error BadSignature();
    error NonceUsed();
    error OrderExpired();
    error NotListed();
    error StalePrice();
    error NotFillable();
    error InexactTransfer();
    error WrongCaller();

    function MAX_TIP_BPS() external view returns (uint16); // 100
    function ORDER_TYPEHASH() external view returns (bytes32);
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function usdg() external view returns (address);
    function marketFactory() external view returns (address);
    function poolManager() external view returns (address);
    function treasury() external view returns (address);
    function feeTiers() external view returns (address);
    function orryPrice() external view returns (address);
    function orry() external view returns (address);
    function feeBps() external view returns (uint16);
    function maxDeviationBps() external view returns (uint16);
    function maxStaleness() external view returns (uint32);
    function orryFeeDiscountBps() external view returns (uint16);

    function hashOrder(Order calldata order) external view returns (bytes32);
    function nonceUsed(address owner, uint256 nonce) external view returns (bool);
    /// @notice The fresh oracle price of `asset` in USDG base units per 1e18 asset base units; reverts when not fillable.
    function oraclePrice(address asset) external view returns (uint256);

    /// @notice Fills the whole order through the asset's pool or reverts. The caller receives the tip.
    function fill(Order calldata order, bytes calldata signature) external returns (uint256 amountOut);
    function cancel(uint256 nonce) external;
    function cancelMany(uint256[] calldata nonces) external;
}
