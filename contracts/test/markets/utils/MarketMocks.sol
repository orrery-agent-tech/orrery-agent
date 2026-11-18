// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOrreryHook} from "../../../src/orry/interfaces/IOrreryHook.sol";

/// @notice Issuer registry stand-in for the Robinhood `AccessControlsRegistry`: per-address block list and a global pause.
contract MockAccessRegistry {
    mapping(address => bool) public isBlocked;
    bool public paused;

    function setBlocked(address account, bool blocked) external {
        isBlocked[account] = blocked;
    }

    function setPaused(bool p) external {
        paused = p;
    }
}

/// @notice Robinhood `Stock` stand-in with the same transfer checks as the source on Sourcify (token or registry pause,
/// blocked `to`, `from` and `msg.sender`, applied whatever the amount), the scaled UI multiplier schedule and the oracle
/// pause flag. 18 decimals.
contract MockStock {
    error IsPaused();
    error Blocked(address account);

    string public name = "Tesla Robinhood Token";
    string public symbol = "TSLA";
    uint8 public constant decimals = 18;
    MockAccessRegistry public immutable registry;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public tokenPaused;
    bool public oraclePaused;
    uint256 public effectiveAt;
    uint256 internal _multiplier = 1e18;
    uint256 internal _newMultiplier;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(MockAccessRegistry registry_) {
        registry = registry_;
    }

    modifier notPaused() {
        if (paused()) revert IsPaused();
        _;
    }

    modifier notBlocked(address a) {
        if (registry.isBlocked(a)) revert Blocked(a);
        _;
    }

    function paused() public view returns (bool) {
        return tokenPaused || registry.paused();
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setPaused(bool p) external {
        tokenPaused = p;
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }

    /// @dev As `updateMultiplier(newMultiplier, effectiveAt_)`.
    function scheduleMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external {
        _multiplier = uiMultiplier();
        _newMultiplier = newMultiplier;
        effectiveAt = effectiveAt_;
    }

    function uiMultiplier() public view returns (uint256) {
        if (block.timestamp >= effectiveAt && _newMultiplier != 0) return _newMultiplier;
        return _multiplier;
    }

    function approve(address spender, uint256 value)
        external
        notPaused
        notBlocked(spender)
        notBlocked(msg.sender)
        returns (bool)
    {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external notPaused notBlocked(to) notBlocked(msg.sender) returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value)
        external
        notPaused
        notBlocked(from)
        notBlocked(to)
        notBlocked(msg.sender)
        returns (bool)
    {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @notice USDG stand-in with the Paxos checks read on Sourcify: pause on transfers, frozen `from` or `to` reverts before
/// the zero-value early exit, frozen `msg.sender` on `transferFrom`. 6 decimals.
contract MockUsdg {
    error AddressFrozen();
    error ContractPaused();

    string public constant name = "Global Dollar";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen;
    bool public paused;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFrozen(address account, bool f) external {
        frozen[account] = f;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (paused) revert ContractPaused();
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (paused) revert ContractPaused();
        if (frozen[msg.sender]) revert AddressFrozen();
        require(value <= allowance[from][msg.sender], "allowance");
        _transfer(from, to, value);
        allowance[from][msg.sender] -= value;
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "zero");
        if (frozen[to] || frozen[from]) revert AddressFrozen();
        if (value == 0) {
            emit Transfer(from, to, 0);
            return;
        }
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @notice Takes 1% of every transfer, for the balance-delta checks.
contract FeeOnTransferToken {
    string public constant symbol = "FEE";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        balanceOf[from] -= value;
        balanceOf[to] += value - value / 100;
    }
}

/// @notice Chainlink aggregator proxy stand-in: round ids are (phase << 64) | n, starting in phase 1, so `id + 1` is the
/// next round of the same phase; `newPhase` starts the next phase as an aggregator change does. `getRoundData` reverts
/// for a round that does not exist, as the real proxy does.
contract MockFeed {
    uint80 public constant FIRST = uint80(1 << 64);
    uint8 public immutable decimals;

    struct Round {
        int256 answer;
        uint256 updatedAt;
        bool exists;
    }

    uint80 internal _next = FIRST;
    uint80[] internal _ids;
    mapping(uint80 => Round) internal _byId;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function push(int256 answer, uint256 updatedAt) external returns (uint80 id) {
        id = _next;
        _next += 1;
        _ids.push(id);
        _byId[id] = Round(answer, updatedAt, true);
    }

    function newPhase() external {
        _next = (((_next >> 64) + 1) << 64) | 1;
    }

    function latestRoundId() public view returns (uint80) {
        return _ids[_ids.length - 1];
    }

    function roundCount() external view returns (uint256) {
        return _ids.length;
    }

    function roundIdAt(uint256 i) external view returns (uint80) {
        return _ids[i];
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(_ids.length != 0, "no data");
        uint80 id = latestRoundId();
        Round storage r = _byId[id];
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round storage r = _byId[roundId];
        require(r.exists, "No data present");
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}

/// @notice `OrryStaking.earningBalance` stand-in for the fee tiers; it can be made to revert.
contract MockEarningStaking {
    mapping(address => uint256) internal _balance;
    bool public reverts;

    function set(address account, uint256 amount) external {
        _balance[account] = amount;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function earningBalance(address account) external view returns (uint256) {
        require(!reverts, "staking down");
        return _balance[account];
    }
}

/// @notice The multi-pair `IOrreryHook` views the price oracle reads (frozen at orry/spec d01fb2c): `pairOf(quote)` and
/// `consult(quote, window)`, with a settable mean tick, orientation and history per hub; `consult` follows the spec's revert
/// rules. `set(tick, since)` sets the ETH hub (ORRY is currency1 there). Lane A's real hook is exercised in
/// `OrryPriceOracleHook.t.sol`.
contract OracleHookStandIn {
    struct Hub {
        bool registered;
        bool initialized;
        bool orryIs0;
        int24 tick; // the pool's own mean tick (currency1 per currency0)
        uint256 since; // timestamp of the oldest checkpoint; 0 = no history
    }

    uint32 public constant MAX_WINDOW = 3780;
    mapping(address quote => Hub) public hubs;

    function set(int24 tick, uint256 since) external {
        hubs[address(0)] = Hub(true, true, false, tick, since);
    }

    function setHub(address quote, bool initialized, bool orryIs0, int24 tick, uint256 since) external {
        hubs[quote] = Hub(true, initialized, orryIs0, tick, since);
    }

    function pairOf(address quote) external view returns (IOrreryHook.Pair memory p) {
        Hub storage h = hubs[quote];
        if (!h.registered) revert IOrreryHook.UnknownPair();
        p.quote = quote;
        p.orryIsCurrency0 = h.orryIs0;
        p.initialized = h.initialized;
        p.registeredAt = 1;
    }

    function consult(address quote, uint32 window) external view returns (int24, uint32) {
        Hub storage h = hubs[quote];
        if (!h.registered) revert IOrreryHook.UnknownPair();
        if (window == 0 || window > MAX_WINDOW) revert IOrreryHook.OracleWindowTooLong();
        if (h.since == 0 || h.since > block.timestamp - window) revert IOrreryHook.OracleNotReady();
        return (h.tick, window);
    }
}
