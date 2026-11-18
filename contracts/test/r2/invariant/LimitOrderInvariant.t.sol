// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {LimitBase} from "../utils/LimitBase.sol";
import {LimitOrderBook} from "../../../src/markets/r2/LimitOrderBook.sol";
import {ILimitOrderBook} from "../../../src/markets/r2/interfaces/ILimitOrderBook.sol";
import {MockStock, MockUsdg} from "../../markets/utils/MarketMocks.sol";

/// @notice Random signed orders, pool pushes and cancellations against the book (`docs/updates/L3-R2-SPEC.md` 4).
contract LimitHandler is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    LimitOrderBook internal book;
    MockStock internal stock;
    MockUsdg internal usdg;
    PoolSwapTest internal router;
    PoolKey internal key;
    address internal pm;
    address internal treasury;
    address internal keeper;
    bool internal assetIs0;
    uint256[] internal keys;
    address[] internal makers;
    uint256 internal nonce = 1;

    ILimitOrderBook.Order[] internal filled;
    bytes[] internal filledSigs;

    uint256 public fees;
    uint256 public tips;
    uint256 public nFills;
    uint256 public nRefused;
    uint256 public nCancels;
    uint256 public nReplays;

    constructor(
        LimitOrderBook book_,
        MockStock stock_,
        MockUsdg usdg_,
        PoolSwapTest router_,
        PoolKey memory key_,
        address pm_,
        address treasury_,
        address keeper_,
        uint256[] memory keys_
    ) {
        (book, stock, usdg, router, key, pm, treasury, keeper) =
            (book_, stock_, usdg_, router_, key_, pm_, treasury_, keeper_);
        assetIs0 = address(stock_) < address(usdg_);
        keys = keys_;
        for (uint256 i; i < keys_.length; ++i) {
            address m = vm.addr(keys_[i]);
            makers.push(m);
            stock.mint(m, 1_000_000e18);
            usdg.mint(m, 1_000_000_000e6);
            vm.startPrank(m);
            stock.approve(address(book), type(uint256).max);
            usdg.approve(address(book), type(uint256).max);
            vm.stopPrank();
        }
        stock.mint(address(this), 10_000_000e18);
        usdg.mint(address(this), 10_000_000_000e6);
        stock.approve(address(router), type(uint256).max);
        usdg.approve(address(router), type(uint256).max);
    }

    function _sqrtAt(uint256 price) internal view returns (uint160) {
        uint256 ratio = assetIs0 ? price * 2 ** 192 / 1e18 : 1e18 * 2 ** 192 / price;
        return uint160(Math.sqrt(ratio));
    }

    /// @dev Moves the pool to a price between 340 and 376 USD (the band is 354.7 to 361.8).
    function push(uint256 seed) external {
        uint256 price = 340e6 + (seed % 36e6);
        uint160 target = _sqrtAt(price);
        (uint160 now_,,,) = IPoolManager(pm).getSlot0(key.toId());
        if (target == now_) return;
        router.swap(
            key,
            SwapParams({zeroForOne: target < now_, amountSpecified: -int256(1e30), sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function place(uint256 makerSeed, bool sell, uint256 amount, uint256 limitSeed, uint16 tip) external {
        uint256 i = makerSeed % makers.length;
        amount = sell ? bound(amount, 1e15, 5e18) : bound(amount, 1e6, 2_000e6);
        uint256 limit = sell ? 330e6 + limitSeed % 40e6 : 345e6 + limitSeed % 40e6;
        ILimitOrderBook.Order memory o = ILimitOrderBook.Order({
            owner: makers[i],
            asset: address(stock),
            sellAsset: sell,
            amountIn: amount,
            limitPrice: limit,
            tipBps: uint16(bound(tip, 0, 100)),
            payFeeInOrry: false,
            nonce: nonce++,
            expiry: uint64(block.timestamp + 1 days)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], book.hashOrder(o));
        bytes memory sig = abi.encodePacked(r, s, v);
        uint256 t = usdg.balanceOf(treasury);
        uint256 k = usdg.balanceOf(keeper);
        bool wasUsed = book.nonceUsed(o.owner, o.nonce);
        vm.prank(keeper);
        try book.fill(o, sig) returns (uint256 out) {
            uint256 notional = sell ? out : amount;
            // LO-3: realised price within limit and band
            uint256 low = 354_667500;
            uint256 high = 361_832500;
            if (sell) {
                require(out * 1e18 >= limit * amount && out * 1e18 >= low * amount, "LO-3 sell low");
                require(out * 1e18 <= high * amount, "LO-3 sell high");
            } else {
                require(amount * 1e18 <= limit * out && amount * 1e18 <= high * out, "LO-3 buy high");
                require(amount * 1e18 >= low * out, "LO-3 buy low");
            }
            require(usdg.balanceOf(treasury) - t == notional * 10 / 10_000, "LO-5 fee");
            require(usdg.balanceOf(keeper) - k == notional * o.tipBps / 10_000, "LO-5 tip");
            fees += notional * 10 / 10_000;
            tips += notional * o.tipBps / 10_000;
            filled.push(o);
            filledSigs.push(sig);
            ++nFills;
        } catch {
            require(book.nonceUsed(o.owner, o.nonce) == wasUsed, "a refused fill changes no nonce");
            ++nRefused;
        }
    }

    function replay(uint256 seed) external {
        if (filled.length == 0) return;
        uint256 j = seed % filled.length;
        vm.prank(keeper);
        try book.fill(filled[j], filledSigs[j]) {
            revert("LO-2 nonce filled twice");
        } catch {
            ++nReplays;
        }
    }

    /// @dev LO-2: a signed order whose nonce its owner cancelled never fills.
    function cancelNext(uint256 makerSeed) external {
        uint256 i = makerSeed % makers.length;
        ILimitOrderBook.Order memory o = ILimitOrderBook.Order({
            owner: makers[i],
            asset: address(stock),
            sellAsset: true,
            amountIn: 1e18,
            limitPrice: 1,
            tipBps: 0,
            payFeeInOrry: false,
            nonce: nonce++,
            expiry: uint64(block.timestamp + 1 days)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], book.hashOrder(o));
        vm.prank(o.owner);
        book.cancel(o.nonce);
        vm.prank(keeper);
        try book.fill(o, abi.encodePacked(r, s, v)) {
            revert("LO-2 cancelled order filled");
        } catch {
            ++nCancels;
        }
    }
}

contract LimitOrderInvariantTest is LimitBase {
    LimitHandler internal h;

    function setUp() public override {
        super.setUp();
        uint256[] memory ks = new uint256[](3);
        (ks[0], ks[1], ks[2]) = (0xA11CE, 0xB0B, 0xCA401);
        h = new LimitHandler(book, stock, usdg, swapRouter, key, pm, treasury, keeper, ks);
        targetContract(address(h));
    }

    function _check() internal view {
        assertEq(stock.balanceOf(address(book)), 0, "LO-1 asset");
        assertEq(usdg.balanceOf(address(book)), 0, "LO-1 usdg");
        assertEq(usdg.balanceOf(treasury), h.fees(), "fees reach only the treasury");
        assertEq(usdg.balanceOf(keeper), h.tips(), "tips reach only the keeper");
    }

    function invariant_book_holds_nothing() public view {
        _check();
    }

    function test_deep_run() public {
        uint256 seed = 0x0bd;
        for (uint256 step; step < 1500; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = seed % 100;
            uint256 a = seed >> 8;
            uint256 b = seed >> 72;
            uint256 c = seed >> 136;
            if (pick < 20) h.push(b);
            else if (pick < 85) h.place(a, (c & 1) == 1, b, c >> 8, uint16(a >> 100));
            else if (pick < 93) h.replay(b);
            else h.cancelNext(a);
            if (step % 50 == 0) _check();
        }
        _check();
        console2.log("fills / refused / replays refused / cancels", h.nFills(), h.nRefused(), h.nReplays());
        assertGt(h.nFills(), 50);
        assertGt(h.nRefused(), 50);
        assertGt(h.nReplays(), 0);
        assertGt(h.nCancels(), 0);
    }
}
