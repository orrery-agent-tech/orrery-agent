// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {IPredictionMarket} from "./interfaces/IPrediction.sol";
import {IFeeTiers, IOrryPriceOracle} from "../interfaces/IMarketPricing.sol";
import {IOrryToken} from "../../orry/interfaces/IOrryToken.sol";
import {IChainlinkFeed} from "../ChainlinkFeed.sol";

interface IStakeToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice The issuer views of a Robinhood stock token: the oracle pause of a corporate action and when a new UI
/// multiplier takes effect (as read by R1, D-R1-2).
interface IStockActionViews {
    function oraclePaused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
}

/// @notice Everything a market is made with; set once by its factory.
struct MarketInit {
    address usdg;
    address treasury;
    address feeTiers;
    address orryPrice;
    address orry;
    address feed;
    address asset;
    int256 strike;
    uint64 closeTime;
    uint64 lockTime;
    uint16 feeBps;
    uint256 minStake;
    uint16 orryFeeDiscountBps;
}

/// @notice One binary market on a Chainlink feed, parimutuel in USDG (`docs/updates/L3-R2-SPEC.md` 3.2). Its own contract,
/// so an issuer freeze of USDG reaches only this market's stakers (custody pattern C, R-27, X-3).
/// @dev The market rules (pooled YES and NO stakes, staking lock before the close, settlement at the first
/// Chainlink round published at or after the close, the settler naming that round, refunds when one side is empty or
/// nobody settles within the window, YES only strictly above the strike). One contract per market, no roles and no pause, the fee taken per claim from the winner's gross payout with the
/// staker discount (L2) or paid in ORRY and burned (L3), a refund on a corporate action of the bound stock token, and a
/// sweep of dust to the treasury.
contract PredictionMarket is IPredictionMarket {
    uint64 public constant SETTLE_WINDOW = 7 days;
    uint256 private constant BPS = 10_000;
    uint8 private constant BURN_PREDICTION_FEE = 31;
    bytes32 private constant LOCK_SLOT = keccak256("orrery.PredictionMarket.lock");

    address public immutable factory;
    address public immutable usdg;
    address public immutable treasury;
    address public immutable feeTiers;
    address public immutable orryPrice;
    address public immutable orry;
    address public immutable feed;
    address public immutable asset;
    int256 public immutable strike;
    uint64 public immutable createdAt;
    uint64 public immutable lockTime;
    uint64 public immutable closeTime;
    uint16 public immutable feeBps;
    uint256 public immutable minStake;
    uint16 public immutable orryFeeDiscountBps;

    Status public status;
    int256 private _settlePrice;
    uint80 private _settleRound;
    uint256 private _yesPool;
    uint256 private _noPool;
    /// @dev Refund: stakes paid back so far; Yes or No: winning stakes whose owners claimed.
    uint256 private _claimedStake;
    mapping(address account => uint256) private _yes;
    mapping(address account => uint256) private _no;
    mapping(address account => bool) public claimed;

    constructor(MarketInit memory m) {
        factory = msg.sender;
        usdg = m.usdg;
        treasury = m.treasury;
        feeTiers = m.feeTiers;
        orryPrice = m.orryPrice;
        orry = m.orry;
        feed = m.feed;
        asset = m.asset;
        strike = m.strike;
        createdAt = uint64(block.timestamp);
        lockTime = m.lockTime;
        closeTime = m.closeTime;
        feeBps = m.feeBps;
        minStake = m.minStake;
        orryFeeDiscountBps = m.orryFeeDiscountBps;
    }

    modifier nonReentrant() {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            if tload(slot) { revert(0, 0) }
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    // ------------------------------------------------------------------ views

    function info() external view returns (Info memory) {
        return Info({
            factory: factory,
            feed: feed,
            asset: asset,
            strike: strike,
            createdAt: createdAt,
            lockTime: lockTime,
            closeTime: closeTime,
            status: status,
            settlePrice: _settlePrice,
            settleRound: _settleRound,
            yesPool: _yesPool,
            noPool: _noPool
        });
    }

    function stakeOf(address account) external view returns (uint256 yes, uint256 no) {
        return (_yes[account], _no[account]);
    }

    function grossOf(address account) public view returns (uint256) {
        if (claimed[account]) return 0;
        Status s = status;
        if (s == Status.Open) return 0;
        if (s == Status.Refund) return _yes[account] + _no[account];
        (uint256 stakeWon, uint256 winPool) = s == Status.Yes ? (_yes[account], _yesPool) : (_no[account], _noPool);
        if (stakeWon == 0) return 0;
        return FullMath.mulDiv(stakeWon, _yesPool + _noPool, winPool);
    }

    function owed() public view returns (uint256) {
        uint256 total = _yesPool + _noPool;
        Status s = status;
        if (s == Status.Open) return total;
        if (s == Status.Refund) return total - _claimedStake;
        uint256 winPool = s == Status.Yes ? _yesPool : _noPool;
        return FullMath.mulDivRoundingUp(winPool - _claimedStake, total, winPool);
    }

    // ------------------------------------------------------------------ staking

    function stake(bool yes, uint256 amount) external nonReentrant {
        if (block.timestamp >= lockTime || status != Status.Open) revert StakingClosed();
        if (amount < minStake) revert StakeTooSmall();
        uint256 before = IStakeToken(usdg).balanceOf(address(this));
        if (!_tryCall(usdg, abi.encodeCall(IStakeToken.transferFrom, (msg.sender, address(this), amount)))) {
            revert InexactTransfer();
        }
        if (IStakeToken(usdg).balanceOf(address(this)) - before != amount) revert InexactTransfer();
        if (yes) {
            _yes[msg.sender] += amount;
            _yesPool += amount;
        } else {
            _no[msg.sender] += amount;
            _noPool += amount;
        }
        emit Staked(msg.sender, yes, amount);
    }

    // ------------------------------------------------------------------ settlement

    function settle(uint80 roundId) external nonReentrant {
        if (status != Status.Open) revert NotOpen();
        if (block.timestamp < closeTime) revert NotClosed();
        if (block.timestamp >= uint256(closeTime) + SETTLE_WINDOW) revert WindowClosed();
        if (_yesPool == 0 || _noPool == 0) {
            // nobody took the other side: nothing to win, every stake goes back
            _setStatus(Status.Refund, 0, 0);
            return;
        }
        (int256 answer, uint256 updatedAt) = _round(roundId);
        if (updatedAt < closeTime || answer <= 0) revert BadPrice();
        // the round before must predate the close, so `roundId` is the first one at or after it
        if (roundId == 0) revert NotFirstRound();
        (bool prevOk, uint256 prevUpdatedAt) = _roundTime(roundId - 1);
        if (!prevOk || prevUpdatedAt == 0 || prevUpdatedAt >= closeTime) revert NotFirstRound();
        if (asset != address(0)) {
            try IStockActionViews(asset).oraclePaused() returns (bool paused) {
                if (paused) revert StalePrice();
            } catch {}
            try IStockActionViews(asset).effectiveAt() returns (uint256 effectiveAt) {
                // a corporate action between creation and the settlement round changes what the strike means
                if (effectiveAt > createdAt && effectiveAt <= updatedAt) {
                    _setStatus(Status.Refund, answer, roundId);
                    return;
                }
            } catch {}
        }
        _setStatus(answer > strike ? Status.Yes : Status.No, answer, roundId);
    }

    function expire() external nonReentrant {
        if (status != Status.Open) revert NotOpen();
        if (block.timestamp < uint256(closeTime) + SETTLE_WINDOW) revert WindowOpen();
        _setStatus(Status.Refund, 0, 0);
    }

    function _setStatus(Status s, int256 price, uint80 roundId) private {
        status = s;
        _settlePrice = price;
        _settleRound = roundId;
        emit Settled(s, price, roundId);
    }

    function _round(uint80 roundId) private view returns (int256 answer, uint256 updatedAt) {
        try IChainlinkFeed(feed).getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            return (a, u);
        } catch {
            revert BadPrice();
        }
    }

    function _roundTime(uint80 roundId) private view returns (bool ok, uint256 updatedAt) {
        try IChainlinkFeed(feed).getRoundData(roundId) returns (uint80, int256, uint256, uint256 u, uint80) {
            return (true, u);
        } catch {
            return (false, 0);
        }
    }

    // ------------------------------------------------------------------ claims

    function claim(bool payFeeInOrry) external nonReentrant returns (uint256 payout) {
        Status s = status;
        if (s == Status.Open) revert NotSettled();
        uint256 gross = grossOf(msg.sender);
        if (gross == 0) revert NothingToClaim();
        claimed[msg.sender] = true;
        if (s == Status.Refund) {
            _claimedStake += gross;
            _pay(msg.sender, gross);
            emit Claimed(msg.sender, gross, 0, 0);
            return gross;
        }
        _claimedStake += s == Status.Yes ? _yes[msg.sender] : _no[msg.sender];

        uint256 fee = FullMath.mulDiv(gross, uint256(feeBps) * (BPS - _discount(msg.sender)), BPS * BPS);
        uint256 usdgFee = fee;
        uint256 orryFee;
        if (payFeeInOrry && fee != 0) {
            (bool ok, uint256 amount) = _orryFor(FullMath.mulDiv(fee, BPS - orryFeeDiscountBps, BPS));
            if (ok) {
                usdgFee = 0;
                if (amount != 0) {
                    uint256 supply = IOrryToken(orry).totalSupply();
                    IOrryToken(orry).burnFrom(msg.sender, amount);
                    if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();
                    orryFee = amount;
                    emit Burned(BURN_PREDICTION_FEE, amount);
                }
            }
        }
        payout = gross - usdgFee;
        _pay(msg.sender, payout);
        _pay(treasury, usdgFee);
        emit Claimed(msg.sender, payout, usdgFee, orryFee);
    }

    function sweep() external nonReentrant returns (uint256 amount) {
        if (status == Status.Open) revert NotSettled();
        uint256 balance = IStakeToken(usdg).balanceOf(address(this));
        uint256 o = owed();
        amount = balance > o ? balance - o : 0;
        if (amount == 0) revert NothingToClaim();
        _pay(treasury, amount);
        emit Swept(amount);
    }

    // ------------------------------------------------------------------ helpers

    function _discount(address account) private view returns (uint256) {
        try IFeeTiers(feeTiers).discountBps(account) returns (uint16 d) {
            return d > BPS ? BPS : d;
        } catch {
            return 0;
        }
    }

    function _orryFor(uint256 usd) private view returns (bool ok, uint256 amount) {
        try IOrryPriceOracle(orryPrice).ready() returns (bool isReady) {
            if (!isReady) return (false, 0);
        } catch {
            return (false, 0);
        }
        if (usd == 0) return (true, 0);
        try IOrryPriceOracle(orryPrice).orryFor(usd) returns (uint256 a) {
            return (true, a);
        } catch {
            return (false, 0);
        }
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        if (!_tryCall(usdg, abi.encodeCall(IStakeToken.transfer, (to, amount)))) revert InexactTransfer();
    }

    /// @dev A token call that succeeded and returned true or nothing.
    function _tryCall(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
