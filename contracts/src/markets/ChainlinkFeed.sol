// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The Chainlink aggregator proxy reads used by the markets (AggregatorV3Interface subset). Round ids carry the
/// phase in their upper 16 bits, so `roundId + 1` is the next round of the same phase.
interface IChainlinkFeed {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
