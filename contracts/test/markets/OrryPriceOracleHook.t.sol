// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {OrreryHook} from "../../src/orry/OrreryHook.sol";
import {OrryPriceOracle} from "../../src/markets/OrryPriceOracle.sol";
import {MockOrry} from "../orry/stake/utils/StakeMocks.sol";
import {PoolManagerCode} from "../orry/stake/utils/PoolManagerCode.sol";
import {MockTreasury} from "../orry/earn/mocks/EarnMocks.sol";
import {MockFeed, MockUsdg} from "./utils/MarketMocks.sol";

/// @notice OrryPriceOracle on lane A's multi-hub `OrreryHook` (orry/pairs-a 295074d) and its real observations: the
/// ETH and USDG hubs on the 4663 PoolManager runtime (etched), source switching as history builds up, the orientation
/// of each hub, and the 30 minute mean's resistance to a one-block push.
contract OrryPriceOracleHookTest is Test {
    uint160 internal constant FLAGS = 0x10C4; // afterInitialize, beforeSwap, afterSwap, afterSwapReturnDelta
    uint256 internal constant T0 = 1_800_000_000;
    int24 internal constant ETH_TICK = 138200; // about 1,002,600 ORRY per ETH
    int24 internal constant USDG_TICK = 337400; // about 448.6 ORRY per USDG (ORRY per USDG base units)

    IPoolManager internal pm;
    PoolModifyLiquidityTest internal lpRouter;
    PoolSwapTest internal swapRouter;
    MockOrry internal orry;
    MockUsdg internal usdg;
    MockFeed internal ethFeed;
    OrreryHook internal hook;
    OrryPriceOracle internal oracle;
    PoolKey internal ethHub;
    PoolKey internal usdgHub;

    function setUp() public {
        vm.warp(T0);
        vm.etch(PoolManagerCode.ADDRESS, PoolManagerCode.runtime());
        pm = IPoolManager(PoolManagerCode.ADDRESS);
        lpRouter = new PoolModifyLiquidityTest(pm);
        swapRouter = new PoolSwapTest(pm);
        orry = new MockOrry(address(this), 1e30);
        usdg = new MockUsdg();
        ethFeed = new MockFeed(8);
        ethFeed.push(2235e8, T0);
        MockTreasury treasury = new MockTreasury(makeAddr("pairAdmin"));
        address at = address((uint160(uint256(keccak256("orrery.r1.hook"))) & ~uint160(0x3FFF)) | FLAGS);
        deployCodeTo(
            "OrreryHook.sol:OrreryHook",
            abi.encode(
                address(pm),
                address(orry),
                makeAddr("router"),
                address(treasury),
                uint24(8500),
                uint24(1500),
                int24(200),
                address(usdg),
                address(ethFeed)
            ),
            at
        );
        hook = OrreryHook(at);
        oracle = new OrryPriceOracle(address(hook), address(usdg), address(ethFeed), 25 hours);
        ethHub = hook.hubKey(address(0));
        usdgHub = hook.hubKey(address(usdg));

        usdg.mint(address(this), 1e18);
        usdg.approve(address(lpRouter), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);
        orry.approve(address(lpRouter), type(uint256).max);
        orry.approve(address(swapRouter), type(uint256).max);
        vm.deal(address(this), 100_000 ether);
    }

    function _open(PoolKey memory key, int24 tick, uint128 liquidity, uint256 eth) internal {
        pm.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        lpRouter.modifyLiquidity{value: eth}(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: int256(uint256(liquidity)),
                salt: 0
            }),
            ""
        );
    }

    /// @dev The USDG hub's tick for "ORRY per USDG" = USDG_TICK, in the pool's own orientation.
    function _usdgPoolTick() internal view returns (int24) {
        return hook.pairOf(address(usdg)).orryIsCurrency0 ? -USDG_TICK : USDG_TICK;
    }

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        bool ethIn = zeroForOne && Currency.unwrap(key.currency0) == address(0);
        swapRouter.swap{value: ethIn ? amountIn : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Independent reference: 1.0001^tick in 1e18 fixed point.
    function _pow(int24 tick) internal pure returns (uint256 r) {
        uint256 base = 1.0001e18;
        uint256 e = uint256(int256(tick < 0 ? -tick : tick));
        r = 1e18;
        while (e != 0) {
            if (e & 1 == 1) r = FullMath.mulDiv(r, base, 1e18);
            e >>= 1;
            if (e != 0) base = FullMath.mulDiv(base, base, 1e18);
        }
        if (tick < 0) r = 1e36 / r;
    }

    function test_sources_follow_each_hub_history() public {
        _open(ethHub, ETH_TICK, 1e23, 110 ether);
        assertEq(oracle.source(), 0, "no history yet");
        vm.warp(T0 + 20 minutes);
        ethFeed.push(2235e8, T0 + 20 minutes);
        _open(usdgHub, _usdgPoolTick(), 2e18, 0);
        vm.warp(T0 + 31 minutes);
        // the ETH hub has 31 minutes, the USDG hub 11: the ETH path prices ORRY
        assertEq(oracle.source(), 2);
        uint256 viaEth = oracle.usdValue(1000e18);
        assertApproxEqRel(viaEth, uint256(1000e18) * 1e18 / _pow(ETH_TICK) * 2235 / 1e12, 1e14);
        vm.warp(T0 + 51 minutes);
        // now the USDG hub has 31 minutes: it is preferred
        assertEq(oracle.source(), 1);
        uint256 viaUsdg = oracle.usdValue(1000e18);
        assertApproxEqRel(viaUsdg, uint256(1000e18) * 1e18 / _pow(USDG_TICK), 1e14);
        // both hubs carry about the same price here, so the two sources agree within a fraction of a percent
        assertApproxEqRel(viaUsdg, viaEth, 5e15);
        // rounding: orryFor never charges less than asked
        uint256 r = oracle.orryFor(1e6);
        assertGe(oracle.usdValue(r), 1e6);
    }

    function test_a_one_block_push_barely_moves_the_30_minute_mean() public {
        _open(usdgHub, _usdgPoolTick(), 2e18, 0);
        vm.warp(T0 + 40 minutes);
        _swap(usdgHub, true, 1); // a tiny swap writes an observation at the current price
        vm.warp(T0 + 41 minutes);
        uint256 before = oracle.usdValue(1_000_000e18);
        // an attacker pushes ORRY about 10% more expensive in one block: buys ORRY with USDG
        bool usdgIs0 = Currency.unwrap(usdgHub.currency0) == address(usdg);
        _swap(usdgHub, usdgIs0, 5_000e6);
        uint256 sameBlock = oracle.usdValue(1_000_000e18);
        assertApproxEqRel(sameBlock, before, 1e14, "the push is not in the mean within its own block");
        vm.warp(T0 + 42 minutes); // one minute later
        uint256 oneMinute = oracle.usdValue(1_000_000e18);
        assertApproxEqRel(oneMinute, before, 1e16, "under 1% after a minute of a 10% push");
    }

    receive() external payable {} // the liquidity router refunds unused ETH

    function test_ready_needs_the_eth_feed_only_on_the_eth_path() public {
        _open(ethHub, ETH_TICK, 1e23, 110 ether);
        vm.warp(T0 + 31 minutes);
        ethFeed.push(2235e8, T0 + 31 minutes - 26 hours); // stale
        assertFalse(oracle.ready());
        _open(usdgHub, _usdgPoolTick(), 2e18, 0);
        vm.warp(T0 + 62 minutes);
        assertTrue(oracle.ready(), "the USDG hub needs no feed");
        assertEq(oracle.source(), 1);
    }
}
