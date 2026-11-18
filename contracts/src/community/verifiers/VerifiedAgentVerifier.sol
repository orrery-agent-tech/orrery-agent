// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAchievementVerifier} from "../interfaces/IAchievementVerifier.sol";
import {IIdentityRegistry} from "../../interfaces/IExternal.sol";

interface IAttestorVerified {
    function isVerified(uint256 agentId) external view returns (bool);
}

/// @notice Condition "owns an ERC-8004 agent that `OrreryAttestor` reports verified" (R-41). `data` is
/// `abi.encode(uint256 agentId)`; the account must be `ownerOf(agentId)` now. No owner, no setter.
contract VerifiedAgentVerifier is IAchievementVerifier {
    address public immutable identityRegistry;
    address public immutable attestor;

    constructor(address identityRegistry_, address attestor_) {
        require(identityRegistry_ != address(0) && attestor_ != address(0), "zero address");
        identityRegistry = identityRegistry_;
        attestor = attestor_;
    }

    function isComplete(address account, bytes calldata data) external view returns (bool) {
        if (data.length != 32) return false;
        uint256 agentId = abi.decode(data, (uint256));
        (bool ok, bytes memory ret) =
            identityRegistry.staticcall(abi.encodeCall(IIdentityRegistry.ownerOf, (agentId)));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != account) return false;
        return IAttestorVerified(attestor).isVerified(agentId);
    }
}
