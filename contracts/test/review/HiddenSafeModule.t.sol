// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrreryPolicyModule} from "../../src/OrreryPolicyModule.sol";
import {OrreryAttestor} from "../../src/OrreryAttestor.sol";
import {OrreryLens} from "../../src/OrreryLens.sol";
import {IIdentityRegistry, IERC20Min, IERC7579Module} from "../../src/interfaces/IExternal.sol";
import {MockIdentityRegistry, MockERC20} from "../mocks/Mocks.sol";

/// @dev Byte-for-byte logic of Safe 1.4.1 `SafeProxy` (singleton in slot 0, `masterCopy()` shortcut, delegatecall).
contract ReviewSafeProxy {
    address internal singleton;

    constructor(address _singleton) {
        singleton = _singleton;
    }

    fallback() external payable {
        assembly {
            let _singleton := and(sload(0), 0xffffffffffffffffffffffffffffffffffffffff)
            if eq(calldataload(0), 0xa619486e00000000000000000000000000000000000000000000000000000000) {
                mstore(0, _singleton)
                return(0, 0x20)
            }
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), _singleton, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if eq(success, 0) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

/// @dev The parts of Safe 1.4.1 the lens and the module touch, with Safe 1.4.1's storage layout (slot 0 singleton,
///      slot 1 `modules`, slot 2 `owners`, 3 ownerCount, 4 threshold) and its exact module checks:
///      `execTransactionFromModule` and `isModuleEnabled` test `modules[x] != 0`, while `getModulesPaginated` walks the
///      linked list from the sentinel. `execAsOwner` stands for `execTransaction` with threshold 1 and a v=1 signature
///      of msg.sender (what the fork test uses).
contract ReviewMiniSafe {
    address internal singleton; // slot 0
    mapping(address => address) internal modules; // slot 1
    mapping(address => address) internal owners; // slot 2
    uint256 internal ownerCount; // slot 3
    uint256 internal threshold; // slot 4

    address internal constant SENTINEL = address(0x1);
    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    function setup(address owner, address fallbackHandler) external {
        require(threshold == 0, "GS200");
        owners[SENTINEL] = owner;
        owners[owner] = SENTINEL;
        ownerCount = 1;
        threshold = 1;
        modules[SENTINEL] = SENTINEL;
        bytes32 slot = FALLBACK_HANDLER_STORAGE_SLOT;
        assembly {
            sstore(slot, fallbackHandler)
        }
    }

    function execAsOwner(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool ok) {
        require(msg.sender != SENTINEL && owners[msg.sender] != address(0), "GS026");
        ok = _execute(to, value, data, operation);
        require(ok, "GS013");
    }

    function enableModule(address module) external {
        require(msg.sender == address(this), "GS031");
        require(module != address(0) && module != SENTINEL, "GS101");
        require(modules[module] == address(0), "GS102");
        modules[module] = modules[SENTINEL];
        modules[SENTINEL] = module;
    }

    function execTransactionFromModule(address to, uint256 value, bytes memory data, uint8 operation)
        public
        returns (bool success)
    {
        require(msg.sender != SENTINEL && modules[msg.sender] != address(0), "GS104");
        success = _execute(to, value, data, operation);
    }

    function isModuleEnabled(address module) public view returns (bool) {
        return SENTINEL != module && modules[module] != address(0);
    }

    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next)
    {
        require(start == SENTINEL || isModuleEnabled(start), "GS105");
        require(pageSize > 0, "GS106");
        array = new address[](pageSize);
        uint256 moduleCount = 0;
        next = modules[start];
        while (next != address(0) && next != SENTINEL && moduleCount < pageSize) {
            array[moduleCount] = next;
            next = modules[next];
            moduleCount++;
        }
        if (next != SENTINEL) next = array[moduleCount - 1];
        assembly {
            mstore(array, moduleCount)
        }
    }

    function isOwner(address owner) public view returns (bool) {
        return owner != SENTINEL && owners[owner] != address(0);
    }

    function getStorageAt(uint256 offset, uint256 length) public view returns (bytes memory) {
        bytes memory result = new bytes(length * 32);
        for (uint256 index = 0; index < length; index++) {
            assembly {
                let word := sload(add(offset, index))
                mstore(add(add(result, 0x20), mul(index, 0x20)), word)
            }
        }
        return result;
    }

    function _execute(address to, uint256 value, bytes memory data, uint8 operation) internal returns (bool success) {
        if (operation == 1) {
            assembly {
                success := delegatecall(gas(), to, add(data, 0x20), mload(data), 0, 0)
            }
        } else {
            assembly {
                success := call(gas(), to, value, add(data, 0x20), mload(data), 0, 0)
            }
        }
    }

    /// Safe 1.4.1 FallbackManager: forward to the handler with the caller appended.
    fallback() external {
        bytes32 slot = FALLBACK_HANDLER_STORAGE_SLOT;
        assembly {
            let handler := sload(slot)
            if iszero(handler) { return(0, 0) }
            calldatacopy(0, 0, calldatasize())
            mstore(calldatasize(), shl(96, caller()))
            let success := call(gas(), handler, 0, 0, add(calldatasize(), 20), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(success) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    receive() external payable {}
}

/// @dev Safe7579-shaped adapter: fallback handler and Safe module; executor list per Safe (msg.sender), executor =
///      appended caller; executes through `execTransactionFromModule`.
contract ReviewSafe7579 {
    mapping(address => mapping(address => bool)) internal _isExec;
    mapping(address => address[]) internal _execs;

    function _msgSender() internal pure returns (address s) {
        assembly {
            s := shr(96, calldataload(sub(calldatasize(), 20)))
        }
    }

    function installExecutor(address module) external {
        require(_msgSender() == msg.sender, "only self");
        _isExec[msg.sender][module] = true;
        _execs[msg.sender].push(module);
        require(
            ReviewMiniSafe(payable(msg.sender)).execTransactionFromModule(
                module, 0, abi.encodeCall(IERC7579Module.onInstall, (bytes(""))), 0
            ),
            "onInstall"
        );
    }

    function isModuleInstalled(uint256 t, address m, bytes calldata) external view returns (bool) {
        return t == 2 && _isExec[msg.sender][m];
    }

    function executeFromExecutor(bytes32 mode, bytes calldata ec) external returns (bytes[] memory r) {
        require(_isExec[msg.sender][_msgSender()], "not executor");
        require(mode == bytes32(0), "mode");
        address to = address(bytes20(ec[0:20]));
        uint256 value = uint256(bytes32(ec[20:52]));
        require(ReviewMiniSafe(payable(msg.sender)).execTransactionFromModule(to, value, ec[52:], 0), "exec");
        r = new bytes[](1);
    }

    function getExecutorsPaginated(address, uint256) external view returns (address[] memory, address) {
        return (_execs[msg.sender], address(1));
    }

    function getValidatorsPaginated(address, uint256) external pure returns (address[] memory, address) {
        return (new address[](0), address(1));
    }
}

/// @dev What a Safe owner can delegatecall: mark `m` as an enabled module without linking it into the list.
contract HideModule {
    function hide(address m) external {
        bytes32 s = keccak256(abi.encode(m, uint256(1)));
        assembly {
            sstore(s, 1)
        }
    }
}

/// R-01: OrreryLens certifies a Safe as `Safe7579` with `otherAccountModules == false` while a module that is enabled
/// (`modules[x] != 0`, which is all `execTransactionFromModule` checks) sits outside the sentinel list.
contract HiddenSafeModuleReview is Test {
    MockIdentityRegistry registry;
    MockERC20 usdg;
    OrreryAttestor attestor;
    OrreryPolicyModule module;
    OrreryLens lens;
    ReviewMiniSafe singleton;
    ReviewMiniSafe safe;
    ReviewSafe7579 adapter;
    address operator = makeAddr("operator");
    address signer = makeAddr("signer");
    uint256 agentId;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new MockIdentityRegistry();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        adapter = new ReviewSafe7579();
        attestor = new OrreryAttestor(IIdentityRegistry(address(registry)), IERC20Min(address(usdg)), operator, operator, 5e6);
        module = new OrreryPolicyModule(
            IIdentityRegistry(address(registry)), address(attestor), makeAddr("p2"), makeAddr("e7"), makeAddr("e8"), address(adapter)
        );
        singleton = new ReviewMiniSafe();
        safe = ReviewMiniSafe(payable(address(new ReviewSafeProxy(address(singleton)))));
        safe.setup(operator, address(adapter));

        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = address(safe).codehash;
        address[] memory singletons = new address[](1);
        singletons[0] = address(singleton);
        lens = new OrreryLens(module, attestor, address(adapter), hashes, singletons);

        _own(address(safe), 0, abi.encodeCall(ReviewMiniSafe.enableModule, (address(adapter))), 0);
        _own(address(safe), 0, abi.encodeCall(ReviewSafe7579.installExecutor, (address(module))), 0);

        vm.prank(operator);
        agentId = registry.register(operator);
        vm.prank(operator);
        registry.setAgentWallet(agentId, address(safe));
        usdg.mint(address(safe), 1_000e6);

        OrreryPolicyModule.Policy memory p;
        p.caps = new OrreryPolicyModule.TokenCap[](1);
        p.caps[0] = OrreryPolicyModule.TokenCap(address(usdg), 10e6, 50e6, 20e6);
        p.targets = new OrreryPolicyModule.Target[](0);
        p.validUntil = uint64(block.timestamp + 30 days);
        p.increaseDelay = 1 hours;
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(uint256(keccak256(abi.encodePacked("signer"))), module.consentDigest(address(safe), agentId, keccak256(abi.encode(p))));
        _own(address(module), 0, abi.encodeCall(OrreryPolicyModule.openSession, (agentId, signer, p, abi.encodePacked(r, ss, v))), 0);
    }

    function _own(address to, uint256 value, bytes memory data, uint8 op) internal {
        vm.prank(operator);
        safe.execAsOwner(to, value, data, op);
    }

    function test_R01_hidden_safe_module_passes_accountKind() public {
        // the module path works and is capped
        vm.prank(signer);
        module.topUp(address(usdg), 10e6);
        vm.prank(signer);
        vm.expectRevert(OrreryPolicyModule.PerTxExceeded.selector);
        module.topUp(address(usdg), 11e6);

        // operator, once, through a delegatecall from the Safe: enable the signer as a module outside the list
        HideModule h = new HideModule();
        _own(address(h), 0, abi.encodeCall(HideModule.hide, (signer)), 1);
        assertTrue(safe.isModuleEnabled(signer), "the Safe itself says the signer is an enabled module");

        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertEq(uint8(v.accountKind), uint8(OrreryLens.AccountKind.Safe7579));
        assertEq(uint8(v.status), uint8(OrreryLens.EffectiveStatus.Active));
        assertTrue(v.installed && v.bound);
        assertFalse(v.signerIsAccountOwner);

        // the signer drains the account past every cap, without the module
        vm.prank(signer);
        assertTrue(
            safe.execTransactionFromModule(
                address(usdg), 0, abi.encodeCall(IERC20Min.transfer, (signer, 990e6)), 0
            )
        );
        assertEq(usdg.balanceOf(signer), 1_000e6, "signer holds 20x perDay");

        // property the lens must hold (spec 9: any enabled Safe module other than the adapter is reported; B4)
        assertTrue(
            v.otherAccountModules || v.accountKind == OrreryLens.AccountKind.Unknown,
            "lens certified a capped Safe7579 while the signer is an enabled Safe module"
        );
    }

    /// validFor window on a recognised Safe7579 (moved here from the unit lens tests, which use an unknown account).
    function test_validFor_window_on_known_safe() public {
        OrreryLens.CheckView memory v = lens.checkBySigner(signer);
        assertEq(uint8(v.accountKind), uint8(OrreryLens.AccountKind.Safe7579));
        assertFalse(v.otherAccountModules);
        assertEq(v.validFor, block.timestamp + 1 hours, "no pending increase: now + increaseDelay");

        OrreryPolicyModule.Policy memory p = module.getPolicy(address(safe), agentId);
        p.caps[0].perDay = 100e6;
        _own(address(module), 0, abi.encodeCall(OrreryPolicyModule.proposeIncrease, (agentId, p)), 0);
        assertEq(lens.checkBySigner(signer).validFor, block.timestamp + 1 hours, "pending: its readyAt");
        vm.warp(block.timestamp + 2 hours);
        assertEq(lens.checkBySigner(signer).validFor, block.timestamp, "ready increase leaves no window");
    }

    /// R-08: a fallback handler other than the adapter makes the account Unknown.
    function test_fallback_handler_must_be_the_adapter() public {
        vm.store(
            address(safe),
            bytes32(uint256(0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5)),
            bytes32(uint256(uint160(makeAddr("otherHandler"))))
        );
        assertEq(uint8(lens.checkBySigner(signer).accountKind), uint8(OrreryLens.AccountKind.Unknown));
    }

    /// R-06: an enabled Safe-level module is a forbidden target.
    function test_safe_module_is_forbidden_target() public {
        address extra = makeAddr("extraSafeModule");
        _own(address(safe), 0, abi.encodeCall(ReviewMiniSafe.enableModule, (extra)), 0);
        OrreryPolicyModule.Policy memory p = module.getPolicy(address(safe), agentId);
        p.targets = new OrreryPolicyModule.Target[](1);
        p.targets[0] = OrreryPolicyModule.Target(extra, bytes4(0x12345678));
        vm.prank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(OrreryPolicyModule.ForbiddenTarget.selector, extra));
        module.proposeIncrease(agentId, p);
    }
}
