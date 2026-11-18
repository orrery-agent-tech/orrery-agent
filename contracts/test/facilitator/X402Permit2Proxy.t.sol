// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {X402Permit2Proxy} from "../../src/facilitator/X402Permit2Proxy.sol";
import {Permit2Code} from "./Permit2Code.sol";

contract Orry is ERC20("ORRY", "ORRY") {
    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

contract X402Permit2ProxyTest is Test {
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant FULL_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,X402Payment witness)TokenPermissions(address token,uint256 amount)X402Payment(address to)"
    );
    Orry orry = new Orry();
    X402Permit2Proxy proxy;
    uint256 payerKey = 0xA11CE;
    address payer;
    address merchant = makeAddr("merchant splitter");
    address relayer = makeAddr("relayer");

    function setUp() public {
        vm.etch(Permit2Code.PERMIT2, Permit2Code.RUNTIME);
        proxy = new X402Permit2Proxy(Permit2Code.PERMIT2);
        payer = vm.addr(payerKey);
        orry.mint(payer, 1_000e18);
        vm.prank(payer);
        orry.approve(Permit2Code.PERMIT2, type(uint256).max); // once, from the agent's float wallet
    }

    function _permit(uint256 amount, uint256 nonce, uint256 deadline) internal view returns (ISignatureTransfer.PermitTransferFrom memory p) {
        p = ISignatureTransfer.PermitTransferFrom(ISignatureTransfer.TokenPermissions(address(orry), amount), nonce, deadline);
    }

    function _sign(ISignatureTransfer.PermitTransferFrom memory p, address to) internal view returns (bytes memory) {
        bytes32 witness = keccak256(abi.encode(proxy.WITNESS_TYPEHASH(), to));
        bytes32 tp = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount));
        bytes32 structHash = keccak256(abi.encode(FULL_TYPEHASH, tp, address(proxy), p.nonce, p.deadline, witness));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(Permit2Code.PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_pays_exactly_the_signed_amount_to_the_signed_payee() public {
        ISignatureTransfer.PermitTransferFrom memory p = _permit(3e18, 1, block.timestamp + 60);
        bytes memory sig = _sign(p, merchant);
        vm.expectEmit(address(proxy));
        emit X402Permit2Proxy.Paid(address(orry), payer, merchant, 3e18, 1);
        vm.prank(relayer);
        proxy.settle(p, payer, merchant, sig);
        assertEq(orry.balanceOf(merchant), 3e18);
        assertEq(orry.balanceOf(payer), 997e18);
        assertEq(orry.balanceOf(address(proxy)), 0, "the proxy keeps nothing");
    }

    function test_the_same_signature_pays_once() public {
        ISignatureTransfer.PermitTransferFrom memory p = _permit(3e18, 7, block.timestamp + 60);
        bytes memory sig = _sign(p, merchant);
        proxy.settle(p, payer, merchant, sig);
        vm.expectRevert(); // Permit2 InvalidNonce
        proxy.settle(p, payer, merchant, sig);
    }

    function test_the_submitter_cannot_redirect_or_resize() public {
        ISignatureTransfer.PermitTransferFrom memory p = _permit(3e18, 2, block.timestamp + 60);
        bytes memory sig = _sign(p, merchant);
        vm.prank(relayer);
        vm.expectRevert(); // another payee breaks the witness: InvalidSigner
        proxy.settle(p, payer, relayer, sig);
        ISignatureTransfer.PermitTransferFrom memory bigger = _permit(30e18, 2, p.deadline);
        vm.expectRevert(); // another amount breaks the permit: InvalidSigner
        proxy.settle(bigger, payer, merchant, sig);
        assertEq(orry.balanceOf(merchant), 0);
    }

    function test_expired_permit_and_zero_payee_revert() public {
        ISignatureTransfer.PermitTransferFrom memory p = _permit(3e18, 3, block.timestamp - 1);
        bytes memory sig = _sign(p, merchant);
        vm.expectRevert(); // SignatureExpired
        proxy.settle(p, payer, merchant, sig);
        ISignatureTransfer.PermitTransferFrom memory q = _permit(3e18, 4, block.timestamp + 60);
        bytes memory zeroSig = _sign(q, address(0)); // before expectRevert: _sign makes calls of its own
        vm.expectRevert(X402Permit2Proxy.ZeroAddress.selector);
        proxy.settle(q, payer, address(0), zeroSig);
        vm.expectRevert(X402Permit2Proxy.ZeroAddress.selector);
        new X402Permit2Proxy(address(0));
    }
}
