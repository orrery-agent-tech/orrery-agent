// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {LimitBase, Wallet1271} from "./utils/LimitBase.sol";
import {MockStock, MockFeed} from "../markets/utils/MarketMocks.sol";
import {ShortBurnOrry} from "./utils/R2Mocks.sol";
import {LimitOrderBook} from "../../src/markets/r2/LimitOrderBook.sol";
import {ILimitOrderBook} from "../../src/markets/r2/interfaces/ILimitOrderBook.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";

/// @notice Unit tests of `LimitOrderBook` (`docs/updates/L3-R2-SPEC.md` 4, LO-1 to LO-6).
contract LimitOrderBookTest is LimitBase {
    uint256 internal constant LOW_BAND = 354_667500; // 358.25 USD less 1%, rounded up
    uint256 internal constant HIGH_BAND = 361_832500; // 358.25 USD plus 1%

    function _balancesZero() internal view {
        assertEq(stock.balanceOf(address(book)), 0, "LO-1 asset");
        assertEq(usdg.balanceOf(address(book)), 0, "LO-1 usdg");
    }

    // ------------------------------------------------------------------ constructor and views

    function test_constructor_checks() public {
        vm.expectRevert(bytes("fee"));
        new LimitOrderBook(address(usdg), address(pf), pm, treasury, address(tiers), address(orryPrice), address(orry), 51, 100, 1, 0);
        vm.expectRevert(bytes("deviation"));
        new LimitOrderBook(address(usdg), address(pf), pm, treasury, address(tiers), address(orryPrice), address(orry), 10, 0, 1, 0);
        vm.expectRevert(bytes("deviation"));
        new LimitOrderBook(address(usdg), address(pf), pm, treasury, address(tiers), address(orryPrice), address(orry), 10, 1001, 1, 0);
        vm.expectRevert(bytes("staleness"));
        new LimitOrderBook(address(usdg), address(pf), pm, treasury, address(tiers), address(orryPrice), address(orry), 10, 100, 0, 0);
        vm.expectRevert(bytes("orry discount"));
        new LimitOrderBook(address(usdg), address(pf), pm, treasury, address(tiers), address(orryPrice), address(orry), 10, 100, 1, 10_001);
        vm.expectRevert(bytes("zero address"));
        new LimitOrderBook(address(usdg), address(0), pm, treasury, address(tiers), address(orryPrice), address(orry), 10, 100, 1, 0);
    }

    function test_getters() public view {
        assertEq(book.usdg(), address(usdg));
        assertEq(book.marketFactory(), address(pf));
        assertEq(book.poolManager(), pm);
        assertEq(book.treasury(), treasury);
        assertEq(book.feeTiers(), address(tiers));
        assertEq(book.orryPrice(), address(orryPrice));
        assertEq(book.orry(), address(orry));
        assertEq(book.feeBps(), 10);
        assertEq(book.maxDeviationBps(), 100);
        assertEq(book.maxStaleness(), 90_000);
        assertEq(book.orryFeeDiscountBps(), 2500);
        assertEq(book.MAX_TIP_BPS(), 100);
        assertEq(book.oraclePrice(address(stock)), TSLA_PRICE);
        assertEq(
            book.ORDER_TYPEHASH(),
            keccak256(
                "Order(address owner,address asset,bool sellAsset,uint256 amountIn,uint256 limitPrice,uint16 tipBps,bool payFeeInOrry,uint256 nonce,uint64 expiry)"
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Orrery Limit Orders"),
                keccak256("1"),
                block.chainid,
                address(book)
            )
        );
        assertEq(book.DOMAIN_SEPARATOR(), domain);
    }

    function test_domain_follows_a_chain_id_change() public {
        bytes32 before_ = book.DOMAIN_SEPARATOR();
        vm.chainId(999);
        assertTrue(book.DOMAIN_SEPARATOR() != before_);
    }

    // ------------------------------------------------------------------ fills

    function test_sell_fills_whole_and_pays_owner_treasury_and_keeper() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 20);
        uint256 u = usdg.balanceOf(maker);
        uint256 s = stock.balanceOf(maker);
        uint256 out = _fill(o);
        uint256 fee = out * 10 / 10_000;
        uint256 tip = out * 20 / 10_000;
        assertEq(s - stock.balanceOf(maker), 1e18);
        assertEq(usdg.balanceOf(maker) - u, out - fee - tip, "LO-4 seller net of fee and tip");
        assertEq(usdg.balanceOf(treasury), fee);
        assertEq(usdg.balanceOf(keeper), tip);
        // LO-3: within the limit and within 1% of the oracle
        assertGe(out, 350e6);
        assertGe(out, LOW_BAND);
        assertLe(out, HIGH_BAND);
        assertTrue(book.nonceUsed(maker, o.nonce));
        _balancesZero();
    }

    function test_buy_fills_whole_owner_pays_fee_and_tip_on_top() public {
        ILimitOrderBook.Order memory o = _order(false, 500e6, 365e6, 50);
        uint256 u = usdg.balanceOf(maker);
        uint256 s = stock.balanceOf(maker);
        uint256 out = _fill(o);
        uint256 fee = 500e6 * 10 / 10_000;
        uint256 tip = 500e6 * 50 / 10_000;
        assertEq(u - usdg.balanceOf(maker), 500e6 + fee + tip, "LO-4 buyer pays amount, fee and tip");
        assertEq(stock.balanceOf(maker) - s, out, "all the asset the pool returned");
        assertEq(usdg.balanceOf(treasury), fee);
        assertEq(usdg.balanceOf(keeper), tip);
        // realised USDG per 1e18 asset within limit and band
        assertLe(500e6 * 1e18, 365e6 * out);
        assertLe(500e6 * 1e18, HIGH_BAND * out);
        assertGe(500e6 * 1e18, LOW_BAND * out);
        _balancesZero();
    }

    function test_fill_emits() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        bytes memory sig = _sign(o, makerKey);
        bytes32 h = book.hashOrder(o);
        vm.expectEmit(true, true, true, false, address(book));
        emit ILimitOrderBook.OrderFilled(h, maker, address(stock), true, o.nonce, 1e18, 0, 0, 0, 0, keeper);
        vm.prank(keeper);
        book.fill(o, sig);
    }

    function test_limit_not_met_is_not_fillable() public {
        ILimitOrderBook.Order memory sell = _order(true, 1e18, 359e6, 0); // pool pays about 358
        bytes memory sig = _sign(sell, makerKey);
        vm.expectRevert(ILimitOrderBook.NotFillable.selector);
        book.fill(sell, sig);
        ILimitOrderBook.Order memory buy = _order(false, 500e6, 357e6, 0); // pool asks about 358.4
        sig = _sign(buy, makerKey);
        vm.expectRevert(ILimitOrderBook.NotFillable.selector);
        book.fill(buy, sig);
        assertFalse(book.nonceUsed(maker, sell.nonce), "a failed fill uses nothing");
    }

    function test_limit_outside_the_band_is_not_fillable_even_if_the_pool_meets_it() public {
        ILimitOrderBook.Order memory sell = _order(true, 1e18, 370e6, 0); // above the band's top
        bytes memory sig = _sign(sell, makerKey);
        _pushTo(372e6);
        vm.expectRevert(ILimitOrderBook.NotFillable.selector);
        book.fill(sell, sig);
    }

    /// A keeper pushes the pool down to a seller's limit to buy its asset cheap: the oracle band refuses the fill.
    function test_keeper_cannot_push_the_pool_to_the_limit_and_take_the_gap() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 340e6, 100);
        bytes memory sig = _sign(o, makerKey);
        _pushTo(345e6);
        vm.prank(keeper);
        vm.expectRevert(ILimitOrderBook.NotFillable.selector);
        book.fill(o, sig);
        _pushTo(TSLA_PRICE);
        vm.prank(keeper);
        uint256 out = book.fill(o, sig);
        assertGe(out, LOW_BAND);
    }

    function test_buyer_is_protected_from_a_pool_pushed_up() public {
        ILimitOrderBook.Order memory o = _order(false, 500e6, 400e6, 0);
        bytes memory sig = _sign(o, makerKey);
        _pushTo(370e6);
        vm.expectRevert(ILimitOrderBook.NotFillable.selector);
        book.fill(o, sig);
    }

    function test_too_large_for_the_pool_is_not_fillable() public {
        // about 1,060 TSLA in the pool: buying with 1,000,000 USDG moves the price far past the band
        usdg.mint(maker, 1_000_000e6);
        ILimitOrderBook.Order memory o = _order(false, 1_000_000e6, type(uint256).max, 0);
        bytes memory sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.NotFillable.selector);
        book.fill(o, sig);
    }

    // ------------------------------------------------------------------ oracle and listing

    function test_stale_feed_blocks_fills() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        o.expiry = uint64(_now() + 10 days);
        bytes memory sig = _sign(o, makerKey);
        vm.warp(START - 60 + 90_001);
        vm.expectRevert(ILimitOrderBook.StalePrice.selector);
        book.fill(o, sig);
        vm.warp(START - 60 + 90_000);
        book.fill(o, sig); // the boundary itself is fresh
    }

    function test_future_or_non_positive_feed_answers_block_fills() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        bytes memory sig = _sign(o, makerKey);
        feed.push(-1, _now());
        vm.expectRevert(ILimitOrderBook.StalePrice.selector);
        book.fill(o, sig);
        feed.push(TSLA_ANSWER, _now() + 1);
        vm.expectRevert(ILimitOrderBook.StalePrice.selector);
        book.fill(o, sig);
        feed.push(TSLA_ANSWER, 0);
        vm.expectRevert(ILimitOrderBook.StalePrice.selector);
        book.fill(o, sig);
    }

    function test_oracle_pause_and_corporate_action_block_fills() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        bytes memory sig = _sign(o, makerKey);
        stock.setOraclePaused(true);
        vm.expectRevert(ILimitOrderBook.StalePrice.selector);
        book.fill(o, sig);
        stock.setOraclePaused(false);
        stock.scheduleMultiplier(2e18, _now()); // took effect after the last round
        vm.expectRevert(ILimitOrderBook.StalePrice.selector);
        book.fill(o, sig);
        feed.push(TSLA_ANSWER, _now()); // a round at the effective time clears it
        book.fill(o, sig);
    }

    function test_corporate_action_scheduled_in_the_future_does_not_block() public {
        stock.scheduleMultiplier(2e18, _now() + 1 days);
        _fill(_order(true, 1e18, 350e6, 0));
    }

    function test_unlisted_asset_or_market_without_pool_is_not_listed() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        o.asset = address(0xBEEF);
        bytes memory sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.NotListed.selector);
        book.fill(o, sig);
        // a book on the R1 factory whose market has no remainder pool
        LimitOrderBook b2 = new LimitOrderBook(
            address(usdg), address(factory), pm, treasury, address(tiers), address(orryPrice), address(orry), 10, 100, 90_000, 2500
        );
        vm.expectRevert(ILimitOrderBook.NotListed.selector);
        b2.oraclePrice(address(stock));
    }

    // ------------------------------------------------------------------ order checks

    function test_bad_orders() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 101);
        bytes memory sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.BadOrder.selector);
        book.fill(o, sig);
        o = _order(true, 0, 350e6, 0);
        sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.BadOrder.selector);
        book.fill(o, sig);
        o = _order(true, 1e18, 0, 0);
        sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.BadOrder.selector);
        book.fill(o, sig);
        o = _order(true, uint256(type(uint128).max) + 1, 1, 0);
        sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.BadOrder.selector);
        book.fill(o, sig);
        o = _order(true, 1e18, 350e6, 0);
        o.owner = address(0);
        vm.expectRevert(ILimitOrderBook.BadOrder.selector);
        book.fill(o, sig);
    }

    function test_max_tip_is_allowed() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 100);
        uint256 out = _fill(o);
        assertEq(usdg.balanceOf(keeper), out / 100);
    }

    function test_expiry() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        bytes memory sig = _sign(o, makerKey);
        vm.warp(o.expiry + 1);
        vm.expectRevert(ILimitOrderBook.OrderExpired.selector);
        book.fill(o, sig);
        vm.warp(o.expiry);
        book.fill(o, sig); // the last second still fills
    }

    function test_nonce_fills_once() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        bytes memory sig = _sign(o, makerKey);
        book.fill(o, sig);
        vm.expectRevert(ILimitOrderBook.NonceUsed.selector);
        book.fill(o, sig);
        // a different order on the same nonce
        o.amountIn = 2e18;
        sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.NonceUsed.selector);
        book.fill(o, sig);
    }

    function test_cancel_and_cancel_many() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        bytes memory sig = _sign(o, makerKey);
        vm.expectEmit(address(book));
        emit ILimitOrderBook.NonceCancelled(maker, o.nonce);
        vm.prank(maker);
        book.cancel(o.nonce);
        vm.expectRevert(ILimitOrderBook.NonceUsed.selector);
        book.fill(o, sig);
        vm.prank(maker);
        vm.expectRevert(ILimitOrderBook.NonceUsed.selector);
        book.cancel(o.nonce);
        uint256[] memory ns = new uint256[](2);
        (ns[0], ns[1]) = (77, 78);
        vm.prank(maker);
        book.cancelMany(ns);
        assertTrue(book.nonceUsed(maker, 77));
        assertTrue(book.nonceUsed(maker, 78));
        // someone else's cancel touches only their own nonces
        vm.prank(keeper);
        book.cancel(5);
        assertFalse(book.nonceUsed(maker, 5));
    }

    function test_signatures() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        (, uint256 otherKey) = makeAddrAndKey("other");
        bytes memory sig = _sign(o, otherKey);
        vm.expectRevert(ILimitOrderBook.BadSignature.selector);
        book.fill(o, sig);
        // a signature over different fields
        sig = _sign(o, makerKey);
        o.limitPrice = 1;
        vm.expectRevert(ILimitOrderBook.BadSignature.selector);
        book.fill(o, sig);
        // high-s form of a valid signature is refused
        o.limitPrice = 350e6;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, book.hashOrder(o));
        bytes32 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory high = abi.encodePacked(r, bytes32(uint256(n) - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(ILimitOrderBook.BadSignature.selector);
        book.fill(o, high);
        vm.expectRevert(ILimitOrderBook.BadSignature.selector);
        book.fill(o, hex"1234");
    }

    function test_erc1271_smart_account_owner() public {
        Wallet1271 w = new Wallet1271(maker);
        stock.mint(address(w), 10e18);
        w.approve(address(stock), address(book));
        w.approve(address(usdg), address(book));
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        o.owner = address(w);
        bytes memory sig = _sign(o, makerKey);
        w.setRefuse(true);
        vm.expectRevert(ILimitOrderBook.BadSignature.selector);
        book.fill(o, sig);
        w.setRefuse(false);
        uint256 out = book.fill(o, sig);
        assertEq(usdg.balanceOf(address(w)), out - out * 10 / 10_000);
        _balancesZero();
    }

    // ------------------------------------------------------------------ fees and levers

    function test_staker_discount() public {
        staking.set(maker, 1_000_000e18); // about 2,230 USD: 50% off
        ILimitOrderBook.Order memory o = _order(false, 500e6, 365e6, 0);
        uint256 u = usdg.balanceOf(maker);
        _fill(o);
        assertEq(u - usdg.balanceOf(maker), 500e6 + 250_000, "0.10% of 500 less 50%");
        assertEq(usdg.balanceOf(treasury), 250_000);
    }

    function test_fee_paid_in_orry_is_burned() public {
        ILimitOrderBook.Order memory o = _order(false, 500e6, 365e6, 10);
        o.payFeeInOrry = true;
        uint256 orryFee = orryPrice.orryFor(500_000 * 3 / 4); // 0.5 USDG fee less 25%
        uint256 supply = orry.totalSupply();
        uint256 u = usdg.balanceOf(maker);
        bytes memory sig = _sign(o, makerKey);
        vm.expectEmit(address(book));
        emit IOrryBurnEvents.Burned(32, orryFee);
        vm.prank(keeper);
        book.fill(o, sig);
        assertEq(supply - orry.totalSupply(), orryFee, "LO-5 ORRY fee burned exactly");
        assertEq(u - usdg.balanceOf(maker), 500e6 + 500_000, "amount and tip only");
        assertEq(usdg.balanceOf(treasury), 0);
        _balancesZero();
    }

    function test_orry_fee_on_a_sell_falls_back_to_usdg_when_the_price_is_not_ready() public {
        hook.set(HUB_TICK, 0);
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        o.payFeeInOrry = true;
        uint256 supply = orry.totalSupply();
        uint256 out = _fill(o);
        assertEq(orry.totalSupply(), supply);
        assertEq(usdg.balanceOf(treasury), out * 10 / 10_000);
    }

    function test_orry_fee_without_orry_allowance_reverts_whole() public {
        vm.prank(maker);
        orry.approve(address(book), 0);
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        o.payFeeInOrry = true;
        bytes memory sig = _sign(o, makerKey);
        uint256 s = stock.balanceOf(maker);
        vm.expectRevert();
        book.fill(o, sig);
        assertEq(stock.balanceOf(maker), s);
        assertFalse(book.nonceUsed(maker, o.nonce));
    }

    function test_unreadable_tiers_charge_the_full_fee() public {
        staking.set(maker, 1_000_000e18);
        staking.setReverts(true);
        ILimitOrderBook.Order memory o = _order(false, 500e6, 365e6, 0);
        uint256 u = usdg.balanceOf(maker);
        _fill(o);
        assertEq(u - usdg.balanceOf(maker), 500e6 + 500_000, "0.10% of 500, no discount");
    }

    function test_orry_fee_burn_is_checked_on_the_supply() public {
        ShortBurnOrry sr = new ShortBurnOrry(address(this), 1e27);
        LimitOrderBook b2 = new LimitOrderBook(
            address(usdg), address(pf), pm, treasury, address(tiers), address(orryPrice), address(sr), 10, 100, 90_000, 2500
        );
        sr.transfer(maker, 1_000_000e18);
        vm.startPrank(maker);
        sr.approve(address(b2), type(uint256).max);
        usdg.approve(address(b2), type(uint256).max);
        vm.stopPrank();
        ILimitOrderBook.Order memory o = _order(false, 500e6, 365e6, 0);
        o.payFeeInOrry = true;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, b2.hashOrder(o));
        vm.expectRevert(ILimitOrderBook.InexactTransfer.selector);
        b2.fill(o, abi.encodePacked(r, s, v));
    }

    // ------------------------------------------------------------------ issuer controls and callers

    function test_blocked_owner_fill_reverts_and_moves_nothing() public {
        ILimitOrderBook.Order memory o = _order(true, 1e18, 350e6, 0);
        bytes memory sig = _sign(o, makerKey);
        registry.setBlocked(maker, true);
        vm.expectRevert(ILimitOrderBook.InexactTransfer.selector);
        book.fill(o, sig);
        registry.setBlocked(maker, false);
        usdg.setFrozen(maker, true); // the seller's proceeds cannot reach it
        vm.expectRevert();
        book.fill(o, sig);
    }

    function test_unlock_callback_refuses_outsiders() public {
        vm.expectRevert(ILimitOrderBook.WrongCaller.selector);
        book.unlockCallback("");
        vm.prank(pm);
        vm.expectRevert(ILimitOrderBook.WrongCaller.selector);
        book.unlockCallback("");
    }

    /// A pool whose liquidity sits in a narrow range runs out before the whole order trades: the fill is refused rather
    /// than done in part (LO-6), and nothing moves.
    function test_partial_fill_is_refused() public {
        MockStock s2 = new MockStock(registry);
        MockFeed f2 = new MockFeed(8);
        f2.push(TSLA_ANSWER, _now());
        bool s2Is0 = address(s2) < address(usdg);
        (address c0, address c1) = s2Is0 ? (address(s2), address(usdg)) : (address(usdg), address(s2));
        PoolKey memory k2 = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 500, 10, IHooks(address(0)));
        uint256 ratio = s2Is0 ? TSLA_PRICE * 2 ** 192 / 1e18 : 1e18 * 2 ** 192 / TSLA_PRICE;
        uint160 sqrtP = uint160(Math.sqrt(ratio));
        IPoolManager(pm).initialize(k2, sqrtP);
        int24 t = TickMath.getTickAtSqrtPrice(sqrtP) / 10 * 10;
        s2.mint(address(this), 1_000e18);
        s2.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            k2, ModifyLiquidityParams({tickLower: t - 50, tickUpper: t + 50, liquidityDelta: 1e14, salt: 0}), ""
        );
        vm.prank(owner);
        pf.create(address(s2), address(f2), k2);
        s2.mint(maker, 100e18);
        vm.prank(maker);
        s2.approve(address(book), type(uint256).max);
        ILimitOrderBook.Order memory o = _order(true, 50e18, 1, 0);
        o.asset = address(s2);
        bytes memory sig = _sign(o, makerKey);
        vm.expectRevert(ILimitOrderBook.NotFillable.selector);
        book.fill(o, sig);
        assertEq(s2.balanceOf(maker), 100e18);
    }

    // ------------------------------------------------------------------ fuzz

    /// LO-1, LO-3, LO-4 for random sizes, sides and tips.
    function testFuzz_fill_conserves_and_stays_in_band(uint256 amount, bool sell, uint16 tip) public {
        tip = uint16(bound(tip, 0, 100));
        amount = sell ? bound(amount, 1e15, 2e18) : bound(amount, 1e6, 700e6);
        ILimitOrderBook.Order memory o = _order(sell, amount, sell ? 1 : type(uint256).max, tip);
        uint256 u = usdg.balanceOf(maker);
        uint256 s = stock.balanceOf(maker);
        uint256 out = _fill(o);
        uint256 notional = sell ? out : amount;
        uint256 fee = notional * 10 / 10_000;
        uint256 tipAmt = notional * tip / 10_000;
        if (sell) {
            assertEq(s - stock.balanceOf(maker), amount);
            assertEq(usdg.balanceOf(maker) - u, out - fee - tipAmt);
            assertGe(out * 1e18, LOW_BAND * amount);
            assertLe(out * 1e18, HIGH_BAND * amount);
        } else {
            assertEq(u - usdg.balanceOf(maker), amount + fee + tipAmt);
            assertEq(stock.balanceOf(maker) - s, out);
            assertGe(amount * 1e18, LOW_BAND * out);
            assertLe(amount * 1e18, HIGH_BAND * out);
        }
        assertEq(usdg.balanceOf(treasury), fee);
        assertEq(usdg.balanceOf(keeper), tipAmt);
        _balancesZero();
    }
}
