// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Open listing of third-party x402 data providers (R-51; `docs/updates/L2-DATA-MCP-SPEC.md` 2.2). A provider
/// lists itself with its endpoint while its ORRY stake is worth at least `minStakeUsd` (USD from `FeeTiers.stakeUsd`);
/// it is paid at its splitter in the 1% `MerchantSplitterFactory`, created on its first listing. `isActive` reads the
/// stake live. No owner, no setter, no pause.
interface IDataProviderRegistry {
    struct Listing {
        uint64 listedAt;
        uint64 updatedAt;
        uint256 priceUsdg; // declared price per call, USDG base units (6 decimals)
        bytes32 contentHash; // keccak256(abi.encode(endpoint, name, description, priceUsdg))
    }

    event Listed(address indexed provider, address indexed splitter, string endpoint, string name, string description, uint256 priceUsdg);
    event Updated(address indexed provider, string endpoint, string name, string description, uint256 priceUsdg);
    event Unlisted(address indexed provider);

    error ZeroAddress();
    error ZeroMinStake();
    error WrongFactory();
    error AlreadyListed();
    error NotListed();
    error StakeTooLow(uint256 have, uint256 need);
    error BadEndpoint();
    error BadName();
    error BadDescription();
    error BadPrice();

    /// @notice The data provider fee: the factory's `FEE_BPS`, required to be 100 (1%).
    function FEE_BPS() external view returns (uint16);
    function stakeValue() external view returns (address);
    function providerFactory() external view returns (address);
    function minStakeUsd() external view returns (uint256);
    function providerCount() external view returns (uint256);

    function list(string calldata endpoint, string calldata name, string calldata description, uint256 priceUsdg) external returns (address splitter);
    function update(string calldata endpoint, string calldata name, string calldata description, uint256 priceUsdg) external;
    function unlist() external;

    function listing(address provider) external view returns (Listing memory);
    function isListed(address provider) external view returns (bool);
    /// @notice Listed and staked at least `minStakeUsd` now; a failing stake read counts as no stake.
    function isActive(address provider) external view returns (bool);
    function stakeUsdOf(address provider) external view returns (uint256);
    /// @notice The provider's payment address (its splitter in the 1% factory), known before it exists.
    function splitterOf(address provider) external view returns (address);
}
