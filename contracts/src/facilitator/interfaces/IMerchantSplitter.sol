// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrryBurnEvents} from "../../orry/interfaces/IOrryToken.sol";

/// @notice A merchant's own x402 `payTo` (R-57): payments land here and `forward(token)` (anyone, usually the
/// facilitator after a settlement) sends Orrery's fee and the rest to the merchant in one call. The fee is
/// `FEE_BPS` of the amount less the merchant's stake discount (`IFeeTiers.discountBps`). A USDG fee goes to
/// `OrreryTreasury` as revenue; an ORRY fee is burned (`Burned(7, amount)`); any other token is passed on whole.
interface IMerchantSplitter is IOrryBurnEvents {
    event Forwarded(address indexed token, uint256 toMerchant, uint256 fee, uint16 discountBps);

    error AlreadyInitialized();
    error NotFactory();
    error NothingToForward();

    function factory() external view returns (address);
    function merchant() external view returns (address);
    function initialize(address merchant_) external;
    /// @notice Forwards this contract's whole balance of `token` (USDG, ORRY or any other ERC-20).
    function forward(address token) external returns (uint256 toMerchant, uint256 fee);
    /// @notice The split `forward(token)` would make now.
    function previewForward(address token) external view returns (uint256 toMerchant, uint256 fee, uint16 discountBps);
}

/// @notice Creates one splitter per merchant at a CREATE2 address keyed by the merchant (R-57), so the address is known
/// before it exists and never changes. Anyone may create a merchant's splitter; it always pays that merchant.
interface IMerchantSplitterFactory {
    event SplitterCreated(address indexed merchant, address indexed splitter);

    error ZeroAddress();
    error FeeTooHigh();
    error SplitterExists();

    function FEE_BPS() external view returns (uint16);
    function usdg() external view returns (address);
    function orry() external view returns (address);
    function treasury() external view returns (address);
    function feeTiers() external view returns (address);
    function implementation() external view returns (address);
    function splitterOf(address merchant) external view returns (address);
    function isSplitter(address splitter) external view returns (bool);
    function create(address merchant) external returns (address splitter);
}
