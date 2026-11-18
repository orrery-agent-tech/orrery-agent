// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IRewardPool} from "./interfaces/IRewardPool.sol";

interface IERC20Pool {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title RewardPool
/// @notice The Community Reward Pool (`docs/updates/L1-COMMUNITY-SPEC.md`, R-31, R-33, R-42, R-50). Books per asset
/// (address(0) = native ETH): `freeBalance + lockedBalance` is what the pool has booked of it. Chat fees, tip cuts, name
/// fees, 30% of official data revenue and the treasury wallet's deposits come in through `fund` or `sync`.
/// Events (bug bounties, "most active in 7 days", weekly quests): the admin (the treasury wallet) locks at most
/// `MAX_LOCK_BPS` of an asset's free balance for an event, publishes its winners before the deadline, may replace the
/// list once during the public check window (which restarts it), and after the window each prize can be paid to its
/// winner. An event with no winners by its deadline returns its amount to the free balance (`expire`, anyone).
/// Achievements: `OrryAchievements` (fixed at deployment) locks, pays and releases through this pool under the same cap.
/// Nothing else moves pool assets. No pause, no withdrawal, no setter beyond the two-step admin transfer.
contract RewardPool is IRewardPool {
    enum Status {
        None,
        Open,
        Published,
        Expired
    }

    struct PoolEvent {
        address asset;
        uint8 kind;
        Status status;
        bool replaced;
        uint64 deadline;
        uint64 payableAt; // 0 until winners are published
        uint128 amount; // locked: at creation the full amount, after publication the published sum
        uint128 paid;
        bytes32 rulesHash;
    }

    event EventCreated(
        uint256 indexed id, address indexed asset, uint8 indexed kind, uint256 amount, uint64 deadline, bytes32 rulesHash
    );
    event WinnersPublished(
        uint256 indexed id, address[] winners, uint256[] amounts, uint256 returned, uint64 payableAt, bool replacement
    );
    event PrizePaid(uint256 indexed id, address indexed winner, address to, address indexed asset, uint256 amount);
    event EventExpired(uint256 indexed id, uint256 returned);
    event AchievementLocked(address indexed asset, uint256 amount);
    event AchievementReleased(address indexed asset, uint256 amount);
    event AchievementPaid(address indexed asset, address indexed to, uint256 amount);
    event AdminTransferStarted(address indexed admin, address indexed pending);
    event AdminTransferred(address indexed previous, address indexed admin);

    error NotAdmin();
    error NotAchievements();
    error BadDeadline();
    error AboveLockCap(uint256 amount, uint256 cap);
    error BadStatus();
    error PastDeadline();
    error DeadlineNotReached();
    error BadWinners();
    error AboveLocked();
    error AlreadyReplaced();
    error WindowClosed();
    error NotPayableYet(uint64 payableAt);
    error NothingToClaim();
    error EthTransferFailed();
    error ZeroAddress();
    error Reentrancy();

    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_WINNERS = 100;
    uint64 public constant MAX_DURATION = 365 days;

    address public immutable override orry;
    address public immutable achievements;
    uint16 public immutable MAX_LOCK_BPS;
    uint64 public immutable CHECK_WINDOW;

    address public admin;
    address public pendingAdmin;
    uint256 public eventCount;

    mapping(address asset => uint256) private _free;
    mapping(address asset => uint256) private _locked;
    mapping(address asset => uint256) public achievementLocked;
    mapping(uint256 id => PoolEvent) private _events;
    mapping(uint256 id => address[]) private _winners;
    mapping(uint256 id => mapping(address winner => uint256)) public prizeOf;
    mapping(uint256 id => mapping(address winner => bool)) public claimed;

    bool private _entered;

    constructor(address orry_, address achievements_, address admin_, uint16 maxLockBps, uint64 checkWindow) {
        if (orry_ == address(0) || achievements_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        require(maxLockBps != 0 && maxLockBps <= BPS, "lock bps");
        require(checkWindow != 0 && checkWindow <= 30 days, "check window");
        orry = orry_;
        achievements = achievements_;
        admin = admin_;
        MAX_LOCK_BPS = maxLockBps;
        CHECK_WINDOW = checkWindow;
        emit AdminTransferred(address(0), admin_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAchievements() {
        if (msg.sender != achievements) revert NotAchievements();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    // ------------------------------------------------------------------ funding

    function fund(address asset, uint256 amount) external payable override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (asset == address(0)) {
            if (msg.value != amount) revert EthAmountMismatch();
        } else {
            if (msg.value != 0) revert EthAmountMismatch();
            uint256 before = IERC20Pool(asset).balanceOf(address(this));
            _safeTransferFrom(asset, msg.sender, amount);
            if (IERC20Pool(asset).balanceOf(address(this)) - before != amount) revert InexactTransfer();
        }
        _free[asset] += amount;
        emit Funded(asset, msg.sender, amount);
    }

    function sync(address asset) external override nonReentrant returns (uint256 booked) {
        uint256 held = asset == address(0) ? address(this).balance : IERC20Pool(asset).balanceOf(address(this));
        uint256 books = _free[asset] + _locked[asset];
        if (held <= books) return 0;
        booked = held - books;
        _free[asset] += booked;
        emit Funded(asset, msg.sender, booked);
    }

    function freeBalance(address asset) external view override returns (uint256) {
        return _free[asset];
    }

    function lockedBalance(address asset) external view override returns (uint256) {
        return _locked[asset];
    }

    /// @notice The most one event or achievement may lock of `asset` now.
    function lockCap(address asset) public view returns (uint256) {
        return _free[asset] * MAX_LOCK_BPS / BPS;
    }

    // ------------------------------------------------------------------ events (R-33)

    function createEvent(address asset, uint256 amount, uint64 deadline, uint8 kind, bytes32 rulesHash)
        external
        onlyAdmin
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_DURATION) revert BadDeadline();
        _lock(asset, amount);
        id = ++eventCount;
        _events[id] = PoolEvent({
            asset: asset,
            kind: kind,
            status: Status.Open,
            replaced: false,
            deadline: deadline,
            payableAt: 0,
            amount: uint128(amount),
            paid: 0,
            rulesHash: rulesHash
        });
        emit EventCreated(id, asset, kind, amount, deadline, rulesHash);
    }

    /// @notice Admin, before the deadline: the winners and their prizes; the rest of the locked amount returns to the
    /// free balance now. Payable after CHECK_WINDOW.
    function publishWinners(uint256 id, address[] calldata winners, uint256[] calldata amounts) external onlyAdmin {
        PoolEvent storage e = _events[id];
        if (e.status != Status.Open) revert BadStatus();
        if (block.timestamp >= e.deadline) revert PastDeadline();
        _setWinners(id, e, winners, amounts, false);
    }

    /// @notice Admin, once per event, during the check window: replaces the whole list (sum at most the published sum)
    /// and restarts the window.
    function replaceWinners(uint256 id, address[] calldata winners, uint256[] calldata amounts) external onlyAdmin {
        PoolEvent storage e = _events[id];
        if (e.status != Status.Published) revert BadStatus();
        if (e.replaced) revert AlreadyReplaced();
        if (block.timestamp >= e.payableAt) revert WindowClosed();
        address[] storage old = _winners[id];
        for (uint256 i; i < old.length; ++i) {
            delete prizeOf[id][old[i]];
        }
        delete _winners[id];
        e.replaced = true;
        _setWinners(id, e, winners, amounts, true);
    }

    function _setWinners(
        uint256 id,
        PoolEvent storage e,
        address[] calldata winners,
        uint256[] calldata amounts,
        bool replacement
    ) private {
        uint256 n = winners.length;
        if (n == 0 || n > MAX_WINNERS || n != amounts.length) revert BadWinners();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address w = winners[i];
            if (w == address(0) || amounts[i] == 0 || prizeOf[id][w] != 0) revert BadWinners();
            prizeOf[id][w] = amounts[i];
            _winners[id].push(w);
            sum += amounts[i];
        }
        if (sum > e.amount) revert AboveLocked();
        uint256 returned = e.amount - sum;
        if (returned != 0) {
            _locked[e.asset] -= returned;
            _free[e.asset] += returned;
        }
        e.amount = uint128(sum);
        e.status = Status.Published;
        e.payableAt = uint64(block.timestamp) + CHECK_WINDOW;
        emit WinnersPublished(id, winners, amounts, returned, e.payableAt, replacement);
    }

    /// @notice A winner takes its prize after the check window.
    function claim(uint256 id) external returns (uint256) {
        return _payPrize(id, msg.sender, msg.sender);
    }

    /// @notice A winner takes its prize to another address (for a winner that cannot receive ETH).
    function claimTo(uint256 id, address to) external returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return _payPrize(id, msg.sender, to);
    }

    /// @notice Anyone pays `winner`'s prize to `winner` and nowhere else.
    function claimFor(uint256 id, address winner) external returns (uint256) {
        return _payPrize(id, winner, winner);
    }

    function _payPrize(uint256 id, address winner, address to) private nonReentrant returns (uint256 amount) {
        PoolEvent storage e = _events[id];
        if (e.status != Status.Published) revert BadStatus();
        if (block.timestamp < e.payableAt) revert NotPayableYet(e.payableAt);
        amount = prizeOf[id][winner];
        if (amount == 0 || claimed[id][winner]) revert NothingToClaim();
        claimed[id][winner] = true;
        e.paid += uint128(amount);
        _locked[e.asset] -= amount;
        _send(e.asset, to, amount);
        emit PrizePaid(id, winner, to, e.asset, amount);
    }

    /// @notice Anyone, at or after the deadline of an event with no published winners: its amount returns to the free
    /// balance, never to the admin.
    function expire(uint256 id) external {
        PoolEvent storage e = _events[id];
        if (e.status != Status.Open) revert BadStatus();
        if (block.timestamp < e.deadline) revert DeadlineNotReached();
        uint256 amount = e.amount;
        e.status = Status.Expired;
        _locked[e.asset] -= amount;
        _free[e.asset] += amount;
        emit EventExpired(id, amount);
    }

    function eventOf(uint256 id) external view returns (PoolEvent memory) {
        return _events[id];
    }

    function winnersOf(uint256 id) external view returns (address[] memory) {
        return _winners[id];
    }

    // ------------------------------------------------------------------ achievements custody (R-40 to R-42)

    function lockForAchievement(address asset, uint256 amount) external onlyAchievements {
        if (amount == 0) revert ZeroAmount();
        _lock(asset, amount);
        achievementLocked[asset] += amount;
        emit AchievementLocked(asset, amount);
    }

    function releaseAchievement(address asset, uint256 amount) external onlyAchievements {
        if (amount == 0) return;
        achievementLocked[asset] -= amount;
        _locked[asset] -= amount;
        _free[asset] += amount;
        emit AchievementReleased(asset, amount);
    }

    function payAchievement(address asset, address to, uint256 amount) external onlyAchievements nonReentrant {
        achievementLocked[asset] -= amount;
        _locked[asset] -= amount;
        _send(asset, to, amount);
        emit AchievementPaid(asset, to, amount);
    }

    // ------------------------------------------------------------------ admin role

    function transferAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminTransferStarted(admin, next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // ------------------------------------------------------------------ internals

    function _lock(address asset, uint256 amount) private {
        uint256 cap = lockCap(asset);
        if (amount > cap) revert AboveLockCap(amount, cap);
        _free[asset] -= amount;
        _locked[asset] += amount;
    }

    function _send(address asset, address to, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            uint256 before = IERC20Pool(asset).balanceOf(address(this));
            (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20Pool.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InexactTransfer();
            if (before - IERC20Pool(asset).balanceOf(address(this)) != amount) revert InexactTransfer();
        }
    }

    function _safeTransferFrom(address asset, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20Pool.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InexactTransfer();
    }

    receive() external payable {}
}
