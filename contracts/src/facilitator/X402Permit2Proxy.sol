// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

/// @notice x402 `exact` payments in a token without EIP-3009 (ORRY, utility 11): the payer signs a Permit2
/// `PermitWitnessTransferFrom` naming this contract as spender and the payee in the witness. Anyone (the facilitator's
/// relayer) submits it; this contract moves exactly the signed amount to exactly the signed payee, so the submitter can
/// neither redirect nor resize the payment. The payer approves Permit2 for the token once.
contract X402Permit2Proxy {
    ISignatureTransfer public immutable permit2;

    /// @dev EIP-712 witness: the payee. Type strings per Permit2's witness rules (definitions sorted by name).
    bytes32 public constant WITNESS_TYPEHASH = keccak256("X402Payment(address to)");
    string public constant WITNESS_TYPE_STRING =
        "X402Payment witness)TokenPermissions(address token,uint256 amount)X402Payment(address to)";

    event Paid(address indexed token, address indexed from, address indexed to, uint256 amount, uint256 nonce);

    error ZeroAddress();

    constructor(address permit2_) {
        if (permit2_ == address(0)) revert ZeroAddress();
        permit2 = ISignatureTransfer(permit2_);
    }

    /// @notice Pays `permit.permitted.amount` of `permit.permitted.token` from `from` to `to`, as `from` signed.
    function settle(ISignatureTransfer.PermitTransferFrom calldata permit, address from, address to, bytes calldata signature)
        external
    {
        if (to == address(0)) revert ZeroAddress();
        permit2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: to, requestedAmount: permit.permitted.amount}),
            from,
            keccak256(abi.encode(WITNESS_TYPEHASH, to)),
            WITNESS_TYPE_STRING,
            signature
        );
        emit Paid(permit.permitted.token, from, to, permit.permitted.amount, permit.nonce);
    }
}
