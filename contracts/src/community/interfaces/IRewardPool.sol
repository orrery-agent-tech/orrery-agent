// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Funding side of the Community Reward Pool (`docs/updates/L1-COMMUNITY-SPEC.md`, R-31, R-33, R-42, R-50).
/// The pool keeps books per asset: `freeBalance` (what events and achievements may lock) plus `lockedBalance` (locked
/// for events and achievements) equals what it holds of that asset. Anything paid in through `fund` or noticed by `sync`
/// is booked into the free balance. Nothing leaves the pool except a payout to an event winner or an achievement
/// recipient (invariants C-2, A-6).
/// Callers: `OrryChat` (post fees, tip cuts), `OrryNames` (name fees), lane L2's `DataFeeSplitter` (30% of official
/// data revenue in ORRY, R-50), the treasury wallet (ORRY, ETH or USDG for achievements, R-42), anyone.
interface IRewardPool {
    /// @notice `amount` of `asset` (address(0) = native ETH) was booked into the free balance; `from` is the caller of
    /// `fund` or `sync`.
    event Funded(address indexed asset, address indexed from, uint256 amount);

    error ZeroAmount();
    /// @dev The pool did not receive exactly `amount` (fee-on-transfer or a lying token).
    error InexactTransfer();
    /// @dev ETH sent with an ERC-20 `fund`, or `msg.value != amount` for native ETH.
    error EthAmountMismatch();

    /// @notice The ORRY token.
    function orry() external view returns (address);

    /// @notice Anyone: pulls `amount` of ERC-20 `asset` from the caller with `transferFrom` and books it into the free
    /// balance; the pool's balance must grow by exactly `amount`, else `InexactTransfer`. For native ETH pass
    /// `asset = address(0)` and `msg.value == amount`. Reverts `ZeroAmount` for 0.
    /// Usage from another contract: `IERC20(orry).approve(pool, x); IRewardPool(pool).fund(orry, x);`
    function fund(address asset, uint256 amount) external payable;

    /// @notice Anyone: books what the pool holds of `asset` beyond its books (a plain transfer in) into the free balance
    /// and returns the amount booked (0 when there is nothing to book).
    function sync(address asset) external returns (uint256 booked);

    function freeBalance(address asset) external view returns (uint256);
    function lockedBalance(address asset) external view returns (uint256);
}
