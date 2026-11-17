// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {OrreryLens} from "../../src/OrreryLens.sol";
import {IIdentityRegistry, IERC20Min} from "../../src/interfaces/IExternal.sol";
import {MockTarget} from "../mocks/Mocks.sol";

interface ISafeFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address);
}

interface ISafeFull {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function enableModule(address module) external;
    function domainSeparator() external view returns (bytes32);
}

/// @dev Safe7579 v1.0.0 layout (the version deployed at 0x7579...0002 on 4663, `accountId()` = rhinestone.safe7579.v1.0.0).
struct ModuleInit {
    address module;
    bytes initData;
}

struct RegistryInit {
    address registry;
    address[] attesters;
    uint8 threshold;
}

interface ISafe7579Init {
    function initializeAccount(
        ModuleInit[] calldata validators,
        ModuleInit[] calldata executors,
        ModuleInit[] calldata fallbacks,
        ModuleInit[] calldata hooks,
        RegistryInit calldata registryInit
    ) external;
    function uninstallModule(uint256 moduleType, address module, bytes calldata deInitData) external;
}

interface IIdentityRegistryFull {
    function register(string memory agentURI) external returns (uint256);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice E1 + E5 on a fork of Robinhood Chain 4663 with the real ERC-8004 IdentityRegistry, USDG, Safe 1.4.1 and the
///         Safe7579 v1.0.0 adapter. Run: forge test --match-path test/fork/* --fork-url <4663 rpc>
contract Safe7579ForkTest is Test {
    address constant REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant ADAPTER = 0x7579EE8307284F293B1927136486880611F20002;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant EP07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant EP08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    bytes32 constant SAFE_MSG_TYPEHASH = 0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca;
    bytes32 constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    OrreryPolicyModule module;
    OrreryAttestor attestor;
    OrreryLens lens;
    ISafeFull safe;
    MockTarget target;
    address owner;
    uint256 ownerKey;
    address signer;
    uint256 signerKey;
    uint256 agentId;

    function setUp() public {
        if (block.chainid != 4663) {
            vm.skip(true);
            return;
        }
        (owner, ownerKey) = makeAddrAndKey("operatorOwner");
        (signer, signerKey) = makeAddrAndKey("agentSigner");
        attestor = new OrreryAttestor(IIdentityRegistry(REGISTRY), IERC20Min(USDG), owner, owner, 5e6);
        module = new OrreryPolicyModule(IIdentityRegistry(REGISTRY), address(attestor), PERMIT2, EP07, EP08, ADAPTER);
        target = new MockTarget();

        // Safe 1.4.1 (L2 singleton), owner = test EOA, fallback handler = Safe7579 adapter
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init = abi.encodeCall(
            ISafeFull.setup, (owners, 1, address(0), "", ADAPTER, address(0), 0, payable(address(0)))
        );
        safe = ISafeFull(ISafeFactory(FACTORY).createProxyWithNonce(SAFE_L2, init, uint256(keccak256("orrery-fork"))));

        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = address(safe).codehash;
        address[] memory singletons = new address[](2);
        singletons[0] = SAFE_L2;
        singletons[1] = SAFE;
        lens = new OrreryLens(module, attestor, ADAPTER, hashes, singletons);

        _exec(address(safe), abi.encodeCall(ISafeFull.enableModule, (ADAPTER)));
        ModuleInit[] memory none = new ModuleInit[](0);
        ModuleInit[] memory execs = new ModuleInit[](1);
        execs[0] = ModuleInit(address(module), "");
        _exec(
            address(safe),
            abi.encodeCall(ISafe7579Init.initializeAccount, (none, execs, none, none, RegistryInit(address(0), new address[](0), 0)))
        );

        vm.prank(owner);
        agentId = IIdentityRegistryFull(REGISTRY).register("ipfs://orrery-fork-agent");
        _bind(agentId);
        deal(USDG, address(safe), 1_000e6);
    }

    function _exec(address to, bytes memory data) internal {
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        vm.prank(owner);
        bool ok = safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig);
        require(ok, "safe exec");
    }

    /// ERC-1271 proof from the Safe through the Safe7579 adapter (fallback to Safe checkSignatures).
    function _bind(uint256 id) internal {
        uint256 deadline = block.timestamp + 4 minutes;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                REGISTRY
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", domain, keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, id, address(safe), owner, deadline))
            )
        );
        bytes32 safeMsgHash = keccak256(
            abi.encodePacked(
                bytes1(0x19), bytes1(0x01), safe.domainSeparator(),
                keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(digest))))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, safeMsgHash);
        bytes memory sig = abi.encodePacked(address(0), r, s, v);
        vm.prank(owner);
        IIdentityRegistryFull(REGISTRY).setAgentWallet(id, address(safe), deadline, sig);
    }

    function _openCall(address s, uint256 k, OrreryPolicyModule.Policy memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(k, module.consentDigest(address(safe), agentId, keccak256(abi.encode(p))));
        return abi.encodeCall(OrreryPolicyModule.openSession, (agentId, s, p, abi.encodePacked(r, ss, v)));
    }

    function _policy() internal view returns (OrreryPolicyModule.Policy memory p) {
        p.caps = new OrreryPolicyModule.TokenCap[](1);
        p.caps[0] = OrreryPolicyModule.TokenCap(USDG, 10e6, 50e6, 20e6);
        p.targets = new OrreryPolicyModule.Target[](1);
        p.targets[0] = OrreryPolicyModule.Target(address(target), MockTarget.pull.selector);
        p.validUntil = uint64(block.timestamp + 30 days);
        p.increaseDelay = 1 hours;
    }

    function test_fork_identity_binding_via_erc1271() public view {
        assertEq(IIdentityRegistryFull(REGISTRY).getAgentWallet(agentId), address(safe));
        assertTrue(module.isInstalledOn(address(safe)));
        assertEq(module.epoch(address(safe)), 1, "onInstall called by Safe7579 initializeAccount");
    }

    function test_fork_end_to_end() public {
        _exec(address(module), _openCall(signer, signerKey, _policy()));
        _exec(USDG, abi.encodeWithSignature("approve(address,uint256)", address(target), type(uint256).max));

        uint256 g = gasleft();
        vm.prank(signer);
        module.topUp(USDG, 10e6);
        console2.log("topUp gas on fork", g - gasleft());
        console2.log("fork block", block.number);
        assertEq(IERC20Min(USDG).balanceOf(signer), 10e6);

        vm.prank(signer);
        module.execute(address(target), abi.encodeCall(MockTarget.pull, (USDG, 7e6)));
        assertEq(module.spentToday(address(safe), agentId, USDG), 17e6);

        vm.prank(signer);
        module.topUp(USDG, 10e6);
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.FloatExceeded.selector);
        module.topUp(USDG, 1);

        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertEq(uint8(v.accountKind), uint8(OrreryLens.AccountKind.Safe7579), "real Safe7579 recognised");
        assertTrue(v.installed);
        assertTrue(v.bound);
        assertFalse(v.signerIsAccountOwner);
        assertFalse(v.otherAccountModules);
        assertEq(uint8(v.status), uint8(OrreryLens.EffectiveStatus.Active));

        // increase across the delay
        OrreryPolicyModule.Policy memory p = _policy();
        p.caps[0].perDay = 100e6;
        _exec(address(module), abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, p)));
        vm.warp(block.timestamp + 1 hours);
        _exec(address(module), abi.encodeCall(OrreryPolicyModule.applyIncrease, (agentId)));
        assertEq(module.getPolicy(address(safe), agentId).caps[0].perDay, 100e6);

        // identity transfer clears the binding in the real registry
        vm.recordLogs();
        vm.prank(owner);
        IIdentityRegistryFull(REGISTRY).transferFrom(owner, makeAddr("buyer"), agentId);
        assertEq(IIdentityRegistryFull(REGISTRY).getAgentWallet(agentId), address(0));
        assertGt(vm.getRecordedLogs().length, 1, "MetadataSet plus Transfer");
        assertFalse(lens.checkBySigner(signer).bound);

        // uninstall through Safe7579 revokes every session
        _exec(address(safe), abi.encodeCall(ISafe7579Init.uninstallModule, (2, address(module), abi.encode(address(1), bytes("")))));
        assertFalse(module.isInstalledOn(address(safe)));
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.NotInstalled.selector);
        module.topUp(USDG, 1e6);
        assertEq(uint8(module.effectiveStatus(address(safe), agentId)), uint8(OrreryPolicyModule.Status.Revoked));
    }

    function test_fork_adapter_and_permit2_are_forbidden_targets() public {
        OrreryPolicyModule.Policy memory p = _policy();
        p.targets[0] = OrreryPolicyModule.Target(ADAPTER, bytes4(0x12345678));
        _execExpectRevert(address(module), _openCall(signer, signerKey, p));
        p.targets[0] = OrreryPolicyModule.Target(PERMIT2, bytes4(0x12345678));
        _execExpectRevert(address(module), _openCall(signer, signerKey, p));
    }

    function _execExpectRevert(address to, bytes memory data) internal {
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        vm.prank(owner);
        vm.expectRevert(bytes("GS013"));
        safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function test_fork_signer_owner_flag() public {
        // the Safe owner EOA as signer is allowed by the module (it is an EOA); the lens flags it.
        _exec(address(module), _openCall(owner, ownerKey, _policy()));
        assertTrue(lens.checkBySigner(owner).signerIsAccountOwner);
    }
}
