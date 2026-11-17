// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Subset of the ERC-8004 IdentityRegistry used by Orrery.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice Subset of ERC-20 used by Orrery.
interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @notice Subset of an ERC-7579 account used by Orrery.
interface IERC7579AccountMin {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);
}

/// @notice ERC-7579 module base interface.
interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
}

/// @notice Subset of a Safe used by OrreryLens for account-kind detection.
interface ISafeMin {
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
    function isModuleEnabled(address module) external view returns (bool);
    function isOwner(address owner) external view returns (bool);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
}
