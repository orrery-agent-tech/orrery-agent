// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC7579Module} from "../../src/interfaces/IExternal.sol";

/// @notice ERC-8004 IdentityRegistry stand-in: ERC-721 ownership plus the reserved `agentWallet`, cleared on transfer.
contract MockIdentityRegistry {
    mapping(uint256 => address) public ownerOfMap;
    mapping(uint256 => address) internal _wallet;
    uint256 public nextId = 1;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function register(address to) external returns (uint256 id) {
        id = nextId++;
        ownerOfMap[id] = to;
        _wallet[id] = to;
        emit Transfer(address(0), to, id);
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = ownerOfMap[id];
        require(o != address(0), "ERC721NonexistentToken");
    }

    /// @dev The real registry requires an EIP-712 or ERC-1271 proof from `wallet`; tests act as the owner directly.
    function setAgentWallet(uint256 id, address wallet) external {
        require(msg.sender == ownerOfMap[id], "not owner");
        _wallet[id] = wallet;
    }

    function getAgentWallet(uint256 id) external view returns (address) {
        return _wallet[id];
    }

    mapping(uint256 => string) internal _uri;

    function setTokenURI(uint256 id, string calldata uri) external {
        require(msg.sender == ownerOfMap[id], "not owner");
        _uri[id] = uri;
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        return _uri[id];
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOfMap[id] == from && msg.sender == from, "not owner");
        ownerOfMap[id] = to;
        _wallet[id] = address(0);
        emit Transfer(from, to, id);
    }
}

/// @notice Plain ERC-20 with mint, 6 decimals by default.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external virtual returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external virtual returns (bool) {
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _move(f, to, a);
        return true;
    }

    function _move(address f, address to, uint256 a) internal virtual {
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a;
        balanceOf[to] += a;
    }
}

/// @notice Takes 1% on every transfer.
contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Fee", "FEE", 18) {}

    function _move(address f, address to, uint256 a) internal override {
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a;
        uint256 cut = a / 100;
        balanceOf[to] += a - cut;
        totalSupply -= cut;
    }
}

/// @notice Returns false instead of reverting and moves nothing.
contract FalseReturnToken is MockERC20 {
    constructor() MockERC20("False", "FALSE", 18) {}

    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @notice Minimal ERC-7579 account: one owner, executors allowed to call `executeFromExecutor` with the single
///         call mode. Install and uninstall can be told to skip the module callback, to model adapters that do so.
contract MockAccount7579 {
    address public owner;
    mapping(uint256 => mapping(address => bool)) public installed;
    bool public skipUninstallCallback;

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {}

    modifier onlyOwner() {
        require(msg.sender == owner || msg.sender == address(this), "not owner");
        _;
    }

    function setSkipUninstallCallback(bool v) external onlyOwner {
        skipUninstallCallback = v;
    }

    function installModule(uint256 typeId, address module, bytes calldata data) external onlyOwner {
        installed[typeId][module] = true;
        IERC7579Module(module).onInstall(data);
    }

    function uninstallModule(uint256 typeId, address module, bytes calldata data) external onlyOwner {
        installed[typeId][module] = false;
        if (!skipUninstallCallback) IERC7579Module(module).onUninstall(data);
    }

    function isModuleInstalled(uint256 typeId, address module, bytes calldata) external view returns (bool) {
        return installed[typeId][module];
    }

    /// @notice The operator acts through its account: `msg.sender` seen by the module is this account.
    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        virtual
        returns (bytes[] memory returnData)
    {
        require(installed[2][msg.sender], "not executor");
        require(mode == bytes32(0), "mode");
        address target = address(bytes20(executionCalldata[0:20]));
        uint256 value = uint256(bytes32(executionCalldata[20:52]));
        bytes calldata data = executionCalldata[52:];
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        returnData = new bytes[](1);
        returnData[0] = ret;
    }
}

/// @notice An allowlisted target used in tests: pulls a token from the caller through an old approval, or moves
///         tokens in and out, or tries to call back into the module.
contract MockTarget {
    event Called(address from, bytes data);

    function ping(uint256) external payable {
        emit Called(msg.sender, msg.data);
    }

    function pull(address token, uint256 amount) external {
        MockERC20(token).transferFrom(msg.sender, address(this), amount);
    }

    function roundTrip(address token, uint256 amountOut, uint256 amountBack) external {
        MockERC20(token).transferFrom(msg.sender, address(this), amountOut);
        MockERC20(token).transfer(msg.sender, amountBack);
    }

    function reenter(address module, bytes calldata call) external {
        (bool ok, bytes memory ret) = module.call(call);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    receive() external payable {}
}

/// @notice An account implementation that leaks 1 wei to the target on every executor call, to prove the module
///         refuses native outflow when native is not capped (A10).
contract LeakyAccount7579 is MockAccount7579 {
    constructor(address owner_) MockAccount7579(owner_) {}

    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        override
        returns (bytes[] memory returnData)
    {
        require(installed[2][msg.sender], "not executor");
        require(mode == bytes32(0), "mode");
        address target = address(bytes20(executionCalldata[0:20]));
        (bool ok, bytes memory ret) = target.call{value: 1}(executionCalldata[52:]);
        require(ok, "call");
        returnData = new bytes[](1);
        returnData[0] = ret;
    }
}

/// @notice Delivers the full amount but takes an extra 1% from the sender (R-07).
contract SenderTaxToken is MockERC20 {
    constructor() MockERC20("SenderTax", "STX", 18) {}

    function _move(address f, address to, uint256 a) internal override {
        uint256 tax = a / 100;
        require(balanceOf[f] >= a + tax, "balance");
        balanceOf[f] -= a + tax;
        balanceOf[to] += a;
        totalSupply -= tax;
    }
}
