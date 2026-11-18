// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISealedBatchMarket} from "../../src/markets/interfaces/ISealedBatchMarket.sol";
import {SealedBatchMarket} from "../../src/markets/SealedBatchMarket.sol";
import {MarketFactory} from "../../src/markets/MarketFactory.sol";
import {MarketParams} from "../../src/markets/MarketParams.sol";
import {OrryUnset} from "../../src/markets/OrryUnset.sol";
import {MarketBase} from "./utils/MarketBase.sol";

/// @notice USDG-only mode: a factory whose `orry`, `orryPrice` and `feeTiers` are all one `OrryUnset`, with the
/// sealing fee and the ORRY discount at 0 as `deploy-markets-4663.ts --usdg-only` sets them. Every fee is USDG, and no
/// ORRY path is reached, whatever an order asks for.
contract MarketsUsdgOnlyTest is MarketBase {
    OrryUnset internal unset;
    address internal alice;
    address internal bob;

    function _usdgOnlyParams() internal pure returns (MarketParams memory p) {
        p = _params();
        p.commitFeeUsd = 0;
        p.orryFeeDiscountBps = 0;
    }

    function setUp() public override {
        super.setUp();
        unset = new OrryUnset();
        factory = new MarketFactory(
            owner, address(usdg), treasury, address(unset), address(unset), address(unset), pm, _usdgOnlyParams()
        );
        vm.prank(owner);
        market = SealedBatchMarket(factory.create(address(stock), address(feed), noPool));
        for (uint256 i; i < traders.length; ++i) {
            vm.startPrank(traders[i]);
            stock.approve(address(market), type(uint256).max);
            usdg.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
        (alice, bob) = (traders[0], traders[1]);
    }

    function _two(ISealedBatchMarket.Order memory oa, ISealedBatchMarket.Order memory ob) internal returns (uint256) {
        address[] memory who = new address[](2);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](2);
        (who[0], who[1], os[0], os[1]) = (alice, bob, oa, ob);
        return _place(who, os);
    }

    function test_unset_reads_as_never_ready() public {
        assertFalse(unset.ready());
        assertEq(unset.source(), 0);
        assertEq(unset.tierCount(), 0);
        assertEq(unset.discountBps(alice), 0);
        assertEq(unset.stakeUsd(alice), 0);
        assertEq(unset.totalSupply(), 0);
        assertEq(unset.balanceOf(alice), 0);
        assertEq(unset.staking(), address(unset));
        assertEq(unset.orryPrice(), address(unset));
        vm.expectRevert(OrryUnset.OrryNotSet.selector);
        unset.orryFor(1e6);
        vm.expectRevert(OrryUnset.OrryNotSet.selector);
        unset.usdValue(1e18);
    }

    function test_market_wires_the_unset_contract() public view {
        assertEq(market.orry(), address(unset));
        assertEq(market.orryPrice(), address(unset));
        assertEq(market.feeTiers(), address(unset));
        assertEq(market.commitFeeUsd(), 0);
        assertEq(market.orryFeeDiscountBps(), 0);
    }

    function test_commit_needs_no_orry() public {
        address nobody = makeAddr("no orry anywhere");
        (uint256 batch,,) = market.phase();
        bytes32 c = market.commitmentFor(batch, nobody, _sell(1e18, 1), _salt(nobody));
        vm.prank(nobody);
        market.commit(c);
        assertEq(market.commitmentOf(batch, nobody), c);
    }

    function test_cross_pays_every_fee_in_usdg() public {
        uint256 b = _two(_sell(1e18, 350e6), _buy(TSLA_PRICE, 360e6));
        uint256 fee = TSLA_PRICE * 15 / 10_000;
        uint256 aU = usdg.balanceOf(alice);
        uint256 bS = stock.balanceOf(bob);
        _clear(b);
        assertEq(usdg.balanceOf(alice) - aU, TSLA_PRICE - fee);
        assertEq(stock.balanceOf(bob) - bS, 1e18);
        assertEq(usdg.balanceOf(treasury), 2 * fee);
        ISealedBatchMarket.BatchResult memory r = market.result(b);
        assertTrue(r.cleared);
        assertEq(r.usdgFees, 2 * fee);
        assertEq(r.orryFeesBurned, 0);
        assertEq(r.ordersDropped, 0);
    }

    function test_an_order_asking_to_pay_in_orry_pays_in_usdg() public {
        ISealedBatchMarket.Order memory s = _sell(1e18, 1);
        s.payFeeInOrry = true;
        ISealedBatchMarket.Order memory bb = _buy(TSLA_PRICE, type(uint256).max);
        bb.payFeeInOrry = true;
        uint256 b = _two(s, bb);
        uint256 supply = orry.totalSupply(); // the test ORRY of MarketBase stays untouched too
        _clear(b);
        uint256 fee = TSLA_PRICE * 15 / 10_000;
        assertEq(usdg.balanceOf(treasury), 2 * fee);
        assertEq(market.result(b).orryFeesBurned, 0);
        assertEq(market.result(b).ordersDropped, 0);
        assertEq(orry.totalSupply(), supply);
    }

    function testFuzz_fee_is_the_plain_usdg_fee(uint96 amount) public {
        uint256 a = bound(uint256(amount), 1e17, 100e18);
        uint256 notional = a * TSLA_PRICE / 1e18;
        uint256 b = _two(_sell(a, 1), _buy(notional, type(uint256).max));
        _clear(b);
        ISealedBatchMarket.BatchResult memory r = market.result(b);
        assertEq(r.orryFeesBurned, 0);
        assertEq(usdg.balanceOf(treasury), r.usdgFees);
        assertEq(usdg.balanceOf(address(market)), 0);
        assertEq(stock.balanceOf(address(market)), 0);
    }
}
