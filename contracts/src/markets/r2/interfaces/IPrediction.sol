// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryBurnEvents} from "../../../orry/interfaces/IOrryToken.sol";

/// @notice The fixed numbers every market of one factory shares (`docs/updates/L3-R2-SPEC.md` 3.1). Guesses, set once at
/// the factory's deployment.
struct PredictionParams {
    uint16 feeBps; // of the winner's gross payout, at most MAX_PREDICTION_FEE_BPS (200, guess)
    uint32 lockSeconds; // staking stops this long before the close (1800, guess)
    uint256 minStake; // USDG base units (1e6, guess)
    uint256 creationFeeUsd; // USDG base units of ORRY burned per market created, 0 disables (1e6, guess)
    uint16 orryFeeDiscountBps; // further discount when the fee is paid in ORRY (2500, guess)
}

uint16 constant MAX_PREDICTION_FEE_BPS = 300;

/// @notice One market: "is the feed's answer above `strike` at `closeTime`?". Parimutuel in USDG, its own contract
/// (custody pattern C of R-27). No owner, no pause, no setter.
interface IPredictionMarket is IOrryBurnEvents {
    enum Status {
        Open,
        Yes,
        No,
        Refund
    }

    struct Info {
        address factory;
        address feed;
        address asset; // stock token whose corporate actions refund the market, or address(0)
        int256 strike; // in the feed's decimals
        uint64 createdAt;
        uint64 lockTime;
        uint64 closeTime;
        Status status;
        int256 settlePrice;
        uint80 settleRound;
        uint256 yesPool;
        uint256 noPool;
    }

    event Staked(address indexed account, bool yes, uint256 amount);
    event Settled(Status status, int256 price, uint80 roundId);
    event Claimed(address indexed account, uint256 payout, uint256 usdgFee, uint256 orryFee);
    event Swept(uint256 amount);

    error StakingClosed();
    error StakeTooSmall();
    error NotClosed();
    error NotOpen();
    error NotSettled();
    error WindowOpen();
    error WindowClosed();
    error NotFirstRound();
    error BadPrice();
    error StalePrice();
    error NothingToClaim();
    error InexactTransfer();

    function SETTLE_WINDOW() external view returns (uint64); // 7 days after the close

    function usdg() external view returns (address);
    function treasury() external view returns (address);
    function feeTiers() external view returns (address);
    function orryPrice() external view returns (address);
    function orry() external view returns (address);
    function feeBps() external view returns (uint16);
    function minStake() external view returns (uint256);
    function orryFeeDiscountBps() external view returns (uint16);

    function info() external view returns (Info memory);
    function status() external view returns (Status);
    function stakeOf(address account) external view returns (uint256 yes, uint256 no);
    function claimed(address account) external view returns (bool);
    /// @notice Gross payout of `account` now (0 while open, after claiming, or on the losing side), before any fee.
    function grossOf(address account) external view returns (uint256);
    /// @notice USDG the market must still be able to pay out (stakes while open; unclaimed winnings after settlement).
    function owed() external view returns (uint256);

    function stake(bool yes, uint256 amount) external;
    /// @notice Settles at the first round of the feed published at or after the close. Anyone.
    function settle(uint80 roundId) external;
    /// @notice After `SETTLE_WINDOW` with no settlement: every stake is refunded. Anyone.
    function expire() external;
    /// @notice Pays the caller's winnings (fee in USDG, or burned in ORRY) or refund.
    function claim(bool payFeeInOrry) external returns (uint256 payout);
    /// @notice Sends USDG above `owed()` (rounding dust, donations) to the treasury once settled. Anyone.
    function sweep() external returns (uint256 amount);
}

/// @notice Makes prediction markets on feeds its owner listed (`docs/updates/L3-R2-SPEC.md` 3.1). The owner can only list
/// feeds; anyone creates a market on a listed feed and burns `creationFeeUsd` of ORRY for it.
interface IPredictionMarketFactory is IOrryBurnEvents {
    event FeedListed(address indexed feed, address indexed asset);
    event MarketCreated(
        address indexed market,
        address indexed feed,
        address asset,
        int256 strike,
        uint64 closeTime,
        uint64 lockTime,
        address indexed creator,
        uint256 orryBurned
    );
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error FeedNotListed();
    error AlreadyListed();
    error BadParams();
    error BadPrice();
    error InexactTransfer();

    function MIN_DURATION() external view returns (uint64); // 1 hour
    function MAX_DURATION() external view returns (uint64); // 120 days

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function usdg() external view returns (address);
    function treasury() external view returns (address);
    function feeTiers() external view returns (address);
    function orryPrice() external view returns (address);
    function orry() external view returns (address);
    function params() external view returns (PredictionParams memory);
    function feedListed(address feed) external view returns (bool);
    function assetOfFeed(address feed) external view returns (address);
    function feedCount() external view returns (uint256);
    function feedAt(uint256 i) external view returns (address);
    function marketCount() external view returns (uint256);
    function marketAt(uint256 i) external view returns (address);
    function isMarket(address market) external view returns (bool);

    function listFeed(address feed, address asset) external;
    function create(address feed, int256 strike, uint64 closeTime) external returns (address market);
    function transferOwnership(address newOwner) external; // two-step
    function acceptOwnership() external;
}
