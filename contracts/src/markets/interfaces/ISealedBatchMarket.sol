// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IOrryBurnEvents} from "../../orry/interfaces/IOrryToken.sol";

/// @notice One stock token against USDG, sealed commit and reveal batches cleared at the Chainlink price and settled
/// wallet to wallet (`docs/ORRY-R1-SPEC.md` 2.1). Holds no asset and no USDG between calls. No owner, no pause.
/// No internal balances.
interface ISealedBatchMarket is IOrryBurnEvents {
    enum Mode {
        Limit, // Dark Pool: crosses only with other orders
        Swap // Private Swap: the unmatched part may fill against a listed Uniswap v4 pool (R1b); otherwise unfilled
    }

    struct Order {
        bool sellAsset; // true: sell the stock token for USDG; false: buy it with USDG
        uint256 amountIn; // asset units when selling, USDG units (fee excluded) when buying
        uint256 limitPrice; // USDG base units per 1e18 asset base units; sell: lowest accepted, buy: highest accepted
        Mode mode;
        bool payFeeInOrry;
    }

    struct BatchResult {
        bool cleared;
        uint256 price; // USDG base units per 1e18 asset base units
        uint80 roundId;
        uint256 assetFilled;
        uint256 usdgFilled;
        uint256 usdgFees;
        uint256 orryFeesBurned;
        uint32 ordersDropped;
        uint256 assetViaPool; // asset bought or sold against the remainder pool (R1b)
        uint256 usdgViaPool;
    }

    event Committed(uint256 indexed batch, address indexed account, bytes32 commitment, uint256 orryBurned);
    event Revealed(uint256 indexed batch, address indexed account, Order order);
    event OrderDropped(uint256 indexed batch, address indexed account);
    event OrderFilled(
        uint256 indexed batch, address indexed account, uint256 inputUsed, uint256 output, uint256 usdgFee, uint256 orryFee
    );
    event BatchCleared(uint256 indexed batch, uint256 price, uint80 roundId, uint256 assetFilled, uint256 usdgFilled);
    event BatchExpired(uint256 indexed batch);

    error WrongPhase();
    error AlreadyCommitted();
    error BatchFull();
    error BadReveal();
    error BelowMinimum();
    error AlreadyCleared();
    error Expired();
    error BadRound();
    error StalePrice();
    error ZeroAmount();
    error InexactTransfer();
    error DeviationTooHigh();

    function MAX_ORDERS() external view returns (uint32); // 64
    function EXPIRY() external view returns (uint64); // 1 day after the batch's reveal window ends

    function asset() external view returns (address);
    function usdg() external view returns (address);
    function priceFeed() external view returns (address);
    function treasury() external view returns (address);
    function feeTiers() external view returns (address);
    function orryPrice() external view returns (address);
    function orry() external view returns (address);
    function start() external view returns (uint64);
    function commitSeconds() external view returns (uint32);
    function revealSeconds() external view returns (uint32);
    function feeBps() external view returns (uint16);
    function minNotionalUsdg() external view returns (uint256);
    function maxStaleness() external view returns (uint32);
    function commitFeeUsd() external view returns (uint256); // USDG base units (6 decimals) of ORRY burned per commit
    /// @notice The Uniswap v4 pool (stock token / USDG) that fills the unmatched part of Swap-mode orders (R1b); `listed`
    /// is false when the market has none, and Swap orders then behave as Limit orders.
    function remainderPool() external view returns (PoolKey memory key, bool listed);
    /// @notice Largest gap allowed between the v4 fill price and the clearing price, in basis points (50, guess).
    function maxDeviationBps() external view returns (uint16);
    /// @notice Extra discount on a fee paid in ORRY (lever L3), in basis points (2500, guess); a constructor value.
    function orryFeeDiscountBps() external view returns (uint16);

    /// @notice The batch open for commits now, whether it is in its commit window, and when its current window ends.
    function phase() external view returns (uint256 batch, bool inCommit, uint64 endsAt);
    function revealEnd(uint256 batch) external view returns (uint64);
    function commitmentOf(uint256 batch, address account) external view returns (bytes32);
    function orderCount(uint256 batch) external view returns (uint256);
    function orderAt(uint256 batch, uint256 i) external view returns (address account, Order memory order);
    function result(uint256 batch) external view returns (BatchResult memory);
    /// @notice keccak256(abi.encode(batch, account, order, salt)).
    function commitmentFor(uint256 batch, address account, Order calldata order, bytes32 salt)
        external
        pure
        returns (bytes32);

    function commit(bytes32 commitment) external;
    function reveal(Order calldata order, bytes32 salt) external;
    /// @notice Reveals `account`'s committed order for it (opt-in relay, R1 spec 5): the commitment binds the account and
    /// only the holder of the salt can match it. Same checks and event as `reveal`.
    function revealFor(address account, Order calldata order, bytes32 salt) external;
    function clear(uint256 batch, uint80 roundHint) external;
    function expire(uint256 batch) external; // anyone, after EXPIRY: marks the batch expired (nothing is held)
}
