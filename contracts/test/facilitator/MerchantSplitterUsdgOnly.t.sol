// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MerchantSplitter} from "../../src/facilitator/MerchantSplitter.sol";
import {MerchantSplitterFactory} from "../../src/facilitator/MerchantSplitterFactory.sol";
import {OrryUnset} from "../../src/markets/OrryUnset.sol";
import {Token} from "./MerchantSplitter.t.sol";

/// @notice USDG-only facilitator, as `deploy-facilitator-4663.ts --usdg-only` builds it: `orry` is the markets'
/// OrryUnset and `feeTiers` is zero. Every USDG forward pays 0.2% to the treasury with no discount, and no ORRY path
/// exists (OrryUnset has no balance, transfer or burn).
contract MerchantSplitterUsdgOnlyTest is Test {
    Token usdg = new Token("USDG", 6);
    Token other = new Token("OTHER", 18);
    OrryUnset unset = new OrryUnset();
    address treasury = makeAddr("treasury");
    address merchant = makeAddr("merchant");
    MerchantSplitterFactory factory;
    MerchantSplitter s;

    function setUp() public {
        factory = new MerchantSplitterFactory(20, address(usdg), address(unset), treasury, address(0));
        s = MerchantSplitter(factory.create(merchant));
    }

    function test_factory_wiring() public view {
        assertEq(factory.FEE_BPS(), 20);
        assertEq(factory.orry(), address(unset));
        assertEq(factory.feeTiers(), address(0));
        assertEq(factory.splitterOf(merchant), address(s));
        assertTrue(factory.isSplitter(address(s)));
    }

    function test_usdg_forward_pays_the_plain_fee() public {
        usdg.mint(address(s), 1_000e6);
        (uint256 toMerchant, uint256 fee, uint16 discount) = s.previewForward(address(usdg));
        assertEq(fee, 2e6); // 0.2% of 1,000 USDG
        assertEq(toMerchant, 998e6);
        assertEq(discount, 0);
        s.forward(address(usdg));
        assertEq(usdg.balanceOf(merchant), 998e6);
        assertEq(usdg.balanceOf(treasury), 2e6);
        assertEq(usdg.balanceOf(address(s)), 0);
    }

    function testFuzz_usdg_forward_conserves(uint96 amount) public {
        vm.assume(amount > 0); // an empty forward reverts NothingToForward (MerchantSplitter.t.sol covers it)
        usdg.mint(address(s), amount);
        s.forward(address(usdg));
        assertEq(usdg.balanceOf(merchant) + usdg.balanceOf(treasury), amount);
        assertEq(usdg.balanceOf(treasury), uint256(amount) * 20 / 10_000);
        assertEq(usdg.balanceOf(address(s)), 0);
    }

    function test_other_tokens_pass_whole() public {
        other.mint(address(s), 5e18);
        s.forward(address(other));
        assertEq(other.balanceOf(merchant), 5e18);
        assertEq(other.balanceOf(treasury), 0);
    }

    function test_anyone_may_forward_and_it_always_pays_the_merchant() public {
        usdg.mint(address(s), 10e6);
        vm.prank(makeAddr("keeper"));
        s.forward(address(usdg));
        assertEq(usdg.balanceOf(merchant), 10e6 - 20_000);
    }
}
