// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {ILimitOrderBook} from "./interfaces/ILimitOrderBook.sol";
import {IFeeTiers, IOrryPriceOracle} from "../interfaces/IMarketPricing.sol";
import {IMarketFactory} from "../interfaces/IMarketFactory.sol";
import {ISealedBatchMarket} from "../interfaces/ISealedBatchMarket.sol";
import {IOrryToken} from "../../orry/interfaces/IOrryToken.sol";
import {IChainlinkFeed} from "../ChainlinkFeed.sol";

interface IBookToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IStockOracleViews {
    function oraclePaused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
}

/// @notice Signed limit orders on the stock tokens that wave R1 lists, filled whole through the asset's Uniswap v4 pool
/// and settled wallet to wallet (`docs/updates/L3-R2-SPEC.md` 4, L3-7 to L3-10).
/// @dev Limit orders that anyone may execute once the route meets the order's minimum, the executor earning a tip of
/// at most 1%. Nothing is escrowed (orders are EIP-712 signatures; the input is pulled from the owner's
/// wallet only inside the fill and every output is paid in the same transaction, custody pattern A), fills go through the
/// v4 pool that R1 lists for the asset instead of a V2 router, each fill must sit within `maxDeviationBps` of a fresh
/// Chainlink price so a keeper cannot push the pool to the limit and keep the gap, and a fee goes to the treasury in
/// USDG with the staker discount (L1, L2) or is burned in ORRY (L3, source 32). No owner, no pause, no setter.
contract LimitOrderBook is ILimitOrderBook, IUnlockCallback {
    uint16 public constant MAX_TIP_BPS = 100;
    uint16 private constant MAX_FEE_BPS = 50;
    uint16 private constant MAX_DEVIATION_BPS = 1000;
    uint256 private constant BPS = 10_000;
    uint256 private constant ONE = 1e18; // prices are per 1e18 asset base units
    uint8 private constant BURN_LIMIT_FEE = 32;
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,address asset,bool sellAsset,uint256 amountIn,uint256 limitPrice,uint16 tipBps,bool payFeeInOrry,uint256 nonce,uint64 expiry)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant LOCK_SLOT = keccak256("orrery.LimitOrderBook.lock");
    bytes32 private constant SWAP_SLOT = keccak256("orrery.LimitOrderBook.swap");

    address public immutable usdg;
    address public immutable marketFactory;
    address public immutable poolManager;
    address public immutable treasury;
    address public immutable feeTiers;
    address public immutable orryPrice;
    address public immutable orry;
    uint16 public immutable feeBps;
    uint16 public immutable maxDeviationBps;
    uint32 public immutable maxStaleness;
    uint16 public immutable orryFeeDiscountBps;
    uint256 private immutable _usdgUnit; // 10 ** usdg decimals
    uint256 private immutable _chainId;
    bytes32 private immutable _domainSeparator;

    mapping(address owner => mapping(uint256 nonce => bool)) public nonceUsed;

    /// @dev Working values of one fill.
    struct Fill {
        address market;
        PoolKey key;
        uint256 price; // oracle, USDG base units per 1e18 asset base units
        uint256 low; // lowest realised price accepted
        uint256 high; // highest realised price accepted
        uint256 discount;
        bool inOrry;
        uint256 pulled;
        uint256 out;
        uint256 notional; // USDG
        uint256 fee; // USDG paid to the treasury
        uint256 orryFee;
        uint256 tip;
    }

    constructor(
        address usdg_,
        address marketFactory_,
        address poolManager_,
        address treasury_,
        address feeTiers_,
        address orryPrice_,
        address orry_,
        uint16 feeBps_,
        uint16 maxDeviationBps_,
        uint32 maxStaleness_,
        uint16 orryFeeDiscountBps_
    ) {
        require(
            usdg_ != address(0) && marketFactory_ != address(0) && poolManager_ != address(0) && treasury_ != address(0)
                && feeTiers_ != address(0) && orryPrice_ != address(0) && orry_ != address(0),
            "zero address"
        );
        require(feeBps_ <= MAX_FEE_BPS, "fee");
        require(maxDeviationBps_ != 0 && maxDeviationBps_ <= MAX_DEVIATION_BPS, "deviation");
        require(maxStaleness_ != 0, "staleness");
        require(orryFeeDiscountBps_ <= BPS, "orry discount");
        uint256 d = IBookToken(usdg_).decimals();
        require(d <= 30, "decimals");
        usdg = usdg_;
        marketFactory = marketFactory_;
        poolManager = poolManager_;
        treasury = treasury_;
        feeTiers = feeTiers_;
        orryPrice = orryPrice_;
        orry = orry_;
        feeBps = feeBps_;
        maxDeviationBps = maxDeviationBps_;
        maxStaleness = maxStaleness_;
        orryFeeDiscountBps = orryFeeDiscountBps_;
        _usdgUnit = 10 ** d;
        _chainId = block.chainid;
        _domainSeparator = _buildDomain();
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

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _chainId ? _domainSeparator : _buildDomain();
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                o.owner,
                o.asset,
                o.sellAsset,
                o.amountIn,
                o.limitPrice,
                o.tipBps,
                o.payFeeInOrry,
                o.nonce,
                o.expiry
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function oraclePrice(address asset) public view returns (uint256) {
        (, uint256 price) = _listing(asset);
        return price;
    }

    // ------------------------------------------------------------------ cancel

    function cancel(uint256 nonce) external {
        _cancel(nonce);
    }

    function cancelMany(uint256[] calldata nonces) external {
        for (uint256 i; i < nonces.length; ++i) {
            _cancel(nonces[i]);
        }
    }

    function _cancel(uint256 nonce) private {
        if (nonceUsed[msg.sender][nonce]) revert NonceUsed();
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    // ------------------------------------------------------------------ fill

    function fill(Order calldata o, bytes calldata signature) external nonReentrant returns (uint256) {
        if (o.owner == address(0) || o.amountIn == 0 || o.limitPrice == 0 || o.tipBps > MAX_TIP_BPS) revert BadOrder();
        if (o.amountIn > type(uint128).max) revert BadOrder();
        if (block.timestamp > o.expiry) revert OrderExpired();
        if (nonceUsed[o.owner][o.nonce]) revert NonceUsed();
        bytes32 orderHash = hashOrder(o);
        if (!SignatureChecker.isValidSignatureNow(o.owner, orderHash, signature)) revert BadSignature();
        nonceUsed[o.owner][o.nonce] = true;

        Fill memory f;
        (f.market, f.price) = _listing(o.asset);
        (f.key,) = ISealedBatchMarket(f.market).remainderPool();
        f.low = FullMath.mulDivRoundingUp(f.price, BPS - maxDeviationBps, BPS);
        f.high = FullMath.mulDiv(f.price, BPS + maxDeviationBps, BPS);
        if (o.sellAsset) {
            if (o.limitPrice > f.low) f.low = o.limitPrice;
        } else if (o.limitPrice < f.high) {
            f.high = o.limitPrice;
        }
        if (f.low > f.high) revert NotFillable();
        f.discount = _discount(o.owner);
        f.inOrry = o.payFeeInOrry && _orryReady();

        uint256 assetBefore = IBookToken(o.asset).balanceOf(address(this));
        uint256 usdgBefore = IBookToken(usdg).balanceOf(address(this));
        if (o.sellAsset) {
            _pull(o.asset, o.owner, o.amountIn);
            f.out = _swap(f.key, o.asset, true, o.amountIn);
            // realised gross price within [low, high]
            if (f.out * ONE < f.low * o.amountIn || f.out * ONE > f.high * o.amountIn) revert NotFillable();
            f.notional = f.out;
            _fees(o, f);
            _pay(usdg, o.owner, f.out - f.fee - f.tip);
        } else {
            f.notional = o.amountIn;
            _fees(o, f);
            _pull(usdg, o.owner, o.amountIn + f.fee + f.tip);
            f.out = _swap(f.key, o.asset, false, o.amountIn);
            if (o.amountIn * ONE < f.low * f.out || o.amountIn * ONE > f.high * f.out) revert NotFillable();
            _pay(o.asset, o.owner, f.out);
        }
        _pay(usdg, treasury, f.fee);
        _pay(usdg, msg.sender, f.tip);
        if (f.orryFee != 0) {
            uint256 supply = IOrryToken(orry).totalSupply();
            IOrryToken(orry).burnFrom(o.owner, f.orryFee);
            if (supply - IOrryToken(orry).totalSupply() != f.orryFee) revert InexactTransfer();
            emit Burned(BURN_LIMIT_FEE, f.orryFee);
        }
        // X-1: a fill leaves the book's balances exactly as it found them
        if (
            IBookToken(o.asset).balanceOf(address(this)) != assetBefore
                || IBookToken(usdg).balanceOf(address(this)) != usdgBefore
        ) revert InexactTransfer();

        emit OrderFilled(
            orderHash, o.owner, o.asset, o.sellAsset, o.nonce, o.amountIn, f.out, f.fee, f.orryFee, f.tip, msg.sender
        );
        return f.out;
    }

    /// @dev Fee (USDG to the treasury, or ORRY burned) and tip on the USDG notional.
    function _fees(Order calldata o, Fill memory f) private view {
        uint256 fee = FullMath.mulDiv(f.notional, uint256(feeBps) * (BPS - f.discount), BPS * BPS);
        f.tip = FullMath.mulDiv(f.notional, o.tipBps, BPS);
        if (f.inOrry) {
            if (fee != 0) {
                f.orryFee = IOrryPriceOracle(orryPrice).orryFor(FullMath.mulDiv(fee, BPS - orryFeeDiscountBps, BPS));
            }
        } else {
            f.fee = fee;
        }
    }

    /// @dev The R1 market of `asset` and the fresh oracle price; reverts unless the asset is listed with a pool and its
    /// feed is fresh, positive and not interrupted by a corporate action.
    function _listing(address asset) private view returns (address market, uint256 price) {
        market = IMarketFactory(marketFactory).marketOf(asset);
        if (market == address(0)) revert NotListed();
        (, bool listed) = ISealedBatchMarket(market).remainderPool();
        if (!listed) revert NotListed();
        address feed = ISealedBatchMarket(market).priceFeed();
        (, int256 answer,, uint256 updatedAt,) = IChainlinkFeed(feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert StalePrice();
        if (block.timestamp - updatedAt > maxStaleness) revert StalePrice();
        try IStockOracleViews(asset).oraclePaused() returns (bool paused) {
            if (paused) revert StalePrice();
        } catch {}
        try IStockOracleViews(asset).effectiveAt() returns (uint256 effectiveAt) {
            if (effectiveAt > updatedAt && effectiveAt <= block.timestamp) revert StalePrice();
        } catch {}
        uint256 decimalsSum = uint256(IChainlinkFeed(feed).decimals()) + IBookToken(asset).decimals();
        price = FullMath.mulDiv(uint256(answer), _usdgUnit * ONE, 10 ** decimalsSum);
        if (price == 0) revert StalePrice();
    }

    // ------------------------------------------------------------------ pool

    /// @dev Exact-input swap of `amountIn` through `key`; reverts `NotFillable` unless all of it trades.
    function _swap(PoolKey memory key, address asset, bool sellAsset, uint256 amountIn) private returns (uint256 out) {
        bytes32 slot = SWAP_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        bytes memory ret = IPoolManager(poolManager).unlock(abi.encode(key, asset, sellAsset, amountIn));
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        out = abi.decode(ret, (uint256));
    }

    /// @notice Pool manager callback for `fill`; refuses any other caller or moment.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        bytes32 slot = SWAP_SLOT;
        bool inSwap;
        assembly ("memory-safe") {
            inSwap := tload(slot)
        }
        if (msg.sender != poolManager || !inSwap) revert WrongCaller();
        (PoolKey memory key, address asset, bool sellAsset, uint256 amountIn) =
            abi.decode(data, (PoolKey, address, bool, uint256));
        bool assetIs0 = Currency.unwrap(key.currency0) == asset;
        bool zeroForOne = sellAsset == assetIs0;
        IPoolManager pm = IPoolManager(poolManager);
        BalanceDelta d = pm.swap(
            key,
            SwapParams(
                zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        (int128 a0, int128 a1) = (d.amount0(), d.amount1());
        (int128 paidIn, int128 gotOut) = zeroForOne ? (a0, a1) : (a1, a0);
        if (paidIn >= 0 || uint256(uint128(-paidIn)) != amountIn || gotOut <= 0) revert NotFillable();
        uint256 out = uint256(uint128(gotOut));
        (address tokenIn, address tokenOut) = sellAsset ? (asset, usdg) : (usdg, asset);
        pm.sync(Currency.wrap(tokenIn));
        _pay(tokenIn, address(pm), amountIn);
        pm.settle();
        pm.take(Currency.wrap(tokenOut), address(this), out);
        return abi.encode(out);
    }

    // ------------------------------------------------------------------ helpers

    function _buildDomain() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("Orrery Limit Orders"), keccak256("1"), block.chainid, address(this)
            )
        );
    }

    function _discount(address account) private view returns (uint256) {
        try IFeeTiers(feeTiers).discountBps(account) returns (uint16 d) {
            return d > BPS ? BPS : d;
        } catch {
            return 0;
        }
    }

    function _orryReady() private view returns (bool) {
        try IOrryPriceOracle(orryPrice).ready() returns (bool isReady) {
            return isReady;
        } catch {
            return false;
        }
    }

    function _pull(address token, address from, uint256 amount) private {
        uint256 before = IBookToken(token).balanceOf(address(this));
        if (!_tryCall(token, abi.encodeCall(IBookToken.transferFrom, (from, address(this), amount)))) {
            revert InexactTransfer();
        }
        if (IBookToken(token).balanceOf(address(this)) - before != amount) revert InexactTransfer();
    }

    function _pay(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (!_tryCall(token, abi.encodeCall(IBookToken.transfer, (to, amount)))) revert InexactTransfer();
    }

    /// @dev A token call that succeeded and returned true or nothing.
    function _tryCall(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
