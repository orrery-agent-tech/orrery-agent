// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MerchantSplitter} from "../../src/facilitator/MerchantSplitter.sol";
import {MerchantSplitterFactory} from "../../src/facilitator/MerchantSplitterFactory.sol";
import {IMerchantSplitter, IMerchantSplitterFactory} from "../../src/facilitator/interfaces/IMerchantSplitter.sol";
import {IOrryBurnEvents} from "../../src/orry/interfaces/IOrryToken.sol";

contract Token is ERC20 {
    uint8 private immutable _d;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        _d = d;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function burn(uint256 a) external {
        _burn(msg.sender, a);
    }
}

contract Tiers {
    uint16 public d;
    bool public broken;

    function set(uint16 v, bool b) external {
        d = v;
        broken = b;
    }

    function discountBps(address) external view returns (uint16) {
        require(!broken, "oracle not ready");
        return d;
    }
}

contract MerchantSplitterTest is Test {
    Token usdg = new Token("USDG", 6);
    Token orry = new Token("ORRY", 18);
    Token other = new Token("OTHER", 18);
    Tiers tiers = new Tiers();
    address treasury = makeAddr("treasury");
    address merchant = makeAddr("merchant");
    MerchantSplitterFactory factory;

    function setUp() public {
        factory = new MerchantSplitterFactory(20, address(usdg), address(orry), treasury, address(tiers));
    }

    function _splitter() internal returns (MerchantSplitter s) {
        s = MerchantSplitter(factory.create(merchant));
    }

    /// @dev An external call, so `vm.expectRevert` checks this one deployment: a bare `new` after it would end the test at
    /// the first expected revert and skip every line below.
    function deployFactory(uint16 fee, address u, address r, address t, address ti) external returns (address) {
        return address(new MerchantSplitterFactory(fee, u, r, t, ti));
    }

    // ---------------------------------------------------------------- factory

    function test_address_is_known_before_it_exists_and_anyone_creates_it() public {
        address predicted = factory.splitterOf(merchant);
        assertEq(predicted.code.length, 0);
        vm.expectEmit(address(factory));
        emit IMerchantSplitterFactory.SplitterCreated(merchant, predicted);
        vm.prank(makeAddr("stranger"));
        address s = factory.create(merchant);
        assertEq(s, predicted);
        assertTrue(factory.isSplitter(s));
        assertEq(IMerchantSplitter(s).merchant(), merchant, "always pays the merchant it was made for");
        assertEq(IMerchantSplitter(s).factory(), address(factory));
        vm.expectRevert(IMerchantSplitterFactory.SplitterExists.selector);
        factory.create(merchant);
    }

    function test_constructor_and_create_guards() public {
        vm.expectRevert(IMerchantSplitterFactory.FeeTooHigh.selector);
        this.deployFactory(101, address(usdg), address(orry), treasury, address(tiers));
        vm.expectRevert(IMerchantSplitterFactory.ZeroAddress.selector);
        this.deployFactory(20, address(0), address(orry), treasury, address(tiers));
        vm.expectRevert(IMerchantSplitterFactory.ZeroAddress.selector);
        this.deployFactory(20, address(usdg), address(0), treasury, address(tiers));
        vm.expectRevert(IMerchantSplitterFactory.ZeroAddress.selector);
        this.deployFactory(20, address(usdg), address(orry), address(0), address(tiers));
        vm.expectRevert(IMerchantSplitterFactory.ZeroAddress.selector);
        factory.create(address(0));
        // the edges pass: 100 bps is the cap, and no tiers contract is allowed
        assertEq(MerchantSplitterFactory(this.deployFactory(100, address(usdg), address(orry), treasury, address(0))).FEE_BPS(), 100);
    }

    function test_no_one_can_reinitialize_or_use_the_implementation() public {
        MerchantSplitter s = _splitter();
        vm.expectRevert(IMerchantSplitter.AlreadyInitialized.selector);
        s.initialize(makeAddr("thief"));
        MerchantSplitter impl = MerchantSplitter(factory.implementation());
        vm.expectRevert(IMerchantSplitter.AlreadyInitialized.selector);
        impl.initialize(makeAddr("thief"));
        // tokens sent to the implementation by mistake cannot be forwarded to address zero
        usdg.mint(address(impl), 10e6);
        vm.expectRevert(IMerchantSplitter.NotFactory.selector);
        impl.forward(address(usdg));
    }

    // ---------------------------------------------------------------- forward

    function test_usdg_fee_goes_to_the_treasury_and_the_rest_to_the_merchant() public {
        MerchantSplitter s = _splitter();
        usdg.mint(address(s), 1_000e6);
        vm.prank(makeAddr("anyone"));
        (uint256 toMerchant, uint256 fee) = s.forward(address(usdg));
        assertEq(fee, 2e6, "0.2% of 1,000 USDG");
        assertEq(toMerchant, 998e6);
        assertEq(usdg.balanceOf(treasury), 2e6);
        assertEq(usdg.balanceOf(merchant), 998e6);
        assertEq(usdg.balanceOf(address(s)), 0, "holds nothing after a forward");
    }

    function test_orry_fee_is_burned() public {
        MerchantSplitter s = _splitter();
        orry.mint(address(s), 1_000e18);
        uint256 supply = orry.totalSupply();
        vm.expectEmit(address(s));
        emit IOrryBurnEvents.Burned(7, 2e18);
        (uint256 toMerchant, uint256 fee) = s.forward(address(orry));
        assertEq(fee, 2e18);
        assertEq(supply - orry.totalSupply(), 2e18, "the fee left the supply");
        assertEq(orry.balanceOf(merchant), toMerchant);
        assertEq(orry.balanceOf(treasury), 0);
    }

    function test_other_tokens_pass_whole() public {
        MerchantSplitter s = _splitter();
        other.mint(address(s), 5e18);
        (uint256 toMerchant, uint256 fee) = s.forward(address(other));
        assertEq(fee, 0);
        assertEq(toMerchant, 5e18);
        assertEq(other.balanceOf(merchant), 5e18);
    }

    function test_stake_discount_lowers_the_fee() public {
        MerchantSplitter s = _splitter();
        tiers.set(5000, false); // 50% off
        usdg.mint(address(s), 1_000e6);
        (uint256 previewMerchant, uint256 previewFee, uint16 d) = s.previewForward(address(usdg));
        assertEq(d, 5000);
        vm.expectEmit(address(s));
        emit IMerchantSplitter.Forwarded(address(usdg), 999e6, 1e6, 5000);
        (uint256 toMerchant, uint256 fee) = s.forward(address(usdg));
        assertEq(fee, 1e6, "0.1%");
        assertEq(previewFee, fee, "the preview is the forward");
        assertEq(previewMerchant, toMerchant);
    }

    function test_a_failing_tiers_read_means_no_discount_and_never_blocks() public {
        MerchantSplitter s = _splitter();
        tiers.set(5000, true);
        usdg.mint(address(s), 1_000e6);
        (, uint256 fee) = s.forward(address(usdg));
        assertEq(fee, 2e6);
    }

    function test_discount_above_100_percent_is_clamped() public {
        MerchantSplitter s = _splitter();
        tiers.set(60_000, false);
        usdg.mint(address(s), 1_000e6);
        (uint256 toMerchant, uint256 fee) = s.forward(address(usdg));
        assertEq(fee, 0);
        assertEq(toMerchant, 1_000e6);
    }

    function test_no_tiers_contract_means_no_discount() public {
        MerchantSplitterFactory f = new MerchantSplitterFactory(20, address(usdg), address(orry), treasury, address(0));
        MerchantSplitter s = MerchantSplitter(f.create(merchant));
        usdg.mint(address(s), 500e6);
        (, uint256 fee) = s.forward(address(usdg));
        assertEq(fee, 1e6);
    }

    function test_nothing_to_forward_reverts() public {
        MerchantSplitter s = _splitter();
        vm.expectRevert(IMerchantSplitter.NothingToForward.selector);
        s.forward(address(usdg));
    }

    /// Conservation: everything that arrived leaves, split exactly, and the fee never exceeds FEE_BPS.
    function testFuzz_forward_conserves(uint128 amount, uint16 discount) public {
        vm.assume(amount > 0);
        MerchantSplitter s = _splitter();
        tiers.set(discount, false);
        usdg.mint(address(s), amount);
        (uint256 toMerchant, uint256 fee) = s.forward(address(usdg));
        assertEq(toMerchant + fee, amount);
        assertLe(fee, uint256(amount) * 20 / 10_000);
        assertEq(usdg.balanceOf(address(s)), 0);
        assertEq(usdg.balanceOf(merchant) + usdg.balanceOf(treasury), amount);
    }
}
