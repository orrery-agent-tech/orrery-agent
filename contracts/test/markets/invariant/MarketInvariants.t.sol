// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {PoolMarketBase} from "../utils/PoolMarketBase.sol";
import {MarketHandler} from "./MarketHandler.sol";

/// @notice Invariant campaign and deterministic deep run for one SealedBatchMarket with a remainder pool
/// (`docs/ORRY-R1-SPEC.md` 3 and 7): DP-1 to DP-8 and DP-11 through the handler's model, DP-9 / X-3 on the factory,
/// G-2 on the ORRY supply.
contract MarketInvariants is PoolMarketBase {
    MarketHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new MarketHandler(
            pmkt, stock, usdg, orry, feed, ethFeed, registry, staking, tiers, orryPrice, treasury, traders, swapRouter, key
        );
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](17);
        sels[0] = h.commit.selector;
        sels[1] = h.commit.selector;
        sels[2] = h.commit.selector;
        sels[3] = h.reveal.selector;
        sels[4] = h.reveal.selector;
        sels[5] = h.reveal.selector;
        sels[6] = h.revoke.selector;
        sels[7] = h.move.selector;
        sels[8] = h.issuer.selector;
        sels[9] = h.oracle.selector;
        sels[10] = h.stake.selector;
        sels[11] = h.warp.selector;
        sels[12] = h.warp.selector;
        sels[13] = h.clearNext.selector;
        sels[14] = h.clearNext.selector;
        sels[15] = h.expireAny.selector;
        sels[16] = h.poolPush.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    function _checkAll() internal view {
        // DP-1 / X-1: the market holds no asset and no USDG after every call
        assertEq(stock.balanceOf(address(pmkt)), 0, "DP-1 asset");
        assertEq(usdg.balanceOf(address(pmkt)), 0, "DP-1 usdg");
        assertEq(orry.balanceOf(address(pmkt)), 0, "DP-1 orry");
        assertFalse(h.badDP2(), "DP-2");
        assertFalse(h.badDP3(), "DP-3");
        assertFalse(h.badDP4(), "DP-4");
        assertFalse(h.badDP5(), "DP-5");
        assertFalse(h.badDP6(), "DP-6");
        assertFalse(h.badDP7(), "DP-7");
        assertFalse(h.badDP8(), "DP-8");
        assertFalse(h.badG2(), "G-2");
        assertFalse(h.badDP11(), "DP-11");
        // DP-9 / X-3: one market for the asset, unchanged
        assertEq(pf.marketOf(address(stock)), address(pmkt), "DP-9");
        assertEq(pf.marketCount(), 1, "DP-9 count");
    }

    function invariant_market() public view {
        _checkAll();
    }

    function test_deep_run_market() public {
        uint256 seed = 0xda7a;
        for (uint256 step; step < 6_000; ++step) {
            uint256 fmp;
            assembly ("memory-safe") {
                fmp := mload(0x40)
            }
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 a = seed;
            uint256 b = seed >> 64;
            uint256 c = seed >> 128;
            uint256 pick = seed % 100;
            if (pick < 25) h.commit(a, b, c, seed >> 32);
            else if (pick < 48) h.reveal(a, b);
            else if (pick < 51) h.revoke(a, b);
            else if (pick < 54) h.move(a, b, c);
            else if (pick < 57) h.issuer(a, b);
            else if (pick < 63) h.oracle(b);
            else if (pick < 67) h.poolPush(b);
            else if (pick < 70) h.stake(a, b);
            else if (pick < 80) h.warp(b);
            else if (pick < 98) h.clearNext(b);
            else h.expireAny(b);
            _checkAll();
            assembly ("memory-safe") {
                mstore(0x40, fmp)
            }
        }
        console2.log("commits", h.commits());
        console2.log("reveals", h.reveals());
        console2.log("clears", h.clears());
        console2.log("batches with fills", h.batchesWithFills());
        console2.log("batches with a partial fill", h.partialBatches());
        console2.log("orders filled", h.fills());
        console2.log("fills paying the fee in ORRY", h.orryFeeFills());
        console2.log("orders dropped", h.drops());
        console2.log("batches expired", h.expiries());
        console2.log("clears refused (stale, zero or paused price)", h.refusedClears());
        console2.log("revealed orders in cleared batches", h.revealedInCleared());
        console2.log("batches with a pool fill", h.batchesWithPoolFills());
        console2.log("orders filled through the pool", h.poolFills());
        console2.log("pool pushes", h.poolPushes());
        assertGt(h.batchesWithFills(), 20, "fills reached");
        assertGt(h.partialBatches(), 5, "partial fills reached");
        assertGt(h.orryFeeFills(), 5, "ORRY fees reached");
        assertGt(h.drops(), 5, "drops reached");
        assertGt(h.expiries(), 0, "expiry reached");
        assertGt(h.poolFills(), 15, "pool fills reached");
    }
}
