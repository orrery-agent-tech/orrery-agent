// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {TemplateMarketUsdg} from "../../../src/community/TemplateMarketUsdg.sol";

interface IUsdgFork {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface ITreasuryLive {
    function usdg() external view returns (address);
    function owner() external view returns (address);
    function orry() external view returns (address);
    function OWNER_BPS() external view returns (uint16);
    function ownerAccrued() external view returns (uint256);
    function buybackReserve() external view returns (uint256);
    function sync() external;
}

/// @notice TU-I9 on a fork of Robinhood Chain 4663 (docs/updates/TEMPLATES-USDG-SPEC.md): the market as
/// deploy-templates-4663.ts builds it, against the live USDG and Orrery's live `OrreryTreasury` (deployments/4663.json).
/// Run: forge test --match-path 'test/community/fork/TemplatesUsdgFork.t.sol' --fork-url <4663 RPC>
contract TemplatesUsdgForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TREASURY = 0xa108f36699b4A42DD0230406561f9AC6796E6f21;
    address constant OWNER = 0x273fd2a6dB4887299CD1e1FCC8d522C9741B1A73;

    TemplateMarketUsdg market;
    address alice = makeAddr("fork-creator");
    address bob = makeAddr("fork-buyer");

    function _usdg(address to, uint256 amount) internal {
        vm.store(USDG, keccak256(abi.encode(to, uint256(1))), bytes32(amount));
        assertEq(IUsdgFork(USDG).balanceOf(to), amount, "USDG balance slot");
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        market = new TemplateMarketUsdg(USDG, TREASURY, 2000, 1e6, 1000e6);
        _usdg(bob, 50e6);
        vm.prank(bob);
        IUsdgFork(USDG).approve(address(market), type(uint256).max);
    }

    function test_fork_facts() public view {
        if (block.chainid != 4663) return;
        assertEq(keccak256(bytes(IUsdgFork(USDG).symbol())), keccak256("USDG"));
        assertEq(IUsdgFork(USDG).decimals(), 6);
        assertEq(ITreasuryLive(TREASURY).usdg(), USDG);
        assertEq(ITreasuryLive(TREASURY).owner(), OWNER);
        assertEq(ITreasuryLive(TREASURY).OWNER_BPS(), 3000);
        assertEq(ITreasuryLive(TREASURY).orry(), address(0), "treasury still coinless");
        assertEq(market.usdg(), USDG);
        assertEq(market.treasury(), TREASURY);
    }

    function test_fork_sale_pays_creator_and_treasury() public {
        if (block.chainid != 4663) return;
        ITreasuryLive t = ITreasuryLive(TREASURY);
        t.sync(); // book whatever arrived before, so the deltas below are this sale only
        uint256 owner0 = t.ownerAccrued();
        uint256 reserve0 = t.buybackReserve();
        uint256 tBal0 = IUsdgFork(USDG).balanceOf(TREASURY);

        vm.prank(alice);
        uint256 id = market.list(10e6, keccak256("caps 50 USDG/day"), "https://example.org/policy.json");
        vm.prank(bob);
        assertEq(market.buy(id, 10e6), 10e6);

        assertEq(IUsdgFork(USDG).balanceOf(alice), 8e6, "creator 80%");
        assertEq(IUsdgFork(USDG).balanceOf(TREASURY) - tBal0, 2e6, "treasury 20%");
        assertEq(IUsdgFork(USDG).balanceOf(bob), 40e6);
        assertEq(IUsdgFork(USDG).balanceOf(address(market)), 0);
        assertTrue(market.licensed(id, bob));

        t.sync();
        assertEq(t.ownerAccrued() - owner0, 600_000, "30% of the fee to the owner");
        assertEq(t.buybackReserve() - reserve0, 1_400_000, "70% of the fee to the reserve");

        vm.prank(bob);
        vm.expectRevert(TemplateMarketUsdg.AlreadyLicensed.selector);
        market.buy(id, 10e6);
    }
}
