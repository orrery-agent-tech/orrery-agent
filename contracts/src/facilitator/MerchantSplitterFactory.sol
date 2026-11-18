// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MerchantSplitter} from "./MerchantSplitter.sol";
import {IMerchantSplitter, IMerchantSplitterFactory} from "./interfaces/IMerchantSplitter.sol";

/// @notice One `MerchantSplitter` per merchant at a CREATE2 address keyed by the merchant (R-57). Every value is set at
/// construction and never changes; there is no owner.
contract MerchantSplitterFactory is IMerchantSplitterFactory {
    /// @dev Orrery's x402 settlement fee: 20 bps = 0.2% (R-57). At most 1% can ever be configured.
    uint16 public immutable FEE_BPS;
    address public immutable usdg;
    address public immutable orry;
    address public immutable treasury;
    /// @dev The wave R1 `FeeTiers` (stake value in USD to discount); zero means no discount.
    address public immutable feeTiers;
    address public immutable implementation;

    mapping(address => bool) public isSplitter;

    constructor(uint16 feeBps, address usdg_, address orry_, address treasury_, address feeTiers_) {
        if (usdg_ == address(0) || orry_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps > 100) revert FeeTooHigh();
        FEE_BPS = feeBps;
        usdg = usdg_;
        orry = orry_;
        treasury = treasury_;
        feeTiers = feeTiers_;
        implementation = address(new MerchantSplitter());
    }

    function splitterOf(address merchant) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, bytes32(uint256(uint160(merchant))));
    }

    /// @notice Anyone: creates `merchant`'s splitter, which always pays `merchant`.
    function create(address merchant) external returns (address splitter) {
        if (merchant == address(0)) revert ZeroAddress();
        if (isSplitter[splitterOf(merchant)]) revert SplitterExists();
        splitter = Clones.cloneDeterministic(implementation, bytes32(uint256(uint160(merchant))));
        IMerchantSplitter(splitter).initialize(merchant);
        isSplitter[splitter] = true;
        emit SplitterCreated(merchant, splitter);
    }
}
