// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {RewardPool} from "../../../src/community/RewardPool.sol";
import {OrryAchievements} from "../../../src/community/OrryAchievements.sol";
import {VerifiedAgentVerifier} from "../../../src/community/verifiers/VerifiedAgentVerifier.sol";

interface IUsdg {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function symbol() external view returns (string memory);
}

interface IIdentity8004 {
    function register(string calldata agentURI) external returns (uint256);
    function ownerOf(uint256) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
}

interface IAttestorLive {
    function fee() external view returns (uint128);
    function isVerified(uint256) external view returns (bool);
    function payVerification(uint256 agentId, address expectedOwner, uint128 maxFee) external;
    function identityRegistry() external view returns (address);
}

/// @notice AU-I6 on a fork of Robinhood Chain 4663 (docs/updates/ACHIEVEMENTS-USDG-SPEC.md): the board as
/// deploy-achievements-4663.ts builds it, against the live USDG, ERC-8004 identity registry and OrreryAttestor.
/// Run: forge test --match-path 'test/community/fork/AchievementsUsdgFork.t.sol' --fork-url <4663 RPC>
contract AchievementsUsdgForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant ATTESTOR = 0x6f192242029d779d676246C773AdbA47F7c3a0d7;
    address constant ORRY_CA = 0x2c30E8E77B752Bf9f945A9BF99427EE0b60C50be;

    RewardPool pool;
    OrryAchievements board;
    VerifiedAgentVerifier verifier;
    address admin = makeAddr("fork-admin");
    address alice = makeAddr("fork-alice");
    address bob = makeAddr("fork-bob");
    uint256 id;

    function _usdg(address to, uint256 amount) internal {
        vm.store(USDG, keccak256(abi.encode(to, uint256(1))), bytes32(amount));
        assertEq(IUsdg(USDG).balanceOf(to), amount, "USDG balance slot");
    }

    function _verify(address owner, uint256 agentId) internal {
        uint128 fee = IAttestorLive(ATTESTOR).fee();
        vm.startPrank(owner);
        IUsdg(USDG).approve(ATTESTOR, fee);
        IAttestorLive(ATTESTOR).payVerification(agentId, owner, fee);
        vm.stopPrank();
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        assertGt(ORRY_CA.code.length, 0, "ORRY token has code on 4663");
        assertEq(IAttestorLive(ATTESTOR).identityRegistry(), IDENTITY);
        address boardAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pool = new RewardPool(ORRY_CA, boardAt, admin, 10_000, 48 hours);
        board = new OrryAchievements(address(pool));
        verifier = new VerifiedAgentVerifier(IDENTITY, ATTESTOR);
        _usdg(admin, 200e6);
        vm.startPrank(admin);
        IUsdg(USDG).approve(address(pool), 200e6);
        pool.fund(USDG, 200e6);
        id = board.create(USDG, 2e6, 100, uint64(block.timestamp + 90 days), 11, address(verifier), keccak256("rules"));
        vm.stopPrank();
        _usdg(alice, 20e6);
        _usdg(bob, 20e6);
    }

    function test_fork_facts() public view {
        if (block.chainid != 4663) return;
        assertEq(IAttestorLive(ATTESTOR).fee(), 5e6, "verification fee 5 USDG");
        assertEq(keccak256(bytes(IUsdg(USDG).symbol())), keccak256("USDG"));
        assertEq(pool.lockedBalance(USDG), 200e6);
        assertEq(pool.freeBalance(USDG), 0);
        assertEq(IUsdg(USDG).balanceOf(address(pool)), 200e6);
    }

    function test_fork_verify_claim_once_per_agent() public {
        if (block.chainid != 4663) return;
        vm.prank(alice);
        uint256 agent = IIdentity8004(IDENTITY).register("https://example.org/a.json");
        assertEq(IIdentity8004(IDENTITY).ownerOf(agent), alice);

        // registered but not verified
        vm.prank(alice);
        vm.expectRevert(OrryAchievements.ConditionNotMet.selector);
        board.claim(id, abi.encode(agent));

        _verify(alice, agent);
        assertTrue(IAttestorLive(ATTESTOR).isVerified(agent));
        uint256 before = IUsdg(USDG).balanceOf(alice);
        vm.prank(alice);
        assertEq(board.claim(id, abi.encode(agent)), 2e6);
        assertEq(IUsdg(USDG).balanceOf(alice) - before, 2e6);

        // the agent moves: no longer verified for its new owner
        vm.prank(alice);
        IIdentity8004(IDENTITY).transferFrom(alice, bob, agent);
        assertFalse(IAttestorLive(ATTESTOR).isVerified(agent));
        vm.prank(bob);
        vm.expectRevert(OrryAchievements.ConditionNotMet.selector);
        board.claim(id, abi.encode(agent));

        // verified again by the new owner: still one payout per agent
        _verify(bob, agent);
        assertTrue(IAttestorLive(ATTESTOR).isVerified(agent));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrryAchievements.SubjectAlreadyClaimed.selector, alice));
        board.claim(id, abi.encode(agent));

        // bob's own agent pays
        vm.prank(bob);
        uint256 agentB = IIdentity8004(IDENTITY).register("https://example.org/b.json");
        _verify(bob, agentB);
        vm.prank(bob);
        board.claim(id, abi.encode(agentB));
        assertEq(board.achievementOf(id).paid, 2);
        assertEq(IUsdg(USDG).balanceOf(address(pool)), 196e6);
        assertEq(pool.lockedBalance(USDG), 196e6);
    }
}
