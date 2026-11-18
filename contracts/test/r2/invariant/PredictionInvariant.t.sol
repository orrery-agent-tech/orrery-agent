// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PredictionBase} from "../utils/R2Base.sol";
import {PredictionMarket} from "../../../src/markets/r2/PredictionMarket.sol";
import {PredictionMarketFactory} from "../../../src/markets/r2/PredictionMarketFactory.sol";
import {IPredictionMarket} from "../../../src/markets/r2/interfaces/IPrediction.sol";
import {MockUsdg, MockFeed} from "../../markets/utils/MarketMocks.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";

/// @notice Bounded actions on several prediction markets with ghost accounting (`docs/updates/L3-R2-SPEC.md` 3.3).
contract PredictionHandler is Test {
    PredictionMarketFactory internal pmf;
    MockUsdg internal usdg;
    MockOrry internal orry;
    MockFeed internal feed;
    MockFeed internal ethFeed;
    address internal treasury;
    address[] internal actors;
    PredictionMarket[] public markets;
    uint256 public clock;

    struct Round {
        uint80 id;
        uint256 at;
        int256 answer;
    }

    Round[] internal rounds;

    // ghosts, per market
    mapping(address => uint256) public staked;
    mapping(address => uint256) public donated;
    mapping(address => uint256) public paidOut;
    mapping(address => uint256) public fees;
    mapping(address => uint256) public swept;
    mapping(address => mapping(address => bool)) public gotPaid;

    // counters for the deep run
    uint256 public nStakes;
    uint256 public nYes;
    uint256 public nNo;
    uint256 public nRefund;
    uint256 public nClaims;
    uint256 public nOrryClaims;
    uint256 public nSweeps;
    uint256 public nRejectedRounds;

    constructor(
        PredictionMarketFactory pmf_,
        MockUsdg usdg_,
        MockOrry orry_,
        MockFeed feed_,
        MockFeed ethFeed_,
        address treasury_,
        address[] memory actors_,
        uint256 start
    ) {
        (pmf, usdg, orry, feed, ethFeed, treasury, actors, clock) =
            (pmf_, usdg_, orry_, feed_, ethFeed_, treasury_, actors_, start);
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _market(uint256 seed) internal view returns (PredictionMarket m, bool ok) {
        if (markets.length == 0) return (m, false);
        return (markets[seed % markets.length], true);
    }

    function _tick(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
        ethFeed.push(2235e8, clock); // keeps the ORRY price ready for ORRY fees
    }

    // ------------------------------------------------------------------ actions

    function create(uint256 actorSeed, uint256 strikeSeed, uint256 durSeed) external {
        if (markets.length >= 40) return;
        int256 strike = int256(340e8 + (strikeSeed % 40) * 1e8);
        uint64 close = uint64(clock + 1 hours + (durSeed % 2 days));
        vm.prank(_actor(actorSeed));
        PredictionMarket m = PredictionMarket(pmf.create(address(feed), strike, close));
        markets.push(m);
        for (uint256 i; i < actors.length; ++i) {
            vm.startPrank(actors[i]);
            usdg.approve(address(m), type(uint256).max);
            orry.approve(address(m), type(uint256).max);
            vm.stopPrank();
        }
    }

    function stake(uint256 actorSeed, uint256 marketSeed, bool yes, uint256 amount) external {
        (PredictionMarket m, bool ok) = _market(marketSeed);
        if (!ok || clock >= m.lockTime()) return;
        amount = bound(amount, 1e6, 50_000e6);
        vm.prank(_actor(actorSeed));
        m.stake(yes, amount);
        staked[address(m)] += amount;
        ++nStakes;
    }

    function wait(uint256 secs) external {
        _tick(bound(secs, 1, 6 hours));
    }

    function publish(uint256 answerSeed) external {
        int256 answer = int256(330e8 + (answerSeed % 60) * 1e8);
        rounds.push(Round(feed.push(answer, clock), clock, answer));
        _tick(1);
    }

    /// @dev Settles with the right round when there is one, and first proves a wrong round is refused.
    function settle(uint256 marketSeed, uint256 wrongSeed) external {
        (PredictionMarket m, bool ok) = _market(marketSeed);
        if (!ok || m.status() != IPredictionMarket.Status.Open) return;
        uint64 close = m.closeTime();
        if (clock < close || clock >= close + 7 days) return;
        IPredictionMarket.Info memory info = m.info();
        if (info.yesPool == 0 || info.noPool == 0) {
            m.settle(0);
            ++nRefund;
            return;
        }
        uint256 first = type(uint256).max;
        for (uint256 i; i < rounds.length; ++i) {
            if (rounds[i].at >= close) {
                first = i;
                break;
            }
        }
        if (first == type(uint256).max) return;
        // a round other than the first after the close is refused and changes nothing
        uint256 wrong = wrongSeed % rounds.length;
        if (wrong != first) {
            try m.settle(rounds[wrong].id) {
                revert("wrong round accepted");
            } catch {
                ++nRejectedRounds;
            }
        }
        m.settle(rounds[first].id);
        IPredictionMarket.Status s = m.status();
        // PM-4
        if (rounds[first].answer > info.strike) {
            require(s == IPredictionMarket.Status.Yes, "PM-4 yes");
            ++nYes;
        } else {
            require(s == IPredictionMarket.Status.No, "PM-4 no");
            ++nNo;
        }
    }

    function expire(uint256 marketSeed) external {
        (PredictionMarket m, bool ok) = _market(marketSeed);
        if (!ok || m.status() != IPredictionMarket.Status.Open || clock < m.closeTime() + 7 days) return;
        m.expire();
        ++nRefund;
    }

    function claim(uint256 actorSeed, uint256 marketSeed, bool inOrry) external {
        (PredictionMarket m, bool ok) = _market(marketSeed);
        if (!ok) return;
        address a = _actor(actorSeed);
        uint256 gross = m.grossOf(a);
        if (gross == 0) {
            if (m.status() != IPredictionMarket.Status.Open && m.claimed(a)) {
                vm.prank(a);
                vm.expectRevert(IPredictionMarket.NothingToClaim.selector);
                m.claim(inOrry);
            }
            return;
        }
        require(!gotPaid[address(m)][a], "PM-3 paid twice");
        uint256 t = usdg.balanceOf(treasury);
        vm.prank(a);
        uint256 paid = m.claim(inOrry);
        gotPaid[address(m)][a] = true;
        paidOut[address(m)] += paid;
        fees[address(m)] += usdg.balanceOf(treasury) - t;
        require(paid + usdg.balanceOf(treasury) - t == gross, "gross = payout + usdg fee");
        ++nClaims;
        if (inOrry && paid == gross && m.status() != IPredictionMarket.Status.Refund) ++nOrryClaims;
    }

    function donate(uint256 marketSeed, uint256 amount) external {
        (PredictionMarket m, bool ok) = _market(marketSeed);
        if (!ok) return;
        amount = bound(amount, 1, 1_000e6);
        usdg.mint(address(m), amount);
        donated[address(m)] += amount;
    }

    function sweep(uint256 marketSeed) external {
        (PredictionMarket m, bool ok) = _market(marketSeed);
        if (!ok || m.status() == IPredictionMarket.Status.Open) return;
        if (usdg.balanceOf(address(m)) <= m.owed()) return;
        uint256 got = m.sweep();
        swept[address(m)] += got;
        ++nSweeps;
    }
}

contract PredictionInvariantTest is PredictionBase {
    PredictionHandler internal h;

    function setUp() public override {
        super.setUp();
        address[] memory a = new address[](5);
        for (uint256 i; i < 5; ++i) {
            a[i] = traders[i];
            usdg.mint(traders[i], 100_000_000e6);
        }
        h = new PredictionHandler(pmf, usdg, orry, feed, ethFeed, treasury, a, START);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = h.create.selector;
        sel[1] = h.stake.selector;
        sel[2] = h.stake.selector;
        sel[3] = h.wait.selector;
        sel[4] = h.publish.selector;
        sel[5] = h.settle.selector;
        sel[6] = h.claim.selector;
        sel[7] = h.claim.selector;
        sel[8] = h.donate.selector;
        sel[9] = h.sweep.selector;
        targetSelector(FuzzSelector(address(h), sel));
    }

    function _check() internal view {
        for (uint256 k; k < h.marketCount(); ++k) {
            PredictionMarket m = h.markets(k);
            address a = address(m);
            uint256 bal = usdg.balanceOf(a);
            assertGe(bal, m.owed(), "PM-1 solvency");
            assertEq(h.staked(a) + h.donated(a), h.paidOut(a) + h.fees(a) + h.swept(a) + bal, "PM-2 conservation");
            IPredictionMarket.Info memory i = m.info();
            assertEq(i.yesPool + i.noPool, h.staked(a), "pools = stakes");
        }
    }

    function invariant_solvency_and_conservation() public view {
        _check();
    }

    /// @dev Deterministic deep run: thousands of weighted actions, every invariant checked along the way, and every
    /// outcome reached at least once.
    function test_deep_run() public {
        uint256 seed = 0x5eed;
        for (uint256 step; step < 3000; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = seed % 100;
            uint256 a = seed >> 8;
            uint256 b = seed >> 40;
            uint256 c = seed >> 80;
            if (pick < 4) h.create(a, b, c);
            else if (pick < 34) h.stake(a, b, (c & 1) == 1, c % 20_000e6);
            else if (pick < 44) h.wait(c % 4 hours);
            else if (pick < 56) h.publish(b);
            else if (pick < 66) h.settle(a, b);
            else if (pick < 68) h.expire(a);
            else if (pick < 90) h.claim(a, b, (c & 1) == 1);
            else if (pick < 95) h.donate(a, c % 100e6);
            else h.sweep(a);
            if (step % 50 == 0) _check();
        }
        _check();
        console2.log("stakes", h.nStakes());
        console2.log("yes / no / refund", h.nYes(), h.nNo(), h.nRefund());
        console2.log("claims / in ORRY", h.nClaims(), h.nOrryClaims());
        console2.log("sweeps / wrong rounds refused", h.nSweeps(), h.nRejectedRounds());
        assertGt(h.nYes(), 0);
        assertGt(h.nNo(), 0);
        assertGt(h.nRefund(), 0);
        assertGt(h.nClaims(), 20);
        assertGt(h.nOrryClaims(), 0);
        assertGt(h.nSweeps(), 0);
        assertGt(h.nRejectedRounds(), 0);
    }
}
