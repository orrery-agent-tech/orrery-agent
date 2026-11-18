// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {SealedBatchMarket} from "../../../src/markets/SealedBatchMarket.sol";
import {MarketFactory} from "../../../src/markets/MarketFactory.sol";
import {FeeTiers} from "../../../src/markets/FeeTiers.sol";
import {OrryPriceOracle} from "../../../src/markets/OrryPriceOracle.sol";
import {MarketParams} from "../../../src/markets/MarketParams.sol";
import {ISealedBatchMarket} from "../../../src/markets/interfaces/ISealedBatchMarket.sol";
import {IChainlinkFeed} from "../../../src/markets/ChainlinkFeed.sol";
import {OrreryAttestor} from "../../../src/OrreryAttestor.sol";
import {IIdentityRegistry, IERC20Min} from "../../../src/interfaces/IExternal.sol";
import {OrreryTreasury} from "../../../src/orry/OrreryTreasury.sol";
import {MockOrry} from "../../orry/stake/utils/StakeMocks.sol";
import {MockEarningStaking, OracleHookStandIn} from "../../markets/utils/MarketMocks.sol";

interface IStock {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function paused() external view returns (bool);
    function pause() external;
    function oraclePaused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
    function uiMultiplier() external view returns (uint256);
    function mint(address, uint256) external;
}

interface IRegistry {
    function isBlocked(address) external view returns (bool);
    function blockAccounts(address[] calldata) external;
    function hasRole(bytes32, address) external view returns (bool);
    function paused() external view returns (bool);
}

interface IUsdg {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Wave R1 markets on a fork of Robinhood Chain 4663 (`docs/ORRY-R1-SPEC.md` 4): the real TSLA and AAPL stock
/// tokens, their real Chainlink feeds, real USDG, the real issuer registry exercised by impersonating its role holders
/// (block one trader, pause the asset), the real Chainlink ETH/USD feed for the ORRY price, and OrreryTreasury
/// receiving the fees. ORRY is a stand-in (not launched) and the hub's time-weighted price is the frozen-interface
/// stand-in until lane A's OrreryHook oracle lands. Forks only reach the latest block (the RPC keeps no history).
/// Run: forge test --match-path 'test/fork/markets/*' --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract MarketsForkTest is Test {
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address internal constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant REGISTRY = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address internal constant BLOCKER = 0x913cA87347391218e5De2C17c5A0AEba8B0b28fD;
    address internal constant TOKEN_PAUSER = 0xFCcF56B674113d9C4eb0F9B3370930ceD9E6Ab23;
    address internal constant MINTER = 0x13643b89b19245201b29d556EDDe5CF18f749C08;
    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;

    MockOrry internal orry;
    OracleHookStandIn internal hook;
    MockEarningStaking internal staking;
    FeeTiers internal tiers;
    OrryPriceOracle internal orryPrice;
    OrreryTreasury internal treasury;
    address internal ownerWallet = makeAddr("ownerWallet");

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of Robinhood Chain 4663");
        orry = new MockOrry(address(this), 1e27);
        hook = new OracleHookStandIn();
        hook.set(138200, block.timestamp - 2 hours);
        staking = new MockEarningStaking();
        uint256[] memory mins = new uint256[](2);
        uint16[] memory ds = new uint16[](2);
        (mins[0], mins[1], ds[0], ds[1]) = (100e6, 1_000e6, 2500, 5000);
        orryPrice = new OrryPriceOracle(address(hook), USDG, ETH_USD_FEED, 25 hours);
        tiers = new FeeTiers(address(staking), address(orryPrice), mins, ds);
        OrreryAttestor attestor =
            new OrreryAttestor(IIdentityRegistry(IDENTITY_REGISTRY), IERC20Min(USDG), address(this), ownerWallet, 5e6);
        address[] memory signers = new address[](1);
        signers[0] = makeAddr("quoteSigner");
        treasury = new OrreryTreasury(USDG, address(attestor), ownerWallet, 1000, signers);
        attestor.setTreasury(address(treasury));
    }

    function _params(uint32 maxStaleness) internal pure returns (MarketParams memory) {
        return MarketParams({
            commitSeconds: 240,
            revealSeconds: 60,
            feeBps: 15,
            minNotionalUsdg: 10e6,
            maxStaleness: maxStaleness,
            commitFeeUsd: 0.05e6,
            orryFeeDiscountBps: 2500,
            maxDeviationBps: 50
        });
    }

    function _market(address asset, address feed, uint32 maxStaleness) internal returns (SealedBatchMarket m) {
        PoolKey memory none;
        return _market(asset, feed, maxStaleness, none);
    }

    function _market(address asset, address feed, uint32 maxStaleness, PoolKey memory pool)
        internal
        returns (SealedBatchMarket m)
    {
        MarketFactory f = new MarketFactory(
            ownerWallet,
            USDG,
            address(treasury),
            address(tiers),
            address(orryPrice),
            address(orry),
            POOL_MANAGER,
            _params(maxStaleness)
        );
        vm.prank(ownerWallet);
        m = SealedBatchMarket(f.create(asset, feed, pool));
    }

    /// @dev The deepest plain stock/USDG pools found on 4663 (PoolManager `Initialize` logs, then StateView).
    function _spyPool() internal pure returns (PoolKey memory) {
        // SPY is currency0; fee 500, tick spacing 5, id 0xe5923c8a…f907, about 447,600 USDG per 1% at the scan
        return PoolKey(Currency.wrap(SPY), Currency.wrap(USDG), 500, 5, IHooks(address(0)));
    }

    function _aaplPool() internal pure returns (PoolKey memory) {
        // USDG is currency0; fee 3000, tick spacing 60, id 0xc748f467…8fdb, about 34,900 USDG per 1% at the scan
        return PoolKey(Currency.wrap(USDG), Currency.wrap(AAPL), 3000, 60, IHooks(address(0)));
    }

    function _trader(string memory name, address asset, address m) internal returns (address t) {
        t = makeAddr(name);
        vm.prank(MINTER); // the issuer's minter role on 4663, read from RoleGranted events
        IStock(asset).mint(t, 100e18);
        deal(USDG, t, 1_000_000e6);
        orry.transfer(t, 1_000_000e18);
        vm.startPrank(t);
        IStock(asset).approve(m, type(uint256).max);
        IUsdg(USDG).approve(m, type(uint256).max);
        orry.approve(m, type(uint256).max);
        vm.stopPrank();
    }

    function _latest(address feed) internal view returns (uint80 id, int256 answer, uint256 updatedAt) {
        (id, answer,, updatedAt,) = IChainlinkFeed(feed).latestRoundData();
    }

    function _place(SealedBatchMarket m, address[] memory who, ISealedBatchMarket.Order[] memory os)
        internal
        returns (uint256 batch)
    {
        (batch,,) = m.phase();
        for (uint256 i; i < who.length; ++i) {
            bytes32 c = m.commitmentFor(batch, who[i], os[i], keccak256(abi.encode(who[i])));
            vm.prank(who[i]);
            m.commit(c);
        }
        vm.warp(m.revealEnd(batch) - m.revealSeconds());
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            m.reveal(os[i], keccak256(abi.encode(who[i])));
        }
        vm.warp(m.revealEnd(batch));
    }

    function test_fork_reads_feeds_tokens_and_issuer_roles() public view {
        assertEq(IChainlinkFeed(TSLA_FEED).decimals(), 8);
        assertEq(IChainlinkFeed(AAPL_FEED).decimals(), 8);
        assertEq(IChainlinkFeed(ETH_USD_FEED).decimals(), 8);
        assertEq(IStock(TSLA).decimals(), 18);
        assertTrue(IRegistry(REGISTRY).hasRole(keccak256("BLOCKER_ROLE"), BLOCKER));
        assertTrue(IRegistry(REGISTRY).hasRole(keccak256("TOKEN_PAUSER_ROLE"), TOKEN_PAUSER));
        assertTrue(IRegistry(REGISTRY).hasRole(keccak256("MINTER_ROLE"), MINTER));
        (uint80 id, int256 a, uint256 u) = _latest(TSLA_FEED);
        console2.log("TSLA round", id);
        console2.log("TSLA answer (8 dec)", uint256(a));
        console2.log("TSLA age (s)", block.timestamp - u);
        (, a, u) = _latest(ETH_USD_FEED);
        console2.log("ETH/USD answer (8 dec)", uint256(a));
        console2.log("ETH/USD age (s)", block.timestamp - u);
        console2.log("TSLA uiMultiplier", IStock(TSLA).uiMultiplier());
        console2.log("AAPL uiMultiplier", IStock(AAPL).uiMultiplier());
        console2.log("AAPL effectiveAt", IStock(AAPL).effectiveAt());
        console2.log("AAPL oraclePaused", IStock(AAPL).oraclePaused());
    }

    /// @dev The market-hours rule: with the default 25 h staleness a batch cannot clear on a price older than that
    /// (weekends); during the week the same batch clears.
    function test_fork_default_staleness_follows_market_hours() public {
        SealedBatchMarket m = _market(TSLA, TSLA_FEED, 25 hours);
        address s = _trader("seller", TSLA, address(m));
        address b = _trader("buyer", TSLA, address(m));
        (uint80 id, int256 a, uint256 u) = _latest(TSLA_FEED);
        uint256 price = uint256(a) / 100;
        address[] memory who = new address[](2);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](2);
        (who[0], who[1]) = (s, b);
        os[0] = ISealedBatchMarket.Order(true, 1e18, 1, ISealedBatchMarket.Mode.Limit, false);
        os[1] = ISealedBatchMarket.Order(false, price, type(uint256).max, ISealedBatchMarket.Mode.Limit, false);
        uint256 batch = _place(m, who, os);
        uint256 age = m.revealEnd(batch) - u;
        console2.log("TSLA price age at reveal end (s)", age);
        if (age > 25 hours) {
            vm.expectRevert(ISealedBatchMarket.StalePrice.selector);
            m.clear(batch, id);
            console2.log("stale (weekend): batch cannot clear, nothing moved");
        } else {
            m.clear(batch, id);
            assertEq(m.result(batch).assetFilled, 1e18);
        }
        assertEq(IStock(TSLA).balanceOf(address(m)), 0);
        assertEq(IUsdg(USDG).balanceOf(address(m)), 0);
    }

    /// @dev Real fills with the real tokens, issuer block on one buyer, a revoked seller, fees into OrreryTreasury.
    /// The staleness bound is widened to 4 days so the latest round prices the batch on a weekend fork.
    function test_fork_clear_with_real_tokens_block_and_fees() public {
        SealedBatchMarket m = _market(TSLA, TSLA_FEED, 4 days);
        (uint80 id, int256 a,) = _latest(TSLA_FEED);
        uint256 price = uint256(a) / 100;
        address[] memory who = new address[](5);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](5);
        who[0] = _trader("s1", TSLA, address(m));
        who[1] = _trader("s2", TSLA, address(m));
        who[2] = _trader("b1", TSLA, address(m));
        who[3] = _trader("b2", TSLA, address(m));
        who[4] = _trader("blockedBuyer", TSLA, address(m));
        os[0] = ISealedBatchMarket.Order(true, 2e18, 1, ISealedBatchMarket.Mode.Limit, false);
        os[1] = ISealedBatchMarket.Order(true, 1e18, 1, ISealedBatchMarket.Mode.Swap, true); // fee in ORRY
        os[2] = ISealedBatchMarket.Order(false, 2 * price, type(uint256).max, ISealedBatchMarket.Mode.Limit, false);
        os[3] = ISealedBatchMarket.Order(false, price, type(uint256).max, ISealedBatchMarket.Mode.Limit, false);
        os[4] = ISealedBatchMarket.Order(false, price, type(uint256).max, ISealedBatchMarket.Mode.Limit, false);
        uint256 batch = _place(m, who, os);

        address[] memory blockList = new address[](1);
        blockList[0] = who[4];
        vm.prank(BLOCKER);
        IRegistry(REGISTRY).blockAccounts(blockList);
        assertTrue(IRegistry(REGISTRY).isBlocked(who[4]));
        vm.expectRevert(); // the real token refuses even a zero transfer to a blocked account
        IStock(TSLA).transfer(who[4], 0);

        uint256 usdgBlocked = IUsdg(USDG).balanceOf(who[4]);
        uint256 supply = orry.totalSupply();
        uint256 g = gasleft();
        m.clear(batch, id);
        console2.log("clear gas, 5 orders", g - gasleft());

        ISealedBatchMarket.BatchResult memory r = m.result(batch);
        assertEq(r.ordersDropped, 1, "blocked buyer dropped");
        assertEq(IUsdg(USDG).balanceOf(who[4]), usdgBlocked, "nothing pulled from the blocked buyer");
        assertEq(r.assetFilled, 3e18, "buyers take all 3 TSLA");
        assertEq(IStock(TSLA).balanceOf(who[2]), 102e18);
        assertEq(IStock(TSLA).balanceOf(who[3]), 101e18);
        assertGt(supply - orry.totalSupply(), 0, "ORRY fee burned");
        assertEq(supply - orry.totalSupply(), r.orryFeesBurned);
        assertEq(IStock(TSLA).balanceOf(address(m)), 0);
        assertEq(IUsdg(USDG).balanceOf(address(m)), 0);
        // fees reached the treasury, which splits them 10/90 like any revenue
        assertEq(IUsdg(USDG).balanceOf(address(treasury)), r.usdgFees);
        treasury.sync();
        assertEq(treasury.ownerAccrued(), r.usdgFees * 1000 / 10_000);
        console2.log("price (USDG per TSLA, 6 dec)", r.price);
        console2.log("USDG fees to the treasury", r.usdgFees);
        console2.log("ORRY fee burned", r.orryFeesBurned);
    }

    function test_fork_paused_asset_moves_nothing() public {
        SealedBatchMarket m = _market(TSLA, TSLA_FEED, 4 days);
        (uint80 id, int256 a,) = _latest(TSLA_FEED);
        address[] memory who = new address[](2);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](2);
        who[0] = _trader("s", TSLA, address(m));
        who[1] = _trader("b", TSLA, address(m));
        os[0] = ISealedBatchMarket.Order(true, 1e18, 1, ISealedBatchMarket.Mode.Limit, false);
        os[1] = ISealedBatchMarket.Order(false, uint256(a) / 100, type(uint256).max, ISealedBatchMarket.Mode.Limit, false);
        uint256 batch = _place(m, who, os);
        vm.prank(TOKEN_PAUSER);
        IStock(TSLA).pause();
        assertTrue(IStock(TSLA).paused());
        uint256 s0 = IStock(TSLA).balanceOf(who[0]);
        uint256 u1 = IUsdg(USDG).balanceOf(who[1]);
        m.clear(batch, id);
        assertEq(m.result(batch).ordersDropped, 2);
        assertEq(IStock(TSLA).balanceOf(who[0]), s0);
        assertEq(IUsdg(USDG).balanceOf(who[1]), u1);
    }

    /// @dev R1b on the real SPY pool (SPY is currency0): a Swap buyer alone buys through the pool, within the band.
    function test_fork_remainder_pool_spy_buy() public {
        SealedBatchMarket m = _market(SPY, SPY_FEED, 4 days, _spyPool());
        (uint80 id, int256 a,) = _latest(SPY_FEED);
        uint256 price = uint256(a) / 100;
        address[] memory who = new address[](1);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](1);
        who[0] = _trader("spyBuyer", SPY, address(m));
        os[0] = ISealedBatchMarket.Order(false, 10_000e6, type(uint256).max, ISealedBatchMarket.Mode.Swap, false);
        uint256 batch = _place(m, who, os);
        uint256 s0 = IStock(SPY).balanceOf(who[0]);
        uint256 u0 = IUsdg(USDG).balanceOf(who[0]);
        uint256 g = gasleft();
        m.clear(batch, id);
        console2.log("clear gas, one Swap buy through the SPY pool", g - gasleft());
        ISealedBatchMarket.BatchResult memory r = m.result(batch);
        console2.log("SPY feed price (USDG, 6 dec)", price);
        console2.log("USDG through the pool", r.usdgViaPool);
        console2.log("SPY bought (1e18)", r.assetViaPool);
        assertGt(r.assetViaPool, 0);
        assertEq(IStock(SPY).balanceOf(who[0]) - s0, r.assetViaPool);
        assertEq(u0 - IUsdg(USDG).balanceOf(who[0]), r.usdgViaPool + r.usdgViaPool * 15 / 10_000);
        // DP-11: realised USDG per SPY within 0.5% of the clearing price
        assertLe(r.usdgViaPool * 1e18 * 10_000, price * 10_050 * r.assetViaPool);
        assertGe(r.usdgViaPool * 1e18 * 10_000, price * 9_950 * r.assetViaPool);
        assertEq(IStock(SPY).balanceOf(address(m)), 0);
        assertEq(IUsdg(USDG).balanceOf(address(m)), 0);
    }

    /// @dev R1b on the real AAPL pool (USDG is currency0): a Swap seller alone sells through the pool, within the band.
    function test_fork_remainder_pool_aapl_sell() public {
        SealedBatchMarket m = _market(AAPL, AAPL_FEED, 4 days, _aaplPool());
        (uint80 id, int256 a,) = _latest(AAPL_FEED);
        uint256 price = uint256(a) / 100;
        address[] memory who = new address[](1);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](1);
        who[0] = _trader("aaplSeller", AAPL, address(m));
        os[0] = ISealedBatchMarket.Order(true, 5e18, 1, ISealedBatchMarket.Mode.Swap, false);
        uint256 batch = _place(m, who, os);
        uint256 u0 = IUsdg(USDG).balanceOf(who[0]);
        m.clear(batch, id);
        ISealedBatchMarket.BatchResult memory r = m.result(batch);
        console2.log("AAPL feed price (USDG, 6 dec)", price);
        console2.log("AAPL sold through the pool (1e18)", r.assetViaPool);
        console2.log("USDG received from the pool", r.usdgViaPool);
        assertGt(r.assetViaPool, 0);
        assertEq(IStock(AAPL).balanceOf(who[0]), 100e18 - r.assetViaPool);
        uint256 fee = r.usdgViaPool * 15 / 10_000;
        assertEq(IUsdg(USDG).balanceOf(who[0]) - u0, r.usdgViaPool - fee);
        assertGe(r.usdgViaPool * 1e18 * 10_000, price * 9_950 * r.assetViaPool);
        assertLe(r.usdgViaPool * 1e18 * 10_000, price * 10_050 * r.assetViaPool);
        assertEq(IStock(AAPL).balanceOf(address(m)), 0);
        assertEq(IUsdg(USDG).balanceOf(address(m)), 0);
    }

    /// @dev A full batch of 64 orders with the real tokens: the clear must fit well inside one block.
    function test_fork_gas_of_a_full_batch() public {
        SealedBatchMarket m = _market(AAPL, AAPL_FEED, 4 days);
        (uint80 id, int256 a,) = _latest(AAPL_FEED);
        uint256 price = uint256(a) / 100;
        address[] memory who = new address[](64);
        ISealedBatchMarket.Order[] memory os = new ISealedBatchMarket.Order[](64);
        for (uint256 i; i < 64; ++i) {
            who[i] = _trader(string(abi.encodePacked("t", vm.toString(i))), AAPL, address(m));
            os[i] = i % 2 == 0
                ? ISealedBatchMarket.Order(true, 1e18 + i, 1, ISealedBatchMarket.Mode.Limit, i % 4 == 0)
                : ISealedBatchMarket.Order(false, price + i, type(uint256).max, ISealedBatchMarket.Mode.Limit, i % 3 == 0);
        }
        uint256 batch = _place(m, who, os);
        uint256 g = gasleft();
        m.clear(batch, id);
        uint256 used = g - gasleft();
        console2.log("clear gas, 64 orders, real AAPL and USDG", used);
        assertLt(used, 20_000_000);
        assertEq(m.result(batch).ordersDropped, 0);
        assertEq(IStock(AAPL).balanceOf(address(m)), 0);
        assertEq(IUsdg(USDG).balanceOf(address(m)), 0);
    }
}
