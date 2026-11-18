// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IFeeTiers} from "../markets/interfaces/IMarketPricing.sol";
import {IMerchantSplitterFactory} from "../facilitator/interfaces/IMerchantSplitter.sol";
import {IDataProviderRegistry} from "./interfaces/IDataProviderRegistry.sol";

/// @notice Open listing of third-party x402 data providers (R-51). See `IDataProviderRegistry`.
/// The endpoint, name and description live in the events (the indexer and the site read them there); storage keeps a
/// hash of them, the declared price and the times.
/// `minStakeUsd` 0 opens listing to any address with no stake (USDG-only mode, owner decision 2026-11-18: no bond, ORRY
/// does not exist yet); `stakeValue` is then `OrryUnset`, whose stake reads 0, and every listed provider is active.
contract DataProviderRegistry is IDataProviderRegistry {
    uint16 public constant FEE_BPS = 100;
    uint256 private constant MIN_ENDPOINT = 12; // "https://" plus a host of at least four bytes
    uint256 private constant MAX_ENDPOINT = 200;
    uint256 private constant MIN_NAME = 2;
    uint256 private constant MAX_NAME = 40;
    uint256 private constant MAX_DESCRIPTION = 280;

    address public immutable stakeValue;
    address public immutable providerFactory;
    uint256 public immutable minStakeUsd;

    uint256 public providerCount;
    mapping(address => Listing) private _listings;

    constructor(address stakeValue_, address providerFactory_, uint256 minStakeUsd_) {
        if (stakeValue_ == address(0) || providerFactory_ == address(0)) revert ZeroAddress();
        if (IMerchantSplitterFactory(providerFactory_).FEE_BPS() != FEE_BPS) revert WrongFactory();
        stakeValue = stakeValue_;
        providerFactory = providerFactory_;
        minStakeUsd = minStakeUsd_;
    }

    function list(string calldata endpoint, string calldata name, string calldata description, uint256 priceUsdg)
        external
        returns (address splitter)
    {
        if (_listings[msg.sender].listedAt != 0) revert AlreadyListed();
        _requireStake(msg.sender);
        bytes32 h = _check(endpoint, name, description, priceUsdg);
        IMerchantSplitterFactory f = IMerchantSplitterFactory(providerFactory);
        splitter = f.splitterOf(msg.sender);
        if (!f.isSplitter(splitter)) f.create(msg.sender);
        _listings[msg.sender] = Listing(uint64(block.timestamp), uint64(block.timestamp), priceUsdg, h);
        ++providerCount;
        emit Listed(msg.sender, splitter, endpoint, name, description, priceUsdg);
    }

    function update(string calldata endpoint, string calldata name, string calldata description, uint256 priceUsdg) external {
        Listing storage l = _listings[msg.sender];
        if (l.listedAt == 0) revert NotListed();
        _requireStake(msg.sender);
        l.contentHash = _check(endpoint, name, description, priceUsdg);
        l.priceUsdg = priceUsdg;
        l.updatedAt = uint64(block.timestamp);
        emit Updated(msg.sender, endpoint, name, description, priceUsdg);
    }

    function unlist() external {
        if (_listings[msg.sender].listedAt == 0) revert NotListed();
        delete _listings[msg.sender];
        --providerCount;
        emit Unlisted(msg.sender);
    }

    // ------------------------------------------------------------------ views

    function listing(address provider) external view returns (Listing memory) {
        return _listings[provider];
    }

    function isListed(address provider) public view returns (bool) {
        return _listings[provider].listedAt != 0;
    }

    function isActive(address provider) external view returns (bool) {
        return isListed(provider) && _stakeUsd(provider) >= minStakeUsd;
    }

    function stakeUsdOf(address provider) external view returns (uint256) {
        return _stakeUsd(provider);
    }

    function splitterOf(address provider) external view returns (address) {
        return IMerchantSplitterFactory(providerFactory).splitterOf(provider);
    }

    // ------------------------------------------------------------------ internals

    function _stakeUsd(address p) private view returns (uint256) {
        try IFeeTiers(stakeValue).stakeUsd(p) returns (uint256 v) {
            return v;
        } catch {
            return 0;
        }
    }

    function _requireStake(address p) private view {
        uint256 have = _stakeUsd(p);
        if (have < minStakeUsd) revert StakeTooLow(have, minStakeUsd);
    }

    function _check(string calldata endpoint, string calldata name, string calldata description, uint256 priceUsdg)
        private
        pure
        returns (bytes32)
    {
        bytes calldata e = bytes(endpoint);
        if (e.length < MIN_ENDPOINT || e.length > MAX_ENDPOINT || bytes8(e[:8]) != bytes8("https://")) revert BadEndpoint();
        for (uint256 i = 8; i < e.length; ++i) {
            if (uint8(e[i]) <= 0x20 || uint8(e[i]) == 0x7f) revert BadEndpoint();
        }
        bytes calldata n = bytes(name);
        if (n.length < MIN_NAME || n.length > MAX_NAME) revert BadName();
        for (uint256 i; i < n.length; ++i) {
            if (uint8(n[i]) < 0x20 || uint8(n[i]) == 0x7f) revert BadName();
        }
        if (bytes(description).length > MAX_DESCRIPTION) revert BadDescription();
        if (priceUsdg == 0) revert BadPrice();
        return keccak256(abi.encode(endpoint, name, description, priceUsdg));
    }
}
