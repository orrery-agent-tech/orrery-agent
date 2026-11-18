// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {SealedBatchMarket} from "../../../src/markets/SealedBatchMarket.sol";
import {MarketFactory} from "../../../src/markets/MarketFactory.sol";
import {ISealedBatchMarket} from "../../../src/markets/interfaces/ISealedBatchMarket.sol";
import {IMarketFactory} from "../../../src/markets/interfaces/IMarketFactory.sol";
import {MarketBase} from "./MarketBase.sol";

/// @notice A second market for the same stock with a remainder pool (R1b): a plain v4 stock/USDG pool on the 4663
/// PoolManager runtime (etched), fee 500, full range, about 1,060 TSLA and 378,000 USDG at the feed price.
abstract contract PoolMarketBase is MarketBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    PoolModifyLiquidityTest internal lpRouter;
    PoolSwapTest internal swapRouter;
    MarketFactory internal pf;
    SealedBatchMarket internal pmkt;
    PoolKey internal key;
    bool internal assetIs0;

    function setUp() public virtual override {
        super.setUp();
        lpRouter = new PoolModifyLiquidityTest(IPoolManager(pm));
        swapRouter = new PoolSwapTest(IPoolManager(pm));
        assetIs0 = address(stock) < address(usdg);
        (address c0, address c1) = assetIs0 ? (address(stock), address(usdg)) : (address(usdg), address(stock));
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 500, 10, IHooks(address(0)));
        IPoolManager(pm).initialize(key, _sqrtAt(TSLA_PRICE));
        stock.mint(address(this), 100_000e18);
        usdg.mint(address(this), 100_000_000e6);
        stock.approve(address(lpRouter), type(uint256).max);
        usdg.approve(address(lpRouter), type(uint256).max);
        stock.approve(address(swapRouter), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);
        // full range, about 1,060 TSLA and 378,000 USDG (L = 2e16)
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(10),
                tickUpper: TickMath.maxUsableTick(10),
                liquidityDelta: int256(uint256(2e16)),
                salt: 0
            }),
            ""
        );

        pf = new MarketFactory(
            owner, address(usdg), treasury, address(tiers), address(orryPrice), address(orry), pm, _params()
        );
        vm.prank(owner);
        pmkt = SealedBatchMarket(pf.create(address(stock), address(feed), key));
        for (uint256 i; i < traders.length; ++i) {
            vm.startPrank(traders[i]);
            stock.approve(address(pmkt), type(uint256).max);
            usdg.approve(address(pmkt), type(uint256).max);
            orry.approve(address(pmkt), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Pool sqrtPriceX96 for a USDG-per-1e18-asset price.
    function _sqrtAt(uint256 price) internal view returns (uint160) {
        uint256 ratio = assetIs0 ? price * 2 ** 192 / 1e18 : 1e18 * 2 ** 192 / price;
        return uint160(Math.sqrt(ratio));
    }

    function _poolPrice() internal view returns (uint256) {
        (uint160 s,,,) = IPoolManager(pm).getSlot0(key.toId());
        uint256 ratio = uint256(s) * s / 2 ** 96; // X96
        return assetIs0 ? ratio * 1e18 / 2 ** 96 : 1e18 * 2 ** 96 / ratio;
    }

    /// @dev Moves the pool to `price` (an attacker's push or a market move).
    function _pushTo(uint256 price) internal {
        uint160 target = _sqrtAt(price);
        (uint160 now_,,,) = IPoolManager(pm).getSlot0(key.toId());
        bool zeroForOne = target < now_;
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(1e30), sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _swapSell(uint256 amount, uint256 limit) internal pure returns (ISealedBatchMarket.Order memory o) {
        o = ISealedBatchMarket.Order(true, amount, limit, ISealedBatchMarket.Mode.Swap, false);
    }

    function _swapBuy(uint256 amount, uint256 limit) internal pure returns (ISealedBatchMarket.Order memory o) {
        o = ISealedBatchMarket.Order(false, amount, limit, ISealedBatchMarket.Mode.Swap, false);
    }

    function _placeIn(address[] memory who, ISealedBatchMarket.Order[] memory os) internal returns (uint256 batch) {
        (batch,,) = pmkt.phase();
        for (uint256 i; i < who.length; ++i) {
            bytes32 c = pmkt.commitmentFor(batch, who[i], os[i], _salt(who[i]));
            vm.prank(who[i]);
            pmkt.commit(c);
        }
        vm.warp(pmkt.revealEnd(batch) - pmkt.revealSeconds());
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            pmkt.reveal(os[i], _salt(who[i]));
        }
        vm.warp(pmkt.revealEnd(batch));
    }

    function _one(address a, ISealedBatchMarket.Order memory o) internal returns (uint256) {
        address[] memory who = new address[](1);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](1);
        (who[0], os[0]) = (a, o);
        return _placeIn(who, os);
    }

    function _clearP(uint256 b) internal {
        uint80 rid = feed.latestRoundId();
        pmkt.clear(b, rid);
    }
}
