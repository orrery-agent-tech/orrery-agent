// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RewardPool} from "./RewardPool.sol";
import {IAchievementVerifier} from "./interfaces/IAchievementVerifier.sol";

/// @title OrryAchievements
/// @notice The Achievement Board (`docs/ORRY-CHAT-PLAN.md` 5, R-40 to R-43, `docs/updates/L1-COMMUNITY-SPEC.md` L1-5).
/// The admin (read live from the pool: the treasury wallet) creates an achievement paying `rewardPerUser` of `asset` to
/// at most `maxRecipients` addresses; the whole amount is locked in the `RewardPool` at creation under its cap.
/// On-chain kinds (a verifier is set): `claim(id, data)` pays at once when the verifier's condition holds in that block,
/// first come first served. Listed kinds (no verifier): the admin publishes completers in non-decreasing completion
/// time; each can be paid 48 hours (the pool's CHECK_WINDOW) after its batch, until the deadline. One payout per address
/// per achievement, and on-chain claims with data also one payout per claim subject (`keccak256(data)`): with
/// `VerifiedAgentVerifier` the subject is the agent ID, so one agent pays once whoever owns it
/// (`docs/updates/ACHIEVEMENTS-USDG-SPEC.md` AU-7). After the deadline `close` returns every unpaid slot to the pool's
/// free balance. This contract holds no funds: the pool pays recipients directly.
contract OrryAchievements {
    struct Achievement {
        address asset;
        address verifier; // address(0) = listed kind
        uint128 rewardPerUser;
        uint32 maxRecipients;
        uint32 paid; // payouts made
        uint32 listed; // listed kind: completers published and not unlisted
        uint8 kind;
        bool closed;
        uint64 deadline;
        uint64 lastCompletedAt; // listed kind: the latest published completion time
        bytes32 rulesHash;
    }

    event AchievementCreated(
        uint256 indexed id,
        address indexed asset,
        uint8 indexed kind,
        address verifier,
        uint256 rewardPerUser,
        uint32 maxRecipients,
        uint64 deadline,
        bytes32 rulesHash
    );
    event CompletersPublished(uint256 indexed id, address[] accounts, uint64[] completedAt, uint64 claimableAt);
    event CompleterUnlisted(uint256 indexed id, address indexed account);
    event AchievementClaimed(
        uint256 indexed id, address indexed account, uint64 completedAt, uint32 rank, address asset, uint256 amount
    );
    event AchievementClosed(uint256 indexed id, uint256 returned);
    event SubjectClaimed(uint256 indexed id, bytes32 indexed subject, address indexed account);

    error NotAdmin();
    error ZeroAmount();
    error BadRecipients();
    error BadDeadline();
    error UnknownAchievement();
    error WrongKind();
    error PastDeadline();
    error DeadlineNotReached();
    error AlreadyClaimed();
    error Full();
    error ConditionNotMet();
    error BadCompleters();
    error NotListed();
    error NotClaimableYet(uint64 claimableAt);
    error WindowClosed();
    error AlreadyClosed();
    error SubjectAlreadyClaimed(address by);

    uint32 public constant MAX_RECIPIENTS = 100_000;
    uint256 public constant MAX_BATCH = 200;
    uint64 public constant MAX_DURATION = 365 days;

    RewardPool public immutable pool;

    uint256 public achievementCount;
    mapping(uint256 id => Achievement) private _achievements;
    mapping(uint256 id => mapping(address account => bool)) public claimed;
    /// @notice Listed kind: when the account's batch was published (0 = not listed).
    mapping(uint256 id => mapping(address account => uint64)) public listedAt;
    mapping(uint256 id => mapping(address account => uint64)) public completedAtOf;
    /// @notice On-chain kinds: who claimed with this subject (`keccak256(data)`, non-empty data only); 0 = unclaimed.
    mapping(uint256 id => mapping(bytes32 subject => address)) public subjectClaimedBy;

    constructor(address pool_) {
        require(pool_ != address(0), "zero address");
        pool = RewardPool(payable(pool_));
        require(RewardPool(payable(pool_)).achievements() == address(this), "pool wiring");
    }

    modifier onlyAdmin() {
        if (msg.sender != pool.admin()) revert NotAdmin();
        _;
    }

    function create(
        address asset,
        uint256 rewardPerUser,
        uint32 maxRecipients,
        uint64 deadline,
        uint8 kind,
        address verifier,
        bytes32 rulesHash
    ) external onlyAdmin returns (uint256 id) {
        if (rewardPerUser == 0 || rewardPerUser > type(uint128).max) revert ZeroAmount();
        if (maxRecipients == 0 || maxRecipients > MAX_RECIPIENTS) revert BadRecipients();
        uint64 minEnd = uint64(block.timestamp) + (verifier == address(0) ? pool.CHECK_WINDOW() : 0);
        if (deadline <= minEnd || deadline > block.timestamp + MAX_DURATION) revert BadDeadline();
        pool.lockForAchievement(asset, rewardPerUser * maxRecipients);
        id = ++achievementCount;
        _achievements[id] = Achievement({
            asset: asset,
            verifier: verifier,
            rewardPerUser: uint128(rewardPerUser),
            maxRecipients: maxRecipients,
            paid: 0,
            listed: 0,
            kind: kind,
            closed: false,
            deadline: deadline,
            lastCompletedAt: 0,
            rulesHash: rulesHash
        });
        emit AchievementCreated(id, asset, kind, verifier, rewardPerUser, maxRecipients, deadline, rulesHash);
    }

    // ------------------------------------------------------------------ on-chain kinds (R-41)

    /// @notice Pays the caller when the achievement's verifier says its condition holds for the caller now.
    function claim(uint256 id, bytes calldata data) external returns (uint256) {
        Achievement storage a = _get(id);
        if (a.verifier == address(0)) revert WrongKind();
        if (block.timestamp >= a.deadline) revert PastDeadline();
        if (claimed[id][msg.sender]) revert AlreadyClaimed();
        if (a.paid >= a.maxRecipients) revert Full();
        if (!IAchievementVerifier(a.verifier).isComplete(msg.sender, data)) revert ConditionNotMet();
        if (data.length != 0) {
            bytes32 subject = keccak256(data);
            address by = subjectClaimedBy[id][subject];
            if (by != address(0)) revert SubjectAlreadyClaimed(by);
            subjectClaimedBy[id][subject] = msg.sender;
            emit SubjectClaimed(id, subject, msg.sender);
        }
        completedAtOf[id][msg.sender] = uint64(block.timestamp);
        return _pay(id, a, msg.sender);
    }

    // ------------------------------------------------------------------ listed kinds (R-41)

    /// @notice Admin: completers in non-decreasing completion time (each not in the future), at most `maxRecipients`
    /// listed in total, published no later than `deadline - CHECK_WINDOW`.
    function publishCompleters(uint256 id, address[] calldata accounts, uint64[] calldata completedAt)
        external
        onlyAdmin
    {
        Achievement storage a = _get(id);
        if (a.verifier != address(0)) revert WrongKind();
        uint64 claimableAt = uint64(block.timestamp) + pool.CHECK_WINDOW();
        if (claimableAt > a.deadline) revert PastDeadline();
        uint256 n = accounts.length;
        if (n == 0 || n > MAX_BATCH || n != completedAt.length) revert BadCompleters();
        if (a.paid + a.listed + n > a.maxRecipients) revert Full();
        uint64 last = a.lastCompletedAt;
        for (uint256 i; i < n; ++i) {
            address acct = accounts[i];
            uint64 t = completedAt[i];
            if (acct == address(0) || listedAt[id][acct] != 0 || claimed[id][acct]) revert BadCompleters();
            if (t < last || t > block.timestamp) revert BadCompleters();
            last = t;
            listedAt[id][acct] = uint64(block.timestamp);
            completedAtOf[id][acct] = t;
        }
        a.lastCompletedAt = last;
        a.listed += uint32(n);
        emit CompletersPublished(id, accounts, completedAt, claimableAt);
    }

    /// @notice Admin, during the account's check window only: removes a listed completer and frees its slot.
    function unlist(uint256 id, address account) external onlyAdmin {
        Achievement storage a = _get(id);
        uint64 at = listedAt[id][account];
        if (at == 0) revert NotListed();
        if (block.timestamp >= at + pool.CHECK_WINDOW()) revert WindowClosed();
        delete listedAt[id][account];
        delete completedAtOf[id][account];
        a.listed -= 1;
        emit CompleterUnlisted(id, account);
    }

    function claimListed(uint256 id) external returns (uint256) {
        return _claimListed(id, msg.sender);
    }

    /// @notice Anyone pays a listed completer to that completer and nowhere else.
    function claimListedFor(uint256 id, address account) external returns (uint256) {
        return _claimListed(id, account);
    }

    function _claimListed(uint256 id, address account) private returns (uint256) {
        Achievement storage a = _get(id);
        if (a.verifier != address(0)) revert WrongKind();
        if (block.timestamp >= a.deadline) revert PastDeadline();
        uint64 at = listedAt[id][account];
        if (at == 0) revert NotListed();
        if (claimed[id][account]) revert AlreadyClaimed();
        uint64 claimableAt = at + pool.CHECK_WINDOW();
        if (block.timestamp < claimableAt) revert NotClaimableYet(claimableAt);
        a.listed -= 1;
        return _pay(id, a, account);
    }

    // ------------------------------------------------------------------ close (R-40, A-3)

    /// @notice Anyone, at or after the deadline: every unpaid slot returns to the pool's free balance, once.
    function close(uint256 id) external returns (uint256 returned) {
        Achievement storage a = _get(id);
        if (block.timestamp < a.deadline) revert DeadlineNotReached();
        if (a.closed) revert AlreadyClosed();
        a.closed = true;
        returned = uint256(a.maxRecipients - a.paid) * a.rewardPerUser;
        pool.releaseAchievement(a.asset, returned);
        emit AchievementClosed(id, returned);
    }

    function achievementOf(uint256 id) external view returns (Achievement memory) {
        return _achievements[id];
    }

    function _get(uint256 id) private view returns (Achievement storage a) {
        a = _achievements[id];
        if (a.maxRecipients == 0) revert UnknownAchievement();
    }

    function _pay(uint256 id, Achievement storage a, address account) private returns (uint256 amount) {
        claimed[id][account] = true;
        a.paid += 1;
        amount = a.rewardPerUser;
        pool.payAchievement(a.asset, account, amount);
        emit AchievementClaimed(id, account, completedAtOf[id][account], a.paid, a.asset, amount);
    }
}
