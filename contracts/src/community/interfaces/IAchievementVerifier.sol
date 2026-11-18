// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A condition `OrryAchievements` checks on chain for an on-chain achievement kind (R-41).
interface IAchievementVerifier {
    /// @notice Whether `account` meets the condition in this block. `data` is caller supplied (for example an agentId).
    function isComplete(address account, bytes calldata data) external view returns (bool);
}
