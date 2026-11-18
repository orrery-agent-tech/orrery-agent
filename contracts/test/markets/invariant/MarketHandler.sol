// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {SealedBatchMarket} from "../../../src/markets/SealedBatchMarket.sol";
import {ISealedBatchMarket} from "../../../src/markets/interfaces/ISealedBatchMarket.sol";
import {FeeTiers} from "../../../src/markets/FeeTiers.sol";
import {OrryPriceOracle} from "../../../src/markets/OrryPriceOracle.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {MockAccessRegistry, MockStock, MockUsdg, MockFeed, MockEarningStaking} from "../utils/MarketMocks.sol";

/// @notice Bounded handler for one market: traders commit, reveal, revoke, move balances, get blocked or frozen, the
/// issuer pauses, the oracle moves, anyone clears or expires. Every clear is checked against a model written from the
/// spec text (DP-2 to DP-8); DP-1 and G-2 are checked after every call by the invariant contract.
contract MarketHandler is Test {
    using StateLibrary for IPoolManager;
    struct Pending {
        ISealedBatchMarket.Order order;
        bytes32 salt;
        bool committed;
        bool revealed;
    }

    struct Snap {
        int256[] asset;
        int256[] usdg;
        int256[] orryBal;
        uint16[] discount;
        uint256 treasuryUsdg;
        uint256 supply;
        bool orryReady;
        int256 pmAsset;
        int256 pmUsdg;
    }

    bytes32 internal constant FILLED = keccak256("OrderFilled(uint256,address,uint256,uint256,uint256,uint256)");
    bytes32 internal constant DROPPED = keccak256("OrderDropped(uint256,address)");

    SealedBatchMarket public m;
    MockStock public stock;
    MockUsdg public usdg;
    MockOrry public orry;
    MockFeed public feed;
    MockFeed public ethFeed;
    MockAccessRegistry public registry;
    MockEarningStaking public staking;
    FeeTiers public tiers;
    OrryPriceOracle public orryPrice;
    address public treasury;
    address[] public actors;
    address public poolManager;
    PoolSwapTest public swapRouter;
    PoolKey internal _key;
    bool public listed;

    mapping(uint256 batch => mapping(address => Pending)) internal _pending;
    uint256[] internal _batches; // batches with at least one commit, in order
    mapping(uint256 => bool) internal _seen;
    uint256 internal _nextToSettle; // index into _batches
    uint256 internal _nonce;
    uint256 public lastSupply;

    // flags: a true flag is a broken invariant
    bool public badDP2;
    bool public badDP3;
    bool public badDP4;
    bool public badDP5;
    bool public badDP6;
    bool public badDP7;
    bool public badDP8;
    bool public badG2;
    bool public badDP11;

    // counts for the deep run
    uint256 public commits;
    uint256 public reveals;
    uint256 public clears;
    uint256 public batchesWithFills;
    uint256 public partialBatches;
    uint256 public fills;
    uint256 public orryFeeFills;
    uint256 public drops;
    uint256 public expiries;
    uint256 public refusedClears;
    uint256 public revealedInCleared;
    uint256 public batchesWithPoolFills;
    uint256 public poolFills;
    uint256 public poolPushes;

    constructor(
        SealedBatchMarket m_,
        MockStock stock_,
        MockUsdg usdg_,
        MockOrry orry_,
        MockFeed feed_,
        MockFeed ethFeed_,
        MockAccessRegistry registry_,
        MockEarningStaking staking_,
        FeeTiers tiers_,
        OrryPriceOracle orryPrice_,
        address treasury_,
        address[] memory actors_,
        PoolSwapTest swapRouter_,
        PoolKey memory key_
    ) {
        (m, stock, usdg, orry, feed, ethFeed) = (m_, stock_, usdg_, orry_, feed_, ethFeed_);
        (registry, staking, tiers, orryPrice, treasury) = (registry_, staking_, tiers_, orryPrice_, treasury_);
        actors = actors_;
        lastSupply = orry.totalSupply();
        swapRouter = swapRouter_;
        _key = key_;
        (, listed) = m.remainderPool();
        poolManager = address(swapRouter_.manager());
        stock.mint(address(this), 1_000_000e18);
        usdg.mint(address(this), 1_000_000_000e6);
        stock.approve(address(swapRouter_), type(uint256).max);
        usdg.approve(address(swapRouter_), type(uint256).max);
    }

    /// @dev Someone trades the remainder pool toward a price up to 3% from the feed: a market move or an attacker's push
    /// bundled with the next clear (DP-11).
    function poolPush(uint256 seed) public {
        if (!listed || stock.paused() || usdg.paused()) return;
        if (registry.isBlocked(poolManager)) return;
        // mostly a re-centre near the feed, sometimes a push well outside the band
        uint256 target = _price() * (seed % 4 == 0 ? _bound(seed >> 8, 9_700, 10_300) : _bound(seed >> 8, 9_970, 10_030))
            / 10_000;
        bool assetIs0 = address(stock) < address(usdg);
        uint256 ratio = assetIs0 ? target * 2 ** 192 / 1e18 : 1e18 * 2 ** 192 / target;
        uint160 sqrtTarget = uint160(Math.sqrt(ratio));
        (uint160 now_,,,) = IPoolManager(poolManager).getSlot0(PoolIdLibrary.toId(_key));
        if (sqrtTarget == now_) return;
        try swapRouter.swap(
            _key,
            SwapParams({zeroForOne: sqrtTarget < now_, amountSpecified: -int256(1e30), sqrtPriceLimitX96: sqrtTarget}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            poolPushes += 1;
        } catch {}
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _checkSupply() internal {
        uint256 s = orry.totalSupply();
        if (s > lastSupply) badG2 = true;
        lastSupply = s;
    }

    function _price() internal view returns (uint256) {
        (, int256 a,,,) = feed.latestRoundData();
        return a <= 0 ? 358_250000 : uint256(a) / 100;
    }

    // ------------------------------------------------------------------ trader actions

    /// @dev Up to three traders commit in one call, so batches carry several orders.
    function commit(uint256 actorSeed, uint256 amountSeed, uint256 limitSeed, uint256 flags) public {
        uint256 k = 1 + flags % 3;
        for (uint256 j; j < k; ++j) {
            _commitOne(actorSeed % 1000 + j, uint256(keccak256(abi.encode(amountSeed, j))), limitSeed >> (8 * j), flags >> j);
        }
    }

    function _commitOne(uint256 actorSeed, uint256 amountSeed, uint256 limitSeed, uint256 flags) internal {
        (uint256 batch, bool inCommit,) = m.phase();
        if (!inCommit) return;
        address a = _actor(actorSeed);
        Pending storage p = _pending[batch][a];
        if (p.committed) return;
        bool sell = flags % 2 == 0;
        uint256 price = _price();
        uint256 amount = sell ? _bound(amountSeed, 0.03e18, 40e18) : _bound(amountSeed, 10e6, 15_000e6);
        // most limits sit on the side of the price that crosses; some do not
        uint256 limit = (flags >> 8) % 10 == 0
            ? (sell ? 1 : type(uint256).max)
            : price * (sell ? _bound(limitSeed, 85, 103) : _bound(limitSeed, 97, 115)) / 100;
        ISealedBatchMarket.Order memory o = ISealedBatchMarket.Order(
            sell,
            amount,
            limit,
            (flags >> 16) % 2 == 0 ? ISealedBatchMarket.Mode.Limit : ISealedBatchMarket.Mode.Swap,
            (flags >> 24) % 3 == 0
        );
        bytes32 salt = keccak256(abi.encode(++_nonce, a));
        bytes32 c = m.commitmentFor(batch, a, o, salt);
        vm.prank(a);
        try m.commit(c) {
            p.order = o;
            p.salt = salt;
            p.committed = true;
            commits += 1;
            if (!_seen[batch]) {
                _seen[batch] = true;
                _batches.push(batch);
            }
        } catch {}
        _checkSupply();
    }

    /// @dev Reveals every pending order of the batch in its reveal window; one trader may stay silent, and one wrong
    /// reveal is tried (it must fail, DP-5).
    function reveal(uint256 actorSeed, uint256 bad) public {
        (uint256 batch, bool inCommit,) = m.phase();
        if (inCommit) {
            // move on to this batch's reveal window when it has commits (time only moves forward)
            if (!_seen[batch]) return;
            vm.warp(m.revealEnd(batch) - m.revealSeconds());
        }
        address silent = bad % 4 == 0 ? _actor(actorSeed) : address(0);
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            Pending storage p = _pending[batch][a];
            if (!p.committed || p.revealed || a == silent) continue;
            if (bad % 6 == 0 && i == actorSeed % actors.length) {
                ISealedBatchMarket.Order memory other = p.order;
                other.amountIn += 1;
                vm.prank(a);
                try m.reveal(other, p.salt) {
                    badDP5 = true;
                } catch {}
            }
            vm.prank(a);
            try m.reveal(p.order, p.salt) {
                p.revealed = true;
                reveals += 1;
            } catch {}
        }
    }

    function revoke(uint256 actorSeed, uint256 which) public {
        address a = _actor(actorSeed);
        uint256 amount = which % 4 == 0 ? 0 : type(uint256).max;
        vm.startPrank(a);
        if (which % 3 == 0) try stock.approve(address(m), amount) {} catch {}
        else if (which % 3 == 1) usdg.approve(address(m), amount);
        else orry.approve(address(m), amount);
        vm.stopPrank();
    }

    function move(uint256 fromSeed, uint256 toSeed, uint256 which) public {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        vm.startPrank(from);
        if (which % 2 == 0) try stock.transfer(to, stock.balanceOf(from) / 2) {} catch {}
        else try usdg.transfer(to, usdg.balanceOf(from) / 2) {} catch {}
        vm.stopPrank();
    }

    function issuer(uint256 actorSeed, uint256 action) public {
        address a = _actor(actorSeed);
        uint256 k = action % 10;
        if (k < 4) registry.setBlocked(a, !registry.isBlocked(a));
        else if (k < 7) usdg.setFrozen(a, !usdg.frozen(a));
        else if (k < 8) stock.setPaused(!stock.tokenPaused());
        else if (k < 9) stock.setOraclePaused(!stock.oraclePaused());
        else usdg.setPaused(!usdg.paused());
    }

    function oracle(uint256 moveSeed) public {
        uint256 k = moveSeed % 20;
        (, int256 last,,,) = feed.latestRoundData();
        int256 base = last <= 0 ? int256(358_25000000) : last;
        int256 next = k == 0 ? int256(0) : base * int256(_bound(moveSeed >> 8, 97, 103)) / 100;
        feed.push(next, _now());
        ethFeed.push(2235e8, _now());
    }

    function stake(uint256 actorSeed, uint256 level) public {
        uint256[3] memory levels = [uint256(0), 100_000e18, 1_000_000e18];
        staking.set(_actor(actorSeed), levels[level % 3]);
    }

    /// @dev Issuer pauses are short events: half of the warps lift them again.
    function _heal(uint256 seed) internal {
        if (seed % 2 != 0) return;
        if (stock.tokenPaused()) stock.setPaused(false);
        if (stock.oraclePaused()) stock.setOraclePaused(false);
        if (usdg.paused()) usdg.setPaused(false);
        // and one trader is cleared and approves again
        address a = _actor(seed >> 8);
        registry.setBlocked(a, false);
        usdg.setFrozen(a, false);
        vm.startPrank(a);
        stock.approve(address(m), type(uint256).max);
        usdg.approve(address(m), type(uint256).max);
        orry.approve(address(m), type(uint256).max);
        vm.stopPrank();
    }

    function warp(uint256 secs) public {
        _heal(secs >> 32);
        secs = secs % 40 == 0 ? _bound(secs, 1 hours, 30 hours) : _bound(secs, 1, 120);
        vm.warp(_now() + secs);
    }

    // ------------------------------------------------------------------ clearing

    /// @dev Clears the oldest unsettled batch whose reveal window has ended, with the right round, and checks it.
    function clearNext(uint256 seed) public {
        if (_nextToSettle >= _batches.length) return;
        uint256 batch = _batches[_nextToSettle];
        uint256 end = m.revealEnd(batch);
        if (_now() < end) {
            if (seed % 3 != 0) return;
            vm.warp(end); // a keeper waits for the window's end
        }
        ISealedBatchMarket.BatchResult memory before = m.result(batch);
        if (before.cleared) {
            _nextToSettle += 1;
            return;
        }
        (bool found, uint80 hint, int256 answer, uint256 updatedAt) = _roundFor(end);
        if (_now() >= end + m.EXPIRY()) {
            // DP-8: past expiry nothing clears
            if (found) {
                try m.clear(batch, hint) {
                    badDP8 = true;
                } catch {}
            }
            try m.expire(batch) {
                expiries += 1;
            } catch {}
            _nextToSettle += 1;
            return;
        }
        if (!found) return;
        if (seed % 7 == 0) _wrongHint(batch, hint);
        bool shouldClear = answer > 0 && end - updatedAt <= m.maxStaleness() && !stock.oraclePaused();
        Snap memory s = _snap();
        vm.recordLogs();
        try m.clear(batch, hint) {
            if (!shouldClear) badDP2 = true;
        } catch {
            if (shouldClear) badDP6 = true;
            refusedClears += 1;
            return;
        }
        clears += 1;
        _nextToSettle += 1;
        _check(batch, s, uint256(answer) / 100);
        // DP-8: once
        try m.clear(batch, hint) {
            badDP8 = true;
        } catch {}
        _checkSupply();
    }

    function _wrongHint(uint256 batch, uint80 hint) internal {
        if (hint > feed.FIRST()) {
            try m.clear(batch, hint - 1) {
                badDP2 = true;
            } catch {}
        }
        try m.clear(batch, feed.latestRoundId() + 1) {
            badDP2 = true;
        } catch {}
    }

    /// @dev The latest round with updatedAt <= end, found by scanning from the newest (model of DP-2).
    function _roundFor(uint256 end) internal view returns (bool, uint80, int256, uint256) {
        uint256 n = feed.roundCount();
        for (uint256 i = n; i != 0; --i) {
            uint80 id = feed.roundIdAt(i - 1);
            (, int256 a,, uint256 u,) = feed.getRoundData(id);
            if (u <= end) {
                // later rounds must all be after the end for this to be the hint the market accepts
                return (true, id, a, u);
            }
        }
        return (false, 0, 0, 0);
    }

    function _snap() internal view returns (Snap memory s) {
        uint256 n = actors.length;
        s.asset = new int256[](n);
        s.usdg = new int256[](n);
        s.orryBal = new int256[](n);
        s.discount = new uint16[](n);
        for (uint256 i; i < n; ++i) {
            s.asset[i] = int256(stock.balanceOf(actors[i]));
            s.usdg[i] = int256(usdg.balanceOf(actors[i]));
            s.orryBal[i] = int256(orry.balanceOf(actors[i]));
            s.discount[i] = tiers.discountBps(actors[i]);
        }
        s.treasuryUsdg = usdg.balanceOf(treasury);
        s.pmAsset = int256(stock.balanceOf(poolManager));
        s.pmUsdg = int256(usdg.balanceOf(poolManager));
        s.supply = orry.totalSupply();
        s.orryReady = orryPrice.ready();
    }

    function _index(address a) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == a) return i;
        }
        revert("not an actor");
    }

    struct Seen {
        bool filled;
        bool dropped;
        uint256 inputUsed;
        uint256 output;
        uint256 usdgFee;
        uint256 orryFee;
    }

    /// @dev Totals of one checked clear.
    struct Tally {
        uint256 price;
        uint256 sells;
        uint256 buys;
        uint256 crossed;
        uint256 paid;
        uint256 low; // band: clearing price minus maxDeviationBps
        uint256 high; // band: clearing price plus maxDeviationBps
        bool sellSide; // which side has a remainder
        uint256 poolAsset;
        uint256 poolUsdg;
        uint256 dropped;
    }

    function _check(uint256 batch, Snap memory s, uint256 price) internal {
        ISealedBatchMarket.BatchResult memory r = m.result(batch);
        if (r.price != price) badDP2 = true;
        Seen[] memory seen = _readLogs(batch);

        Tally memory t;
        t.price = price;
        t.crossed = r.assetFilled;
        t.paid = r.usdgFilled;
        t.low = (price * (10_000 - m.maxDeviationBps()) + 9_999) / 10_000;
        t.high = price * (10_000 + m.maxDeviationBps()) / 10_000;
        uint256 n = m.orderCount(batch);
        for (uint256 k; k < n; ++k) {
            (address a, ISealedBatchMarket.Order memory o) = m.orderAt(batch, k);
            Seen memory e = seen[_index(a)];
            bool meets = o.sellAsset ? price >= o.limitPrice : price <= o.limitPrice;
            if (e.dropped) t.dropped += 1;
            if (e.filled && (!meets || e.dropped)) badDP2 = true;
            if (!meets || e.dropped) {
                uint256 i = _index(a);
                if (stock.balanceOf(a) != uint256(s.asset[i]) || usdg.balanceOf(a) != uint256(s.usdg[i])) badDP3 = true;
                continue;
            }
            if (o.sellAsset) t.sells += o.amountIn;
            else t.buys += o.amountIn;
        }
        if (t.dropped != r.ordersDropped) badDP6 = true;

        // DP-4: A = min(sells, buys / price), U = ceil(A * price)
        uint256 affordable = t.price == 0 ? 0 : t.buys * 1e18 / t.price;
        uint256 expectCrossed = t.sells == 0 || t.buys == 0 ? 0 : (t.sells < affordable ? t.sells : affordable);
        if (t.crossed != expectCrossed) badDP4 = true;
        if (t.paid != (t.crossed * t.price + 1e18 - 1) / 1e18) badDP4 = true;
        t.sellSide = t.crossed < t.sells;

        _checkOrders(batch, seen, s, t);

        // DP-11 totals, DP-3 conservation over the actors, the treasury and the pool
        if (t.poolAsset != r.assetViaPool || t.poolUsdg != r.usdgViaPool) badDP11 = true;
        int256 assetSum;
        int256 usdgSum;
        int256 orrySum;
        for (uint256 i; i < actors.length; ++i) {
            assetSum += int256(stock.balanceOf(actors[i])) - s.asset[i];
            usdgSum += int256(usdg.balanceOf(actors[i])) - s.usdg[i];
            orrySum += s.orryBal[i] - int256(orry.balanceOf(actors[i]));
        }
        int256 toTreasury = int256(usdg.balanceOf(treasury)) - int256(s.treasuryUsdg);
        int256 pa = int256(r.assetViaPool);
        int256 pu = int256(r.usdgViaPool);
        (int256 wantAsset, int256 wantUsdg) = t.sellSide ? (-pa, pu) : (pa, -pu);
        if (assetSum != wantAsset || usdgSum + toTreasury != wantUsdg) badDP3 = true;
        if (int256(stock.balanceOf(poolManager)) - s.pmAsset != -wantAsset) badDP3 = true;
        if (int256(usdg.balanceOf(poolManager)) - s.pmUsdg != -wantUsdg) badDP3 = true;
        if (uint256(toTreasury) != r.usdgFees) badDP3 = true;
        if (s.supply - orry.totalSupply() != r.orryFeesBurned || uint256(orrySum) != r.orryFeesBurned) badDP3 = true;

        revealedInCleared += n;
        if (r.assetFilled != 0) batchesWithFills += 1;
        if (r.assetViaPool != 0) batchesWithPoolFills += 1;
        drops += t.dropped;
    }

    /// @dev Per live order: the model's running-total split of the cross (DP-4), the wallet deltas (DP-3), the pool part
    /// and its realised price (DP-11), and the fee (DP-7).
    function _checkOrders(uint256 batch, Seen[] memory seen, Snap memory s, Tally memory t) internal {
        uint256 sellCum;
        uint256 buyCum;
        uint256 soldPrev;
        uint256 gotPrev;
        uint256 paidPrev;
        bool partialFill;
        uint256 n = m.orderCount(batch);
        for (uint256 k; k < n; ++k) {
            (address a, ISealedBatchMarket.Order memory o) = m.orderAt(batch, k);
            uint256 i = _index(a);
            Seen memory e = seen[i];
            if (!(o.sellAsset ? t.price >= o.limitPrice : t.price <= o.limitPrice) || e.dropped) continue;
            uint256 crossIn;
            uint256 crossOut;
            if (o.sellAsset) {
                sellCum += o.amountIn;
                uint256 soldCum = t.crossed * sellCum / t.sells;
                crossIn = soldCum - soldPrev;
                soldPrev = soldCum;
                crossOut = crossIn * t.price / 1e18;
                // DP-4: within one base unit of the exact share
                uint256 lhs = crossIn * t.sells;
                uint256 rhs = t.crossed * o.amountIn;
                if ((lhs > rhs ? lhs - rhs : rhs - lhs) >= t.sells) badDP4 = true;
                if (crossIn < o.amountIn) partialFill = true;
            } else {
                buyCum += o.amountIn;
                uint256 gotCum = t.crossed * buyCum / t.buys;
                crossOut = gotCum - gotPrev;
                gotPrev = gotCum;
                uint256 paidCum = (t.paid * buyCum + t.buys - 1) / t.buys;
                crossIn = paidCum - paidPrev;
                paidPrev = paidCum;
                uint256 lhs = crossOut * t.buys;
                uint256 rhs = t.crossed * o.amountIn;
                if ((lhs > rhs ? lhs - rhs : rhs - lhs) >= t.buys) badDP4 = true;
            }
            _checkOrder(o, e, s, i, a, t, crossIn, crossOut);
        }
        if (partialFill) partialBatches += 1;
    }

    function _checkOrder(
        ISealedBatchMarket.Order memory o,
        Seen memory e,
        Snap memory s,
        uint256 i,
        address a,
        Tally memory t,
        uint256 crossIn,
        uint256 crossOut
    ) internal {
        int256 dAsset = int256(stock.balanceOf(a)) - s.asset[i];
        int256 dUsdg = int256(usdg.balanceOf(a)) - s.usdg[i];
        if (o.sellAsset) {
            if (dAsset != -int256(e.inputUsed) || dUsdg != int256(e.output)) badDP3 = true;
        } else {
            if (dAsset != int256(e.output) || dUsdg != -int256(e.inputUsed + e.usdgFee)) badDP3 = true;
        }
        if (e.inputUsed < crossIn) {
            badDP4 = true;
            return;
        }
        uint256 poolIn = e.inputUsed - crossIn;
        uint256 total = o.sellAsset ? e.output + e.usdgFee : e.output; // USDG earned or asset bought
        if (total < crossOut) {
            badDP3 = true;
            return;
        }
        uint256 poolOut = total - crossOut;
        if (poolIn == 0) {
            if (poolOut != 0) badDP3 = true;
        } else {
            // DP-11: only Swap orders on the side with a remainder, within their limit and the band
            if (!listed || o.mode != ISealedBatchMarket.Mode.Swap || o.sellAsset != t.sellSide) badDP11 = true;
            (uint256 usdgAmt, uint256 assetAmt) = o.sellAsset ? (poolOut, poolIn) : (poolIn, poolOut);
            uint256 low = o.sellAsset && o.limitPrice > t.low ? o.limitPrice : t.low;
            uint256 high = !o.sellAsset && o.limitPrice < t.high ? o.limitPrice : t.high;
            if (usdgAmt * 1e18 < low * assetAmt || usdgAmt * 1e18 > high * assetAmt) badDP11 = true;
            (t.poolAsset, t.poolUsdg) = (t.poolAsset + assetAmt, t.poolUsdg + usdgAmt);
            poolFills += 1;
        }
        if (!e.filled) return;
        fills += 1;
        uint256 notional = o.sellAsset ? total : e.inputUsed;
        uint256 usdFee = notional * m.feeBps() * (10_000 - s.discount[i]) / 1e8;
        bool inOrry = o.payFeeInOrry && s.orryReady && e.orryFee != 0;
        if (inOrry) {
            orryFeeFills += 1;
            if (e.usdgFee != 0 || e.orryFee != orryPrice.orryFor(usdFee * 7500 / 10_000)) badDP7 = true;
        } else if (e.usdgFee != usdFee || (e.orryFee != 0)) {
            // an ORRY order whose ORRY fee rounds to zero pays nothing in either coin
            if (!(o.payFeeInOrry && s.orryReady && e.usdgFee == 0 && usdFee * 7500 / 10_000 == 0)) badDP7 = true;
        }
    }

    function _readLogs(uint256 batch) internal returns (Seen[] memory seen) {
        seen = new Seen[](actors.length);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 j; j < logs.length; ++j) {
            Vm.Log memory l = logs[j];
            if (l.emitter != address(m) || l.topics.length < 3 || uint256(l.topics[1]) != batch) continue;
            uint256 i = _index(address(uint160(uint256(l.topics[2]))));
            if (l.topics[0] == FILLED) {
                if (seen[i].filled) badDP5 = true; // at most one fill per order
                seen[i].filled = true;
                (seen[i].inputUsed, seen[i].output, seen[i].usdgFee, seen[i].orryFee) =
                    abi.decode(l.data, (uint256, uint256, uint256, uint256));
            } else if (l.topics[0] == DROPPED) {
                if (seen[i].dropped) badDP6 = true;
                seen[i].dropped = true;
            }
        }
    }

    function expireAny(uint256 seed) public {
        if (_batches.length == 0) return;
        uint256 batch = _batches[seed % _batches.length];
        bool late = _now() >= m.revealEnd(batch) + m.EXPIRY();
        ISealedBatchMarket.BatchResult memory r = m.result(batch);
        try m.expire(batch) {
            if (!late || r.cleared) badDP8 = true;
            expiries += 1;
        } catch {}
    }
}
