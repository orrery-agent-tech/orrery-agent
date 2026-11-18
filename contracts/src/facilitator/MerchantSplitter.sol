// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFeeTiers} from "../markets/interfaces/IMarketPricing.sol";
import {IOrryToken} from "../orry/interfaces/IOrryToken.sol";
import {IMerchantSplitter, IMerchantSplitterFactory} from "./interfaces/IMerchantSplitter.sol";

/// @notice Per-merchant forwarding splitter (R-57), deployed as a minimal clone by `MerchantSplitterFactory`. It holds
/// nothing between calls: `forward(token)` empties its balance of that token to the merchant and the fee path.
contract MerchantSplitter is IMerchantSplitter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10_000;
    uint8 private constant BURN_SOURCE = 7;

    address public factory;
    address public merchant;

    /// @dev The implementation itself is never usable: its factory slot is set to itself at construction.
    constructor() {
        factory = address(this);
    }

    function initialize(address merchant_) external {
        if (factory != address(0)) revert AlreadyInitialized();
        factory = msg.sender;
        merchant = merchant_;
    }

    function forward(address token) external nonReentrant returns (uint256 toMerchant, uint256 fee) {
        address m = merchant;
        if (m == address(0)) revert NotFactory();
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToForward();
        IMerchantSplitterFactory f = IMerchantSplitterFactory(factory);
        uint16 discount;
        (toMerchant, fee, discount) = _split(f, token, amount);
        if (fee != 0) {
            if (token == f.orry()) {
                IOrryToken(token).burn(fee);
                emit Burned(BURN_SOURCE, fee);
            } else {
                IERC20(token).safeTransfer(f.treasury(), fee);
            }
        }
        IERC20(token).safeTransfer(m, toMerchant);
        emit Forwarded(token, toMerchant, fee, discount);
    }

    function previewForward(address token) external view returns (uint256 toMerchant, uint256 fee, uint16 discountBps) {
        return _split(IMerchantSplitterFactory(factory), token, IERC20(token).balanceOf(address(this)));
    }

    /// @dev USDG and ORRY carry the fee, rounded down so the merchant never gets less than its share; other tokens
    /// pass whole. A FeeTiers read that fails counts as no discount, so a stalled oracle never blocks a forward.
    function _split(IMerchantSplitterFactory f, address token, uint256 amount)
        private
        view
        returns (uint256 toMerchant, uint256 fee, uint16 discount)
    {
        if (token == f.usdg() || token == f.orry()) {
            discount = _discount(f.feeTiers(), merchant);
            uint256 bps = uint256(f.FEE_BPS()) * (BPS - discount) / BPS;
            fee = amount * bps / BPS;
        }
        toMerchant = amount - fee;
    }

    function _discount(address tiers, address m) private view returns (uint16 d) {
        if (tiers == address(0)) return 0;
        try IFeeTiers(tiers).discountBps(m) returns (uint16 v) {
            d = v > BPS ? BPS : v;
        } catch {}
    }
}
