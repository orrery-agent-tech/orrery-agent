// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {ISealedBatchMarket} from "./interfaces/ISealedBatchMarket.sol";
import {IFeeTiers, IOrryPriceOracle} from "./interfaces/IMarketPricing.sol";
import {IOrryToken} from "../orry/interfaces/IOrryToken.sol";
import {IChainlinkFeed} from "./ChainlinkFeed.sol";
import {MarketParams, checkMarketParams} from "./MarketParams.sol";

interface IMarketToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice The issuer views of a Robinhood stock token (scaled UI amount and the oracle pause of a corporate action).
interface IScaledStockViews {
    function oraclePaused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
}

/// @notice One stock token against USDG: sealed commit and reveal batches, cleared at the Chainlink price and settled
/// wallet to wallet (`docs/ORRY-R1-SPEC.md` 2.1 and 7, custody pattern A of R-27).
/// @dev The batch mechanism (commit and reveal epochs, one order per address, crossing at the oracle price with
/// the larger side filled pro rata, `MAX_ORDERS`, `EXPIRY`) with a Uniswap v4 pool leg for the unmatched part. No internal balances
/// (each order's input is pulled from its owner's wallet at clearing and every output and refund is paid back in the
/// same transaction), the price is a hinted Chainlink round, fees are in USDG to the treasury or in ORRY (burned), no
/// owner, no pause, no setter.
///
/// Prices: the stock feed answer is USD per whole raw token. Measured on 4663 (lane M-1 report): over 29,565 weekday
/// swaps in the SPY/USDG pool (token multiplier 1.0017) the median pool price over the feed is 0.99966, so the feed
/// already prices one raw token and no `uiMultiplier` conversion applies; a multiplier change after the round blocks
/// clearing instead (D-R1-2).
///
/// Clearing, in one transaction:
/// 1. every revealed order whose limit the price meets is probed (a zero transfer of its output token to its owner, so
///    an issuer block, freeze or pause shows before anything moves), then its input is pulled (`transferFrom`, balance
///    delta checked); a failed probe or pull drops that order only (D-R1-4);
/// 2. the pulled volumes cross at the price: A = min(asset offered, asset the USDG offered buys), and buyers together
///    pay U = ceil(A * price); each side is split by a running total, so every order on the larger side fills at the
///    same fraction to within one base unit and the splits add up exactly (no asset dust);
/// 3. Swap-mode orders on the larger side send what did not cross to the remainder pool, in reveal order and in one
///    `unlock`, each with a price limit at the tighter of its own limit and the clearing price minus or plus
///    `maxDeviationBps`, adjusted for the pool's fee; each fill's realised price must sit within the order's limit and
///    within `maxDeviationBps` of the clearing price or the whole pool leg is undone (`DeviationTooHigh`) and every
///    remainder is refunded (D-R1-5, DP-11);
/// 4. sellers receive what they earned less fees, buyers what they bought; the USDG left over and the USDG fees go to
///    the treasury, ORRY fees are burned from the payer's wallet;
/// 5. the market's asset and USDG balances are the same as before the call (X-1, D-R1-3).
contract SealedBatchMarket is ISealedBatchMarket, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct Entry {
        address account;
        Order order;
    }

    /// @dev Working state of one order during `clear`.
    struct Fill {
        bool live; // probed and pulled
        bool inOrry; // fee paid in ORRY
        uint16 discount;
        uint256 pulled;
        uint256 maxOrryFee;
        uint256 crossIn; // asset sold or USDG paid in the cross
        uint256 crossOut; // USDG earned or asset bought in the cross
        uint256 poolIn; // input sent to the remainder pool
        uint256 poolOut; // output received from it
    }

    /// @dev Totals of one `clear`.
    struct Totals {
        uint256 price;
        uint256 sells; // asset pulled from sellers
        uint256 buys; // USDG notional offered by buyers (fees excluded)
        uint256 crossed; // A: asset that changes hands
        uint256 paid; // U: USDG buyers pay for it
        uint256 earned; // USDG sellers earn before fees
        uint256 usdgFees;
        uint256 orryBurned;
        uint256 assetViaPool;
        uint256 usdgViaPool;
        uint32 dropped;
    }

    /// @dev One swap of the pool leg: exact input with a price limit and the realised-price bounds it must meet.
    struct Leg {
        uint256 amountIn;
        uint256 low; // lowest realised price allowed, USDG base units per 1e18 asset base units
        uint256 high; // highest realised price allowed
    }

    uint32 public constant MAX_ORDERS = 64;
    uint64 public constant EXPIRY = 1 days;
    uint256 private constant BPS = 10_000;
    uint256 private constant PIPS = 1_000_000;
    uint256 private constant ONE = 1e18; // prices are per 1e18 asset base units
    /// @dev Larger inputs cannot be funded by any real token; such an order is dropped at clearing.
    uint256 private constant MAX_AMOUNT = type(uint128).max;
    uint8 private constant BURN_COMMIT_FEE = 5;
    uint8 private constant BURN_ORRY_FEE = 6;
    bytes32 private constant LOCK_SLOT = keccak256("orrery.SealedBatchMarket.lock");
    bytes32 private constant POOL_LEG_SLOT = keccak256("orrery.SealedBatchMarket.poolLeg");

    address public immutable asset;
    address public immutable usdg;
    address public immutable priceFeed;
    address public immutable treasury;
    address public immutable feeTiers;
    address public immutable orryPrice;
    address public immutable orry;
    uint64 public immutable start;
    uint32 public immutable commitSeconds;
    uint32 public immutable revealSeconds;
    uint16 public immutable feeBps;
    uint256 public immutable minNotionalUsdg;
    uint32 public immutable maxStaleness;
    uint256 public immutable commitFeeUsd;
    uint16 public immutable orryFeeDiscountBps;
    uint16 public immutable maxDeviationBps;
    /// @dev price = answer * _priceNum / _priceDen, in USDG base units per 1e18 asset base units.
    uint256 private immutable _priceNum;
    uint256 private immutable _priceDen;
    // the remainder pool (R1b), fixed at creation; `_listed` false means none
    address private immutable _poolManager;
    bool private immutable _listed;
    bool private immutable _assetIs0;
    uint24 private immutable _poolFee;
    int24 private immutable _poolTickSpacing;

    mapping(uint256 batch => mapping(address account => bytes32)) private _commitment;
    mapping(uint256 batch => uint32) private _commitCount;
    mapping(uint256 batch => Entry[]) private _orders;
    mapping(uint256 batch => BatchResult) private _results;
    mapping(uint256 batch => bool) private _expired;

    constructor(
        address asset_,
        address usdg_,
        address priceFeed_,
        address treasury_,
        address feeTiers_,
        address orryPrice_,
        address orry_,
        address poolManager_,
        PoolKey memory remainderPool_,
        MarketParams memory p
    ) {
        require(
            asset_ != address(0) && usdg_ != address(0) && priceFeed_ != address(0) && treasury_ != address(0)
                && feeTiers_ != address(0) && orryPrice_ != address(0) && orry_ != address(0),
            "zero address"
        );
        require(asset_ != usdg_ && asset_ != orry_ && usdg_ != orry_, "same token");
        checkMarketParams(p);
        uint256 decimalsSum = uint256(IChainlinkFeed(priceFeed_).decimals()) + IMarketToken(asset_).decimals();
        uint256 usdgDecimals = IMarketToken(usdg_).decimals();
        require(decimalsSum <= 60 && usdgDecimals <= 30, "decimals");
        bool listed = Currency.unwrap(remainderPool_.currency1) != address(0);
        if (listed) {
            (address c0, address c1) = asset_ < usdg_ ? (asset_, usdg_) : (usdg_, asset_);
            require(
                Currency.unwrap(remainderPool_.currency0) == c0 && Currency.unwrap(remainderPool_.currency1) == c1,
                "pool currencies"
            );
            // a hook could take deltas from the swap; the remainder pool is a plain pool
            require(address(remainderPool_.hooks) == address(0), "pool hooks");
            require(poolManager_ != address(0), "zero pool manager");
        }
        asset = asset_;
        usdg = usdg_;
        priceFeed = priceFeed_;
        treasury = treasury_;
        feeTiers = feeTiers_;
        orryPrice = orryPrice_;
        orry = orry_;
        start = uint64(block.timestamp);
        commitSeconds = p.commitSeconds;
        revealSeconds = p.revealSeconds;
        feeBps = p.feeBps;
        minNotionalUsdg = p.minNotionalUsdg;
        maxStaleness = p.maxStaleness;
        commitFeeUsd = p.commitFeeUsd;
        orryFeeDiscountBps = p.orryFeeDiscountBps;
        maxDeviationBps = p.maxDeviationBps;
        _priceNum = 10 ** usdgDecimals * ONE;
        _priceDen = 10 ** decimalsSum;
        _poolManager = poolManager_;
        _listed = listed;
        _assetIs0 = asset_ < usdg_;
        _poolFee = listed ? remainderPool_.fee : 0;
        _poolTickSpacing = listed ? remainderPool_.tickSpacing : int24(0);
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

    function phase() public view returns (uint256 batch, bool inCommit, uint64 endsAt) {
        uint256 len = uint256(commitSeconds) + revealSeconds;
        uint256 t = block.timestamp - start;
        batch = t / len;
        inCommit = t % len < commitSeconds;
        endsAt = uint64(start + batch * len + (inCommit ? commitSeconds : len));
    }

    function revealEnd(uint256 batch) public view returns (uint64) {
        return uint64(start + (batch + 1) * (uint256(commitSeconds) + revealSeconds));
    }

    function commitmentOf(uint256 batch, address account) external view returns (bytes32) {
        return _commitment[batch][account];
    }

    function orderCount(uint256 batch) external view returns (uint256) {
        return _orders[batch].length;
    }

    function orderAt(uint256 batch, uint256 i) external view returns (address account, Order memory order) {
        Entry storage e = _orders[batch][i];
        return (e.account, e.order);
    }

    function result(uint256 batch) external view returns (BatchResult memory) {
        return _results[batch];
    }

    function remainderPool() public view returns (PoolKey memory key, bool listed) {
        if (!_listed) return (key, false);
        (address c0, address c1) = _assetIs0 ? (asset, usdg) : (usdg, asset);
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), _poolFee, _poolTickSpacing, IHooks(address(0)));
        listed = true;
    }

    function commitmentFor(uint256 batch, address account, Order calldata order, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(batch, account, order, salt));
    }

    // ------------------------------------------------------------------ commit and reveal

    function commit(bytes32 commitment) external nonReentrant {
        if (commitment == bytes32(0)) revert ZeroAmount();
        (uint256 batch, bool inCommit,) = phase();
        if (!inCommit) revert WrongPhase();
        if (_commitment[batch][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        if (_commitCount[batch] >= MAX_ORDERS) revert BatchFull();
        _commitCount[batch] += 1;
        _commitment[batch][msg.sender] = commitment;

        uint256 burned;
        if (commitFeeUsd != 0) {
            (bool ok, uint256 amount) = _orryFor(commitFeeUsd);
            if (ok && amount != 0) {
                uint256 supply = IOrryToken(orry).totalSupply();
                IOrryToken(orry).burnFrom(msg.sender, amount);
                if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();
                burned = amount;
                emit Burned(BURN_COMMIT_FEE, amount);
            }
        }
        emit Committed(batch, msg.sender, commitment, burned);
    }

    function reveal(Order calldata order, bytes32 salt) external nonReentrant {
        _reveal(msg.sender, order, salt);
    }

    function revealFor(address account, Order calldata order, bytes32 salt) external nonReentrant {
        _reveal(account, order, salt);
    }

    /// @dev The commitment binds `account`, so only the holder of the salt can open it, whoever sends it.
    function _reveal(address account, Order calldata order, bytes32 salt) private {
        (uint256 batch, bool inCommit,) = phase();
        if (inCommit) revert WrongPhase();
        bytes32 c = _commitment[batch][account];
        if (c == bytes32(0) || c != commitmentFor(batch, account, order, salt)) revert BadReveal();
        if (order.amountIn == 0 || order.limitPrice == 0) revert ZeroAmount();
        uint256 notional = order.amountIn;
        if (order.sellAsset) {
            (, int256 answer,,,) = IChainlinkFeed(priceFeed).latestRoundData();
            notional = FullMath.mulDiv(order.amountIn, _toPrice(answer), ONE);
        }
        if (notional < minNotionalUsdg) revert BelowMinimum();
        delete _commitment[batch][account];
        _orders[batch].push(Entry(account, order));
        emit Revealed(batch, account, order);
    }

    // ------------------------------------------------------------------ clearing

    function clear(uint256 batch, uint80 roundHint) external nonReentrant {
        uint256 end = revealEnd(batch);
        if (block.timestamp < end) revert WrongPhase();
        BatchResult storage r = _results[batch];
        if (r.cleared || _expired[batch]) revert AlreadyCleared();
        if (block.timestamp >= end + EXPIRY) revert Expired();
        r.cleared = true;

        Totals memory t;
        t.price = _clearingPrice(roundHint, end);
        uint256 assetBefore = IMarketToken(asset).balanceOf(address(this));
        uint256 usdgBefore = IMarketToken(usdg).balanceOf(address(this));

        Entry[] storage os = _orders[batch];
        Fill[] memory f = _pullInputs(batch, os, t);
        _cross(t);
        _split(os, f, t);
        if (_listed) _poolLeg(os, f, t);
        _settle(batch, os, f, t);

        // X-1 / D-R1-3: a clear leaves both balances exactly as it found them
        if (
            IMarketToken(asset).balanceOf(address(this)) != assetBefore
                || IMarketToken(usdg).balanceOf(address(this)) != usdgBefore
        ) revert InexactTransfer();

        r.price = t.price;
        r.roundId = roundHint;
        r.assetFilled = t.crossed;
        r.usdgFilled = t.paid;
        r.usdgFees = t.usdgFees;
        r.orryFeesBurned = t.orryBurned;
        r.ordersDropped = t.dropped;
        r.assetViaPool = t.assetViaPool;
        r.usdgViaPool = t.usdgViaPool;
        emit BatchCleared(batch, t.price, roundHint, t.crossed, t.paid);
    }

    function expire(uint256 batch) external nonReentrant {
        if (block.timestamp < uint256(revealEnd(batch)) + EXPIRY) revert WrongPhase();
        if (_results[batch].cleared || _expired[batch]) revert AlreadyCleared();
        _expired[batch] = true;
        emit BatchExpired(batch);
    }

    /// @dev The hinted round must be the latest with `updatedAt <= end`, fresh against `end` and positive, and no
    /// corporate action of the asset may sit between that round and now (D-R1-2).
    function _clearingPrice(uint80 roundHint, uint256 end) private view returns (uint256 price) {
        int256 answer;
        uint256 updatedAt;
        try IChainlinkFeed(priceFeed).getRoundData(roundHint) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            (answer, updatedAt) = (a, u);
        } catch {
            revert BadRound();
        }
        if (updatedAt == 0 || updatedAt > end) revert BadRound();
        (uint80 latest,,,,) = IChainlinkFeed(priceFeed).latestRoundData();
        if (roundHint != latest) {
            try IChainlinkFeed(priceFeed).getRoundData(roundHint + 1) returns (
                uint80, int256, uint256, uint256 nextUpdatedAt, uint80
            ) {
                if (nextUpdatedAt <= end) revert BadRound();
            } catch {
                revert BadRound();
            }
        }
        if (end - updatedAt > maxStaleness) revert StalePrice();
        try IScaledStockViews(asset).oraclePaused() returns (bool paused) {
            if (paused) revert StalePrice();
        } catch {}
        try IScaledStockViews(asset).effectiveAt() returns (uint256 effectiveAt) {
            if (effectiveAt > updatedAt && effectiveAt <= block.timestamp) revert StalePrice();
        } catch {}
        price = _toPrice(answer);
    }

    function _toPrice(int256 answer) private view returns (uint256 price) {
        if (answer <= 0) revert StalePrice();
        price = FullMath.mulDiv(uint256(answer), _priceNum, _priceDen);
        if (price == 0) revert StalePrice();
    }

    /// @dev Step 1: probe and pull every order whose limit the price meets.
    function _pullInputs(uint256 batch, Entry[] storage os, Totals memory t) private returns (Fill[] memory f) {
        uint256 n = os.length;
        f = new Fill[](n);
        (bool orryReady,) = _orryFor(0);
        for (uint256 i; i < n; ++i) {
            Entry storage e = os[i];
            Order storage o = e.order;
            if (o.sellAsset ? t.price < o.limitPrice : t.price > o.limitPrice) continue;
            if (!_pullOne(e, f[i], t.price, orryReady)) {
                t.dropped += 1;
                emit OrderDropped(batch, e.account);
                continue;
            }
            if (o.sellAsset) t.sells += o.amountIn;
            else t.buys += o.amountIn;
        }
    }

    function _pullOne(Entry storage e, Fill memory fl, uint256 price, bool orryReady) private returns (bool) {
        Order storage o = e.order;
        address account = e.account;
        uint256 amountIn = o.amountIn;
        if (amountIn > MAX_AMOUNT) return false;
        fl.discount = _discount(account);
        // a seller's notional may reach the top of the deviation band through the remainder pool
        uint256 sellPrice = _listed && o.mode == Mode.Swap ? _bandHigh(price) : price;
        uint256 maxFee = _usdFee(o.sellAsset ? FullMath.mulDiv(amountIn, sellPrice, ONE) : amountIn, fl.discount);

        if (o.payFeeInOrry && orryReady) {
            (bool ok, uint256 maxOrry) = _orryFor(_orryDiscounted(maxFee));
            if (ok) {
                // the ORRY fee is burned from the wallet after crossing, so it must be covered now
                if (
                    IOrryToken(orry).balanceOf(account) < maxOrry
                        || IOrryToken(orry).allowance(account, address(this)) < maxOrry
                ) return false;
                fl.inOrry = true;
                fl.maxOrryFee = maxOrry;
            }
        }

        (address tokenIn, address tokenOut) = o.sellAsset ? (asset, usdg) : (usdg, asset);
        uint256 pull = o.sellAsset || fl.inOrry ? amountIn : amountIn + maxFee;
        // the owner must be able to receive the output: a zero transfer meets the same issuer checks as a real one
        if (!_tryCall(tokenOut, abi.encodeCall(IMarketToken.transfer, (account, 0)))) return false;
        uint256 before = IMarketToken(tokenIn).balanceOf(address(this));
        if (!_tryCall(tokenIn, abi.encodeCall(IMarketToken.transferFrom, (account, address(this), pull)))) {
            return false;
        }
        if (IMarketToken(tokenIn).balanceOf(address(this)) - before != pull) revert InexactTransfer();
        fl.live = true;
        fl.pulled = pull;
        return true;
    }

    /// @dev Step 2: how much crosses. A = min(sells, buys / price), U = ceil(A * price), U <= buys.
    function _cross(Totals memory t) private pure {
        if (t.sells == 0 || t.buys == 0) return;
        uint256 affordable = FullMath.mulDiv(t.buys, ONE, t.price);
        t.crossed = t.sells < affordable ? t.sells : affordable;
        t.paid = FullMath.mulDivRoundingUp(t.crossed, t.price, ONE);
    }

    /// @dev Step 2, per order: the running-total split of A (asset) and U (USDG).
    function _split(Entry[] storage os, Fill[] memory f, Totals memory t) private view {
        uint256 sellCum;
        uint256 buyCum;
        uint256 soldPrev;
        uint256 gotPrev;
        uint256 paidPrev;
        for (uint256 i; i < f.length; ++i) {
            if (!f[i].live) continue;
            Order storage o = os[i].order;
            if (o.sellAsset) {
                sellCum += o.amountIn;
                uint256 soldCum = FullMath.mulDiv(t.crossed, sellCum, t.sells);
                f[i].crossIn = soldCum - soldPrev;
                soldPrev = soldCum;
                f[i].crossOut = FullMath.mulDiv(f[i].crossIn, t.price, ONE);
                t.earned += f[i].crossOut;
            } else {
                buyCum += o.amountIn;
                uint256 gotCum = FullMath.mulDiv(t.crossed, buyCum, t.buys);
                f[i].crossOut = gotCum - gotPrev;
                gotPrev = gotCum;
                uint256 paidCum = FullMath.mulDivRoundingUp(t.paid, buyCum, t.buys);
                f[i].crossIn = paidCum - paidPrev;
                paidPrev = paidCum;
            }
        }
    }

    /// @dev Step 3 (R1b): Swap-mode orders send what did not cross to the remainder pool. Only one side can have a
    /// remainder. If the unlock fails for any reason (a bound broken, a pool that cannot trade, an issuer block on the
    /// pool manager) the pool leg is skipped and every remainder is refunded.
    function _poolLeg(Entry[] storage os, Fill[] memory f, Totals memory t) private {
        bool sellSide = t.crossed < t.sells;
        if (!sellSide && t.paid >= t.buys) return; // nothing left on either side
        uint256 n;
        Leg[] memory legs = new Leg[](f.length);
        uint256[] memory idx = new uint256[](f.length);
        uint256 low = _bandLow(t.price);
        uint256 high = _bandHigh(t.price);
        for (uint256 i; i < f.length; ++i) {
            Order storage o = os[i].order;
            if (!f[i].live || o.mode != Mode.Swap || o.sellAsset != sellSide) continue;
            uint256 left = o.amountIn - f[i].crossIn;
            if (left == 0) continue;
            // the tighter of the order's own limit and the band
            legs[n] = sellSide
                ? Leg(left, o.limitPrice > low ? o.limitPrice : low, high)
                : Leg(left, low, o.limitPrice < high ? o.limitPrice : high);
            idx[n] = i;
            ++n;
        }
        if (n == 0) return;
        assembly ("memory-safe") {
            mstore(legs, n)
        }
        bytes32 slot = POOL_LEG_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        try IPoolManager(_poolManager).unlock(abi.encode(sellSide, legs)) returns (bytes memory ret) {
            (uint256[] memory ins, uint256[] memory outs) = abi.decode(ret, (uint256[], uint256[]));
            for (uint256 k; k < n; ++k) {
                Fill memory fl = f[idx[k]];
                fl.poolIn = ins[k];
                fl.poolOut = outs[k];
                if (sellSide) {
                    t.assetViaPool += ins[k];
                    t.usdgViaPool += outs[k];
                } else {
                    t.usdgViaPool += ins[k];
                    t.assetViaPool += outs[k];
                }
            }
        } catch {}
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @notice Pool manager callback for the pool leg of `clear`; refuses any other caller or moment.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        bytes32 slot = POOL_LEG_SLOT;
        bool inLeg;
        assembly ("memory-safe") {
            inLeg := tload(slot)
        }
        if (msg.sender != _poolManager || !inLeg) revert WrongPhase();
        (bool sellSide, Leg[] memory legs) = abi.decode(data, (bool, Leg[]));
        (PoolKey memory key,) = remainderPool();
        IPoolManager pm = IPoolManager(_poolManager);
        // selling the asset is zeroForOne when the asset is currency0
        bool zeroForOne = sellSide == _assetIs0;
        uint256[] memory ins = new uint256[](legs.length);
        uint256[] memory outs = new uint256[](legs.length);
        uint256 totalIn;
        uint256 totalOut;
        for (uint256 k; k < legs.length; ++k) {
            (ins[k], outs[k]) = _swapLeg(pm, key, legs[k], sellSide, zeroForOne);
            totalIn += ins[k];
            totalOut += outs[k];
        }
        (address tokenIn, address tokenOut) = sellSide ? (asset, usdg) : (usdg, asset);
        if (totalIn != 0) {
            pm.sync(Currency.wrap(tokenIn));
            if (!_tryCall(tokenIn, abi.encodeCall(IMarketToken.transfer, (address(pm), totalIn)))) {
                revert InexactTransfer();
            }
            pm.settle();
        }
        if (totalOut != 0) pm.take(Currency.wrap(tokenOut), address(this), totalOut);
        return abi.encode(ins, outs);
    }

    /// @dev One exact-input swap with a price limit derived from the leg's bound and the pool's fee; the realised price
    /// is then checked against both bounds (DP-11).
    function _swapLeg(IPoolManager pm, PoolKey memory key, Leg memory leg, bool sellSide, bool zeroForOne)
        private
        returns (uint256 amountIn, uint256 amountOut)
    {
        (uint160 sqrtNow,, uint24 protocolFee, uint24 lpFee) = pm.getSlot0(key.toId());
        uint256 fee = uint256(lpFee) + (zeroForOne ? protocolFee % 4096 : protocolFee >> 12);
        if (fee >= PIPS) return (0, 0);
        // marginal price bound: a seller needs low / (1 - fee), a buyer high * (1 - fee)
        uint256 bound = sellSide
            ? FullMath.mulDivRoundingUp(leg.low, PIPS, PIPS - fee)
            : FullMath.mulDiv(leg.high, PIPS - fee, PIPS);
        uint160 limit = _sqrtLimit(bound, zeroForOne);
        if (zeroForOne ? sqrtNow <= limit : sqrtNow >= limit) return (0, 0); // already past the bound
        BalanceDelta d = pm.swap(key, SwapParams(zeroForOne, -int256(leg.amountIn), limit), "");
        (int128 a0, int128 a1) = (d.amount0(), d.amount1());
        (int128 paidIn, int128 gotOut) = zeroForOne ? (a0, a1) : (a1, a0);
        amountIn = uint256(uint128(-paidIn));
        amountOut = uint256(uint128(gotOut));
        if (amountIn == 0) return (0, 0);
        // realised price in USDG base units per 1e18 asset base units, compared without division
        (uint256 usdgAmt, uint256 assetAmt) = sellSide ? (amountOut, amountIn) : (amountIn, amountOut);
        if (usdgAmt * ONE < leg.low * assetAmt || usdgAmt * ONE > leg.high * assetAmt) revert DeviationTooHigh();
    }

    /// @dev sqrtPriceX96 for a USDG-per-1e18-asset price, rounded toward the inside of the bound: up for a falling
    /// price (zeroForOne), down for a rising one; clamped to the pool's range.
    function _sqrtLimit(uint256 price, bool zeroForOne) private view returns (uint160) {
        if (price == 0) price = 1;
        // pool price is currency1 per currency0 in base units
        uint256 ratioX192 = _assetIs0 ? FullMath.mulDiv(price, 1 << 192, ONE) : FullMath.mulDiv(ONE, 1 << 192, price);
        uint256 s = Math.sqrt(ratioX192, zeroForOne ? Math.Rounding.Ceil : Math.Rounding.Floor);
        if (s <= TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE + 1;
        if (s >= TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }

    function _bandLow(uint256 price) private view returns (uint256) {
        return FullMath.mulDivRoundingUp(price, BPS - maxDeviationBps, BPS);
    }

    function _bandHigh(uint256 price) private view returns (uint256) {
        return FullMath.mulDiv(price, BPS + maxDeviationBps, BPS);
    }

    /// @dev Step 4: pay outputs and refunds, fees to the treasury, ORRY fees burned.
    function _settle(uint256 batch, Entry[] storage os, Fill[] memory f, Totals memory t) private {
        uint256 supplyBefore = IOrryToken(orry).totalSupply();
        for (uint256 i; i < f.length; ++i) {
            Fill memory fl = f[i];
            if (!fl.live) continue;
            Entry storage e = os[i];
            uint256 inputUsed = fl.crossIn + fl.poolIn;
            uint256 output;
            uint256 fee;
            uint256 orryFee;
            if (e.order.sellAsset) {
                uint256 earned = fl.crossOut + fl.poolOut;
                (fee, orryFee) = _fee(earned, fl);
                output = earned - fee;
                _pay(usdg, e.account, output);
                _pay(asset, e.account, e.order.amountIn - inputUsed);
            } else {
                output = fl.crossOut + fl.poolOut;
                (fee, orryFee) = _fee(inputUsed, fl);
                _pay(asset, e.account, output);
                _pay(usdg, e.account, fl.pulled - inputUsed - fee);
            }
            t.usdgFees += fee;
            if (orryFee != 0) {
                IOrryToken(orry).burnFrom(e.account, orryFee);
                t.orryBurned += orryFee;
            }
            if (inputUsed != 0) emit OrderFilled(batch, e.account, inputUsed, output, fee, orryFee);
        }
        if (supplyBefore - IOrryToken(orry).totalSupply() != t.orryBurned) revert InexactTransfer();
        if (t.orryBurned != 0) emit Burned(BURN_ORRY_FEE, t.orryBurned);
        // fees plus the rounding left over between what buyers paid and what sellers earned in the cross
        t.usdgFees += t.paid - t.earned;
        _pay(usdg, treasury, t.usdgFees);
    }

    /// @dev The fee of one filled notional: USDG, or ORRY (burned) when the order pays in ORRY.
    function _fee(uint256 notional, Fill memory fl) private view returns (uint256 usdgFee, uint256 orryFee) {
        uint256 fee = _usdFee(notional, fl.discount);
        if (!fl.inOrry) return (fee, 0);
        (, orryFee) = _orryFor(_orryDiscounted(fee));
        if (orryFee > fl.maxOrryFee) orryFee = fl.maxOrryFee; // covered at pull time; only rounding reaches it
    }

    function _usdFee(uint256 notional, uint16 discount) private view returns (uint256) {
        return FullMath.mulDiv(notional, uint256(feeBps) * (BPS - discount), BPS * BPS);
    }

    function _orryDiscounted(uint256 usdFee) private view returns (uint256) {
        return FullMath.mulDiv(usdFee, BPS - orryFeeDiscountBps, BPS);
    }

    function _discount(address account) private view returns (uint16) {
        try IFeeTiers(feeTiers).discountBps(account) returns (uint16 d) {
            return d > BPS ? uint16(BPS) : d;
        } catch {
            return 0;
        }
    }

    /// @dev ORRY worth `usd`, or not ok while the price is not ready. `usd = 0` only asks for readiness.
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

    function _pay(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (!_tryCall(token, abi.encodeCall(IMarketToken.transfer, (to, amount)))) revert InexactTransfer();
    }

    /// @dev A token call that succeeded and returned true or nothing.
    function _tryCall(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
