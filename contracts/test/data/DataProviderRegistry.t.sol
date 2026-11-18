// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MerchantSplitterFactory} from "../../src/facilitator/MerchantSplitterFactory.sol";
import {MerchantSplitter} from "../../src/facilitator/MerchantSplitter.sol";
import {IMerchantSplitterFactory} from "../../src/facilitator/interfaces/IMerchantSplitter.sol";
import {DataProviderRegistry} from "../../src/data/DataProviderRegistry.sol";
import {IDataProviderRegistry} from "../../src/data/interfaces/IDataProviderRegistry.sol";
import {OrryUnset} from "../../src/markets/OrryUnset.sol";
import {DataOrry, DataStakeValue} from "./DataMocks.sol";

/// @notice Unit tests for `DataProviderRegistry` (`docs/updates/L2-DATA-MCP-SPEC.md` 2.2, invariants DR-1 to DR-6), with
/// the real `MerchantSplitterFactory` at 1%.
contract DataProviderRegistryTest is Test {
    DataOrry usdg;
    DataOrry orry;
    DataStakeValue stake;
    MerchantSplitterFactory factory;
    DataProviderRegistry reg;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant MIN = 100_000_000; // 100 USD
    string constant EP = "https://data.example.org/v1/feed";

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new DataOrry();
        orry = new DataOrry();
        stake = new DataStakeValue();
        factory = new MerchantSplitterFactory(100, address(usdg), address(orry), treasury, address(0));
        reg = new DataProviderRegistry(address(stake), address(factory), MIN);
        stake.set(alice, MIN);
        stake.set(bob, MIN * 5);
    }

    function deploy(address sv, address f, uint256 m) external returns (address) {
        return address(new DataProviderRegistry(sv, f, m));
    }

    function _list(address who) internal returns (address) {
        vm.prank(who);
        return reg.list(EP, "Alpha Feed", "Block-level stats", 2000);
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_checks() public {
        assertEq(reg.FEE_BPS(), 100);
        assertEq(reg.minStakeUsd(), MIN);
        assertEq(reg.stakeValue(), address(stake));
        assertEq(reg.providerFactory(), address(factory));
        vm.expectRevert(IDataProviderRegistry.ZeroAddress.selector);
        this.deploy(address(0), address(factory), MIN);
        vm.expectRevert(IDataProviderRegistry.ZeroAddress.selector);
        this.deploy(address(stake), address(0), MIN);
        MerchantSplitterFactory merchants = new MerchantSplitterFactory(20, address(usdg), address(orry), treasury, address(0));
        vm.expectRevert(IDataProviderRegistry.WrongFactory.selector);
        this.deploy(address(stake), address(merchants), MIN);
    }

    // ---------------------------------------------------------------- list (DR-1, DR-3)

    function test_list_creates_the_splitter_and_records_the_listing() public {
        address predicted = factory.splitterOf(alice);
        assertEq(reg.splitterOf(alice), predicted);
        vm.expectEmit(address(reg));
        emit IDataProviderRegistry.Listed(alice, predicted, EP, "Alpha Feed", "Block-level stats", 2000);
        address s = _list(alice);
        assertEq(s, predicted);
        assertTrue(factory.isSplitter(s));
        assertEq(MerchantSplitter(s).merchant(), alice, "pays the provider only");
        IDataProviderRegistry.Listing memory l = reg.listing(alice);
        assertEq(l.listedAt, block.timestamp);
        assertEq(l.updatedAt, block.timestamp);
        assertEq(l.priceUsdg, 2000);
        assertEq(l.contentHash, keccak256(abi.encode(EP, "Alpha Feed", "Block-level stats", uint256(2000))));
        assertTrue(reg.isListed(alice));
        assertTrue(reg.isActive(alice));
        assertEq(reg.providerCount(), 1);
    }

    function test_list_reuses_an_existing_splitter() public {
        address s = factory.create(alice); // anyone may create it first
        assertEq(_list(alice), s);
    }

    function test_list_needs_the_stake() public {
        stake.set(alice, MIN - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDataProviderRegistry.StakeTooLow.selector, MIN - 1, MIN));
        reg.list(EP, "Alpha Feed", "", 1);
        stake.setBroken(true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IDataProviderRegistry.StakeTooLow.selector, 0, MIN));
        reg.list(EP, "Beta", "", 1);
    }

    function test_list_twice_reverts() public {
        _list(alice);
        vm.prank(alice);
        vm.expectRevert(IDataProviderRegistry.AlreadyListed.selector);
        reg.list(EP, "Alpha Feed", "", 1);
    }

    // ---------------------------------------------------------------- input checks (DR-5)

    function test_endpoint_rules() public {
        string[8] memory bad = [
            "http://data.example.org",
            "https://a.b",
            "ftp://data.example.org/x",
            "https://data.example.org/ space",
            "https://data.example.org/\ttab",
            "HTTPS://data.example.org",
            "",
            "https://data.example.org/\x7f"
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(IDataProviderRegistry.BadEndpoint.selector);
            reg.list(bad[i], "Alpha", "", 1);
        }
        bytes memory long = bytes(string.concat("https://", _repeat("a", 192)));
        assertEq(long.length, 200);
        vm.prank(alice);
        reg.list(string(long), "Alpha", "", 1); // exactly 200 bytes is fine
        vm.prank(bob);
        vm.expectRevert(IDataProviderRegistry.BadEndpoint.selector);
        reg.list(string.concat(string(long), "a"), "Beta", "", 1);
        vm.prank(bob);
        reg.list("https://a.bc", "Beta", "", 1); // 12 bytes, the shortest
    }

    function test_name_description_price_rules() public {
        vm.startPrank(alice);
        vm.expectRevert(IDataProviderRegistry.BadName.selector);
        reg.list(EP, "A", "", 1);
        vm.expectRevert(IDataProviderRegistry.BadName.selector);
        reg.list(EP, _repeat("n", 41), "", 1);
        vm.expectRevert(IDataProviderRegistry.BadName.selector);
        reg.list(EP, "Al\npha", "", 1);
        vm.expectRevert(IDataProviderRegistry.BadName.selector);
        reg.list(EP, "Al\x7fpha", "", 1);
        vm.expectRevert(IDataProviderRegistry.BadDescription.selector);
        reg.list(EP, "Alpha", _repeat("d", 281), 1);
        vm.expectRevert(IDataProviderRegistry.BadPrice.selector);
        reg.list(EP, "Alpha", "", 0);
        reg.list(EP, _repeat("n", 40), _repeat("d", 280), 1); // the limits themselves are fine
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- update and unlist (DR-4, DR-6)

    function test_update_by_the_provider_only_with_stake() public {
        _list(alice);
        vm.prank(bob);
        vm.expectRevert(IDataProviderRegistry.NotListed.selector);
        reg.update(EP, "Bob", "", 1);
        vm.warp(block.timestamp + 10);
        vm.expectEmit(address(reg));
        emit IDataProviderRegistry.Updated(alice, "https://data.example.org/v2", "Alpha Two", "new", 3000);
        vm.prank(alice);
        reg.update("https://data.example.org/v2", "Alpha Two", "new", 3000);
        IDataProviderRegistry.Listing memory l = reg.listing(alice);
        assertEq(l.priceUsdg, 3000);
        assertEq(l.updatedAt, block.timestamp);
        assertEq(l.listedAt, block.timestamp - 10, "listing time kept");
        assertEq(l.contentHash, keccak256(abi.encode("https://data.example.org/v2", "Alpha Two", "new", uint256(3000))));
        stake.set(alice, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDataProviderRegistry.StakeTooLow.selector, 0, MIN));
        reg.update(EP, "Alpha", "", 1);
        stake.set(alice, MIN);
        vm.prank(alice);
        vm.expectRevert(IDataProviderRegistry.BadPrice.selector);
        reg.update(EP, "Alpha", "", 0);
    }

    function test_unlist_always_works_and_counts() public {
        _list(alice);
        _list(bob);
        assertEq(reg.providerCount(), 2);
        stake.set(alice, 0);
        stake.setBroken(true);
        vm.expectEmit(address(reg));
        emit IDataProviderRegistry.Unlisted(alice);
        vm.prank(alice);
        reg.unlist();
        assertEq(reg.providerCount(), 1);
        assertFalse(reg.isListed(alice));
        assertEq(reg.listing(alice).listedAt, 0);
        vm.prank(alice);
        vm.expectRevert(IDataProviderRegistry.NotListed.selector);
        reg.unlist();
        // relisting after an unlist reuses the same splitter
        stake.setBroken(false);
        stake.set(alice, MIN);
        address s = _list(alice);
        assertEq(s, factory.splitterOf(alice));
        assertEq(reg.providerCount(), 2);
    }

    // ---------------------------------------------------------------- active reads the stake live (DR-2)

    function test_active_follows_the_stake_without_any_call() public {
        _list(alice);
        assertTrue(reg.isActive(alice));
        stake.set(alice, MIN - 1);
        assertFalse(reg.isActive(alice), "unstaked: out of the active set");
        assertTrue(reg.isListed(alice));
        stake.set(alice, MIN);
        assertTrue(reg.isActive(alice));
        stake.setBroken(true);
        assertFalse(reg.isActive(alice), "a failing stake read counts as no stake");
        assertEq(reg.stakeUsdOf(alice), 0);
        assertFalse(reg.isActive(makeAddr("nobody")));
    }

    function testFuzz_active_iff_listed_and_staked(uint256 v, bool listed) public {
        v = bound(v, 0, MIN * 10);
        if (listed) _list(alice);
        stake.set(alice, v);
        assertEq(reg.isActive(alice), listed && v >= MIN);
    }

    // ---------------------------------------------------------------- the 1% split on a provider payment

    function test_provider_payment_pays_one_percent() public {
        address s = _list(alice);
        usdg.mint(s, 1_000_000);
        MerchantSplitter(s).forward(address(usdg));
        assertEq(usdg.balanceOf(treasury), 10_000, "1% to the treasury");
        assertEq(usdg.balanceOf(alice), 990_000);
        orry.mint(s, 1e18);
        uint256 supply = orry.totalSupply();
        MerchantSplitter(s).forward(address(orry));
        assertEq(supply - orry.totalSupply(), 1e16, "1% of ORRY burned (source 7)");
        assertEq(orry.balanceOf(alice), 99e16);
    }

    // ---------------------------------------------------------------- USDG-only mode: no stake, no ORRY (owner 2026-11-18)

    function _openRegistry() internal returns (DataProviderRegistry open, MerchantSplitterFactory f, OrryUnset unset) {
        unset = new OrryUnset();
        f = new MerchantSplitterFactory(100, address(usdg), address(unset), treasury, address(unset));
        open = new DataProviderRegistry(address(unset), address(f), 0);
    }

    function test_usdg_only_lists_anyone_without_stake() public {
        (DataProviderRegistry open, MerchantSplitterFactory f,) = _openRegistry();
        assertEq(open.minStakeUsd(), 0);
        address carol = makeAddr("carol");
        assertFalse(open.isActive(carol), "not listed, not active");
        vm.prank(carol);
        address s = open.list(EP, "Gamma Feed", "", 1500);
        assertEq(s, f.splitterOf(carol));
        assertEq(open.stakeUsdOf(carol), 0, "OrryUnset reads no stake");
        assertTrue(open.isActive(carol), "listed with no stake is active");
        vm.prank(carol);
        open.update("https://data.example.org/v2", "Gamma Feed", "v2", 1000);
        assertEq(open.listing(carol).priceUsdg, 1000);
        vm.prank(carol);
        open.unlist();
        assertFalse(open.isActive(carol));
        assertEq(open.providerCount(), 0);
    }

    function testFuzz_usdg_only_payment_pays_one_percent(uint96 amount) public {
        (DataProviderRegistry open,, OrryUnset unset) = _openRegistry();
        vm.assume(amount > 0);
        vm.prank(alice);
        address s = open.list(EP, "Alpha Feed", "", 2000);
        usdg.mint(s, amount);
        MerchantSplitter(s).forward(address(usdg));
        uint256 fee = (uint256(amount) * 100) / 10_000;
        assertEq(usdg.balanceOf(treasury), fee, "1% to the treasury, no stake discount");
        assertEq(usdg.balanceOf(alice), uint256(amount) - fee);
        assertEq(usdg.balanceOf(s), 0);
        vm.expectRevert();
        MerchantSplitter(s).forward(address(unset));
    }

    function _repeat(string memory c, uint256 n) internal pure returns (string memory out) {
        bytes memory b = new bytes(n);
        bytes1 ch = bytes(c)[0];
        for (uint256 i; i < n; ++i) b[i] = ch;
        out = string(b);
    }
}
