// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DevUSDG} from "../../src/dev/DevUSDG.sol";

contract DevUSDGTest is Test {
    DevUSDG t;
    address payer;
    uint256 pk;
    address to = makeAddr("to");

    function setUp() public {
        vm.warp(1_800_000_000);
        t = new DevUSDG(address(this));
        (payer, pk) = makeAddrAndKey("payer");
        t.mint(payer, 100e6);
    }

    function _sig(uint256 value, uint256 validBefore, bytes32 nonce) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 sh = keccak256(abi.encode(t.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, to, value, 0, validBefore, nonce));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), sh)));
    }

    function test_transfer_with_authorization_and_silent_replay() public {
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _sig(5e6, block.timestamp + 60, nonce);
        t.transferWithAuthorization(payer, to, 5e6, 0, block.timestamp + 60, nonce, v, r, s);
        assertEq(t.balanceOf(to), 5e6);
        assertTrue(t.authorizationState(payer, nonce));
        // replay: succeeds, moves nothing
        t.transferWithAuthorization(payer, to, 5e6, 0, block.timestamp + 60, nonce, abi.encodePacked(r, s, v));
        assertEq(t.balanceOf(to), 5e6);
    }

    function test_bad_signature_and_expiry() public {
        bytes32 nonce = keccak256("n2");
        (uint8 v, bytes32 r, bytes32 s) = _sig(5e6, block.timestamp + 60, nonce);
        vm.expectRevert(DevUSDG.InvalidSignature.selector);
        t.transferWithAuthorization(payer, to, 6e6, 0, block.timestamp + 60, nonce, v, r, s);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(DevUSDG.AuthorizationExpired.selector);
        t.transferWithAuthorization(payer, to, 5e6, 0, block.timestamp - 1, nonce, v, r, s);
    }
}
