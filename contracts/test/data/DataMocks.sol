// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Pons-shaped ORRY: plain ERC-20 with `burn` and `burnFrom`, no owner after construction.
contract DataOrry is ERC20 {
    constructor() ERC20("Orrery", "ORRY") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function burn(uint256 a) external {
        _burn(msg.sender, a);
    }

    function burnFrom(address from, uint256 a) external {
        _spendAllowance(from, msg.sender, a);
        _burn(from, a);
    }
}

/// @notice A token whose `burn` destroys less than asked: the splitter must refuse it (`InexactBurn`).
contract ShortBurnOrry is ERC20 {
    constructor() ERC20("Short", "SHORT") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function burn(uint256 a) external {
        _burn(msg.sender, a > 1 ? a - 1 : a);
    }
}

/// @notice `OrreryTreasury.owner()` stand-in; the owner can be moved, as a real ownership transfer would.
contract DataTreasury {
    address public owner;

    constructor(address o) {
        owner = o;
    }

    function setOwner(address o) external {
        owner = o;
    }
}

/// @notice Lane L1's Reward Pool funding semantics (IRewardPool at d76cb86): `fund` pulls exactly `amount` with
/// `transferFrom`, checks the balance delta and books it; `sync` books a plain transfer in.
contract DataRewardPool {
    address public immutable orry;
    mapping(address => uint256) public freeBalance;
    uint256 public fundCalls;

    error ZeroAmount();
    error InexactTransfer();
    error EthAmountMismatch();

    event Funded(address indexed asset, address indexed from, uint256 amount);

    constructor(address orry_) {
        orry = orry_;
    }

    function fund(address asset, uint256 amount) external payable {
        if (amount == 0) revert ZeroAmount();
        if (msg.value != 0) revert EthAmountMismatch();
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        if (IERC20(asset).balanceOf(address(this)) != before + amount) revert InexactTransfer();
        freeBalance[asset] += amount;
        ++fundCalls;
        emit Funded(asset, msg.sender, amount);
    }

    function sync(address asset) external returns (uint256 booked) {
        booked = IERC20(asset).balanceOf(address(this)) - freeBalance[asset];
        freeBalance[asset] += booked;
    }
}

/// @notice A pool that refuses funding while `refuse` is on (a paused or broken pool).
contract RefusingPool {
    address public immutable orry;
    bool public refuse = true;

    constructor(address orry_) {
        orry = orry_;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    function fund(address asset, uint256 amount) external payable {
        require(!refuse, "refused");
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
    }
}

/// @notice A pool that pulls less than it is given.
contract ShortPool {
    address public immutable orry;

    constructor(address orry_) {
        orry = orry_;
    }

    function fund(address asset, uint256 amount) external payable {
        IERC20(asset).transferFrom(msg.sender, address(this), amount - 1);
    }
}

/// @notice A pool that reenters the splitter during `fund`.
contract ReenteringPool {
    address public immutable orry;
    address public splitter;
    bool public reentered;

    constructor(address orry_) {
        orry = orry_;
    }

    function setSplitter(address s) external {
        splitter = s;
    }

    function fund(address asset, uint256 amount) external payable {
        (bool ok,) = splitter.call(abi.encodeWithSignature("split()"));
        reentered = ok;
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
    }
}

/// @notice A contract whose `orry()` names another token.
contract OtherTokenPool {
    function orry() external pure returns (address) {
        return address(0xBEEF);
    }
}

/// @notice `FeeTiers.stakeUsd` stand-in: a USD stake value per account (6 decimals); `broken` makes every read revert.
contract DataStakeValue {
    mapping(address => uint256) public usd;
    bool public broken;

    function set(address a, uint256 v) external {
        usd[a] = v;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function stakeUsd(address a) external view returns (uint256) {
        require(!broken, "oracle not ready");
        return usd[a];
    }

    function discountBps(address) external pure returns (uint16) {
        return 0;
    }
}

/// @notice Emits the events the data indexer reads from stock tokens, the issuer registry and the Pons factory (their
/// signatures as verified on 4663, `docs/updates/L2-DATA-MCP-SPEC.md` 0), and answers the stock views. Service tests only.
contract DataEventEmitter {
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);
    event OraclePaused();
    event Blocked(address indexed account);
    event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold);
    event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount);

    uint256 public uiMultiplier = 1e18;
    uint256 public effectiveAt;
    bool public paused;
    bool public oraclePaused;
    uint8 public decimals = 18;

    function setState(uint256 m, uint256 e, bool p, bool op, uint8 d) external {
        uiMultiplier = m;
        effectiveAt = e;
        paused = p;
        oraclePaused = op;
        decimals = d;
    }

    function multiplier(uint256 o, uint256 n, uint256 e) external {
        emit UIMultiplierUpdated(o, n, e);
    }

    function pauseOracle() external {
        emit OraclePaused();
    }

    function blocked(address a) external {
        emit Blocked(a);
    }

    function launch(address token, address curve, address deployer, address pairToken, uint256 cfgId, uint256 threshold) external {
        emit TokenLaunched(token, curve, deployer, pairToken, cfgId, threshold);
    }

    function graduate(address token, uint256 positionId, uint256 tokenAmount, uint256 pairAmount) external {
        emit PoolGraduated(token, positionId, tokenAmount, pairAmount);
    }
}
