#!/usr/bin/env python3
"""Mutation check for the wave R1 markets (SealedBatchMarket, MarketFactory, FeeTiers, OrryPriceOracle), on the pattern
of test/orry/stake/mutate_stake.py.

Run from contracts/:  python3 test/markets/mutate_markets.py
Each mutation replaces one exact snippet, runs the market unit tests and the deterministic deep run (not the long
invariant campaign, not the fork tests), restores the source, and prints CAUGHT or MISSED.
Parallel runs: copy contracts/ once per shard and set MUT_SHARD=i/n (and MUT_FROM=k to start at mutation k) in each.
MUT_PATH=FeeTiers (a file name part) runs only that contract's mutations.
OrrySystem.t.sol and the deploy script follow the multi-pair constructors on orry/pairs-int (lane A), so they are skipped.
"""
import os
import re
import subprocess
import sys

SKIP = ["--skip", "test/orry/integration/**", "--skip", "script/**"]
TEST_ARGS = ["heavy", "forge", "test", "--match-path", "test/markets/**", "--no-match-test", "invariant_"] + SKIP
M = "src/markets/SealedBatchMarket.sol"
F = "src/markets/MarketFactory.sol"
T = "src/markets/FeeTiers.sol"
O = "src/markets/OrryPriceOracle.sol"
P = "src/markets/MarketParams.sol"

MUTATIONS = [
    # ---------------------------------------------------------------- commit (DP-5, DP-7, G-2)
    (M, "zero commitment accepted", "if (commitment == bytes32(0)) revert ZeroAmount();", ""),
    (M, "commit outside the commit window", "if (!inCommit) revert WrongPhase();\n        if (_commitment", "if (_commitment"),
    (M, "second commit overwrites", "if (_commitment[batch][msg.sender] != bytes32(0)) revert AlreadyCommitted();", ""),
    (M, "batch cap off by one", "if (_commitCount[batch] >= MAX_ORDERS) revert BatchFull();", "if (_commitCount[batch] > MAX_ORDERS) revert BatchFull();"),
    (M, "commit fee not burned", "IOrryToken(orry).burnFrom(msg.sender, amount);\n                if", "if"),
    (M, "commit burn not supply checked", "if (supply - IOrryToken(orry).totalSupply() != amount) revert InexactTransfer();\n                burned", "burned"),
    (M, "commit fee burn source wrong", "emit Burned(BURN_COMMIT_FEE, amount);", "emit Burned(BURN_ORRY_FEE, amount);"),
    # ---------------------------------------------------------------- reveal (DP-5)
    (M, "reveal in the commit window", "if (inCommit) revert WrongPhase();\n        bytes32 c", "bytes32 c"),
    (M, "reveal does not open the commitment", "if (c == bytes32(0) || c != commitmentFor(batch, account, order, salt)) revert BadReveal();", "if (c == bytes32(0)) revert BadReveal();"),
    (M, "revealFor keyed by the sender", "_reveal(account, order, salt);\n    }\n\n    /// @dev The commitment binds", "_reveal(msg.sender, order, salt);\n    }\n\n    /// @dev The commitment binds"),
    (M, "reveal stored for the wrong account", "_orders[batch].push(Entry(account, order));", "_orders[batch].push(Entry(msg.sender, order));"),
    (M, "reveal twice", "delete _commitment[batch][account];", ""),
    (M, "zero amount revealed", "if (order.amountIn == 0 || order.limitPrice == 0) revert ZeroAmount();", "if (order.limitPrice == 0) revert ZeroAmount();"),
    (M, "minimum notional inclusive", "if (notional < minNotionalUsdg) revert BelowMinimum();", "if (notional + 1e5 < minNotionalUsdg) revert BelowMinimum();"),
    (M, "sell notional at the raw answer", "notional = FullMath.mulDiv(order.amountIn, _toPrice(answer), ONE);", "notional = order.amountIn;"),
    # ---------------------------------------------------------------- clear timing (DP-8)
    (M, "clear before the reveal window ends", "if (block.timestamp < end) revert WrongPhase();\n        BatchResult", "BatchResult"),
    (M, "clear twice", "if (r.cleared || _expired[batch]) revert AlreadyCleared();\n        if (block.timestamp >= end + EXPIRY)", "if (block.timestamp >= end + EXPIRY)"),
    (M, "clear after expiry", "if (block.timestamp >= end + EXPIRY) revert Expired();", ""),
    (M, "expire early", "if (block.timestamp < uint256(revealEnd(batch)) + EXPIRY) revert WrongPhase();", ""),
    (M, "expire a cleared batch", "if (_results[batch].cleared || _expired[batch]) revert AlreadyCleared();\n        _expired", "_expired"),
    (M, "commit window one second longer", "inCommit = t % len < commitSeconds;", "inCommit = t % len <= commitSeconds;"),
    # ---------------------------------------------------------------- price round (DP-2)
    (M, "round after the end accepted", "if (updatedAt == 0 || updatedAt > end) revert BadRound();", "if (updatedAt == 0) revert BadRound();"),
    (M, "older round accepted", "if (nextUpdatedAt <= end) revert BadRound();", ""),
    (M, "next round boundary off by one", "if (nextUpdatedAt <= end) revert BadRound();", "if (nextUpdatedAt < end) revert BadRound();"),
    (M, "missing next round accepted", "} catch {\n                revert BadRound();\n            }\n        }\n        if (end - updatedAt", "} catch {}\n        }\n        if (end - updatedAt"),
    (M, "staleness bound inclusive", "if (end - updatedAt > maxStaleness) revert StalePrice();", "if (end - updatedAt > maxStaleness + 1) revert StalePrice();"),
    (M, "oracle pause ignored", "if (paused) revert StalePrice();", ""),
    (M, "multiplier change ignored", "if (effectiveAt > updatedAt && effectiveAt <= block.timestamp) revert StalePrice();", ""),
    (M, "zero price accepted", "if (price == 0) revert StalePrice();", ""),
    (M, "negative answer accepted", "if (answer <= 0) revert StalePrice();", ""),
    # ---------------------------------------------------------------- pulls (DP-6, X-1)
    (M, "sell limit inclusive the wrong way", "if (o.sellAsset ? t.price < o.limitPrice : t.price > o.limitPrice) continue;", "if (o.sellAsset ? t.price <= o.limitPrice : t.price > o.limitPrice) continue;"),
    (M, "buy limit ignored", "if (o.sellAsset ? t.price < o.limitPrice : t.price > o.limitPrice) continue;", "if (o.sellAsset && t.price < o.limitPrice) continue;"),
    (M, "unfundable amount kept", "if (amountIn > MAX_AMOUNT) return false;", ""),
    (M, "orry fee cover not checked", "IOrryToken(orry).balanceOf(account) < maxOrry\n                        || IOrryToken(orry).allowance(account, address(this)) < maxOrry", "false"),
    (M, "receive probe removed", "if (!_tryCall(tokenOut, abi.encodeCall(IMarketToken.transfer, (account, 0)))) return false;", ""),
    (M, "buyer pull without the fee", "uint256 pull = o.sellAsset || fl.inOrry ? amountIn : amountIn + maxFee;", "uint256 pull = amountIn;"),
    (M, "failed pull reverts the batch", "if (!_tryCall(tokenIn, abi.encodeCall(IMarketToken.transferFrom, (account, address(this), pull)))) {\n            return false;\n        }", "if (!_tryCall(tokenIn, abi.encodeCall(IMarketToken.transferFrom, (account, address(this), pull)))) {\n            revert InexactTransfer();\n        }"),
    (M, "dropped order not counted", "t.dropped += 1;", ""),
    # ---------------------------------------------------------------- crossing and split (DP-3, DP-4)
    (M, "cross the larger side", "t.crossed = t.sells < affordable ? t.sells : affordable;", "t.crossed = t.sells > affordable ? t.sells : affordable;"),
    (M, "buyers pay rounded down", "t.paid = FullMath.mulDivRoundingUp(t.crossed, t.price, ONE);", "t.paid = FullMath.mulDiv(t.crossed, t.price, ONE);"),
    (M, "sellers split by the buy total", "uint256 soldCum = FullMath.mulDiv(t.crossed, sellCum, t.sells);", "uint256 soldCum = FullMath.mulDiv(t.crossed, sellCum, t.sells + 1);"),
    (M, "buyer split not cumulative", "f[i].crossOut = gotCum - gotPrev;", "f[i].crossOut = FullMath.mulDiv(t.crossed, o.amountIn, t.buys);"),
    (M, "buyer payment split rounded down", "uint256 paidCum = FullMath.mulDivRoundingUp(t.paid, buyCum, t.buys);", "uint256 paidCum = FullMath.mulDiv(t.paid, buyCum, t.buys);"),
    (M, "seller earns rounded up", "f[i].crossOut = FullMath.mulDiv(f[i].crossIn, t.price, ONE);", "f[i].crossOut = FullMath.mulDivRoundingUp(f[i].crossIn, t.price, ONE);"),
    (M, "unsold asset not refunded", "_pay(asset, e.account, e.order.amountIn - inputUsed);", ""),
    (M, "unspent USDG not refunded", "_pay(usdg, e.account, fl.pulled - inputUsed - fee);", ""),
    (M, "rounding dust kept", "t.usdgFees += t.paid - t.earned;", ""),
    (M, "fees kept by the market", "_pay(usdg, treasury, t.usdgFees);", ""),
    (M, "fill event for unfilled orders", "if (inputUsed != 0) emit OrderFilled", "emit OrderFilled"),
    # ---------------------------------------------------------------- fees (DP-7, G-2)
    (M, "fee discount ignored", "return FullMath.mulDiv(notional, uint256(feeBps) * (BPS - discount), BPS * BPS);", "return FullMath.mulDiv(notional, uint256(feeBps) * BPS, BPS * BPS);"),
    (M, "fee rounds up", "return FullMath.mulDiv(notional, uint256(feeBps) * (BPS - discount), BPS * BPS);", "return FullMath.mulDivRoundingUp(notional, uint256(feeBps) * (BPS - discount), BPS * BPS);"),
    (M, "orry fee discount ignored", "return FullMath.mulDiv(usdFee, BPS - orryFeeDiscountBps, BPS);", "return usdFee;"),
    (M, "orry fee not burned", "IOrryToken(orry).burnFrom(e.account, orryFee);", ""),
    (M, "clear burn not supply checked", "if (supplyBefore - IOrryToken(orry).totalSupply() != t.orryBurned) revert InexactTransfer();", ""),
    (M, "orry fee burn source wrong", "emit Burned(BURN_ORRY_FEE, t.orryBurned);", "emit Burned(BURN_COMMIT_FEE, t.orryBurned);"),
    (M, "orry fee also charged in usdg", "if (!fl.inOrry) return (fee, 0);", "if (!fl.inOrry) return (fee, 0);\n        usdgFee = fee;"),
    (M, "tier discount read fails open", "} catch {\n            return 0;\n        }\n    }\n\n    /// @dev ORRY worth", "} catch {\n            return uint16(BPS);\n        }\n    }\n\n    /// @dev ORRY worth"),
    # ---------------------------------------------------------------- remainder pool (R1b, DP-11)
    (M, "band ignored on the low side", "return FullMath.mulDivRoundingUp(price, BPS - maxDeviationBps, BPS);", "return FullMath.mulDivRoundingUp(price, BPS - 5 * maxDeviationBps, BPS);"),
    (M, "band ignored on the high side", "return FullMath.mulDiv(price, BPS + maxDeviationBps, BPS);", "return FullMath.mulDiv(price, BPS + 5 * maxDeviationBps, BPS);"),
    (M, "seller pool limit ignores the order limit", "? Leg(left, o.limitPrice > low ? o.limitPrice : low, high)", "? Leg(left, low, high)"),
    (M, "buyer pool limit ignores the order limit", ": Leg(left, low, o.limitPrice < high ? o.limitPrice : high);", ": Leg(left, low, high);"),
    (M, "realised price guard removed", "if (usdgAmt * ONE < leg.low * assetAmt || usdgAmt * ONE > leg.high * assetAmt) revert DeviationTooHigh();", ""),
    (M, "favourable side unchecked", " || usdgAmt * ONE > leg.high * assetAmt) revert DeviationTooHigh();", ") revert DeviationTooHigh();"),
    (M, "swap without a price limit", "BalanceDelta d = pm.swap(key, SwapParams(zeroForOne, -int256(leg.amountIn), limit), \"\");", "BalanceDelta d = pm.swap(key, SwapParams(zeroForOne, -int256(leg.amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), \"\");"),
    (M, "pool fee not in the limit", "uint256 bound = sellSide\n            ? FullMath.mulDivRoundingUp(leg.low, PIPS, PIPS - fee)\n            : FullMath.mulDiv(leg.high, PIPS - fee, PIPS);", "uint256 bound = sellSide ? leg.low : leg.high;"),
    (M, "limit already passed still swaps", "if (zeroForOne ? sqrtNow <= limit : sqrtNow >= limit) return (0, 0); // already past the bound", ""),
    (M, "limit-mode orders use the pool", "if (!f[i].live || o.mode != Mode.Swap || o.sellAsset != sellSide) continue;", "if (!f[i].live || o.sellAsset != sellSide) continue;"),
    (M, "both sides sent to the pool", "if (!f[i].live || o.mode != Mode.Swap || o.sellAsset != sellSide) continue;", "if (!f[i].live || o.mode != Mode.Swap) continue;"),
    (M, "a failed pool leg reverts the clear", "} catch {}\n        assembly (\"memory-safe\") {\n            tstore(slot, 0)", "} catch {\n            revert DeviationTooHigh();\n        }\n        assembly (\"memory-safe\") {\n            tstore(slot, 0)"),
    (M, "callback open to anyone", "if (msg.sender != _poolManager || !inLeg) revert WrongPhase();", ""),
    (M, "callback outside a clear", "if (msg.sender != _poolManager || !inLeg) revert WrongPhase();", "if (msg.sender != _poolManager) revert WrongPhase();"),
    (M, "pool output not counted", "fl.poolOut = outs[k];", ""),
    (M, "pool currencies unchecked", "require(\n                Currency.unwrap(remainderPool_.currency0) == c0 && Currency.unwrap(remainderPool_.currency1) == c1,\n                \"pool currencies\"\n            );", ""),
    (M, "hooked pool accepted", "require(address(remainderPool_.hooks) == address(0), \"pool hooks\");", ""),
    (M, "seller orry cover ignores the band", "uint256 sellPrice = _listed && o.mode == Mode.Swap ? _bandHigh(price) : price;", "uint256 sellPrice = price;"),
    (P, "deviation cap removed", "require(p.maxDeviationBps <= MAX_DEVIATION_BPS, \"deviation\");", ""),
    (F, "pool id not reported", "Currency.unwrap(remainderPool.currency1) == address(0) ? bytes32(0) : PoolId.unwrap(remainderPool.toId());", "bytes32(0);"),
    (F, "deviation passed as zero", "maxDeviationBps: _maxDeviationBps", "maxDeviationBps: 0"),
    # ---------------------------------------------------------------- parameters
    (P, "fee cap raised", "uint16 constant MAX_MARKET_FEE_BPS = 50;", "uint16 constant MAX_MARKET_FEE_BPS = 51;"),
    (P, "short windows accepted", "require(p.commitSeconds >= 60 && p.revealSeconds >= 60, \"windows\");", "require(p.commitSeconds >= 60, \"windows\");"),
    # ---------------------------------------------------------------- factory (DP-9, X-3)
    (F, "second market per asset", "if (existing != address(0)) revert MarketExists(existing);", ""),
    (F, "anyone creates", "        external\n        onlyOwner\n        returns (address market)", "        external\n        returns (address market)"),
    (F, "acceptOwnership by anyone", "if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();", ""),
    (F, "market not recorded", "marketOf[asset] = market;", ""),
    (F, "fee passed as zero", "feeBps: _feeBps,", "feeBps: 0,"),
    (F, "reveal window from the commit one", "revealSeconds: _revealSeconds,", "revealSeconds: _commitSeconds,"),
    # ---------------------------------------------------------------- fee tiers (DP-7; USD thresholds, utility 10)
    (T, "tier threshold exclusive", "if (usd >= _tiers[i - 1].minStakeUsd) return _tiers[i - 1].discountBps;", "if (usd > _tiers[i - 1].minStakeUsd) return _tiers[i - 1].discountBps;"),
    (T, "lowest tier wins", "for (uint256 i = _tiers.length; i != 0; --i) {", "for (uint256 i = 1; i <= _tiers.length; ++i) {"),
    (T, "unordered tiers accepted", "require(minStakesUsd[i] > minStakesUsd[i - 1] && discounts[i] >= discounts[i - 1], \"unordered tiers\");", "true;"),
    (T, "discount above 100% accepted", "require(minStakesUsd[i] != 0 && discounts[i] <= 10_000, \"bad tier\");", "require(minStakesUsd[i] != 0, \"bad tier\");"),
    (T, "tiers compare ORRY, not USD", "uint256 usd = stakeUsd(account);", "uint256 usd = IOrryStaking(staking).earningBalance(account);"),
    (T, "discount while the oracle is not ready", "if (!isReady) return 0;", ""),
    (T, "stake valued at a fixed price", "try IOrryPriceOracle(orryPrice).usdValue(balance) returns (uint256 usd) {\n            return usd;", "try IOrryPriceOracle(orryPrice).usdValue(1e18) returns (uint256 usd) {\n            return usd * (balance / 1e18);"),
    # ---------------------------------------------------------------- ORRY price (G-2 via fees; R-35 source order)
    (O, "orryFor rounds down", "? FullMath.mulDivRoundingUp(ratio, quoteAmount, 1 << 192)\n            : FullMath.mulDivRoundingUp(ratio, quoteAmount, 1 << 128);", "? FullMath.mulDiv(ratio, quoteAmount, 1 << 192)\n            : FullMath.mulDiv(ratio, quoteAmount, 1 << 128);"),
    (O, "eth needed rounds down", "uint256 quoteAmount = src == SOURCE_USDG_HUB ? usd : FullMath.mulDivRoundingUp(usd, _usdScale, ethUsd);", "uint256 quoteAmount = src == SOURCE_USDG_HUB ? usd : FullMath.mulDiv(usd, _usdScale, ethUsd);"),
    (O, "stale ETH price accepted", "if (block.timestamp - updatedAt > _maxEthStaleness) return (false, 0);", ""),
    (O, "zero ETH price accepted", "if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);", "if (updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);"),
    (O, "future ETH round accepted", "if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);", "if (a <= 0 || updatedAt == 0) return (false, 0);"),
    (O, "short window", "uint32 public constant WINDOW = 1800;", "uint32 public constant WINDOW = 600;"),
    (O, "price inverted on the X192 path", "? FullMath.mulDiv(orryAmount, 1 << 192, ratio)", "? FullMath.mulDiv(orryAmount, ratio, 1 << 192)"),
    (O, "X128 path scaled wrong", "return (FullMath.mulDiv(sqrtP, sqrtP, 1 << 64), false);", "return (FullMath.mulDiv(sqrtP, sqrtP, 1 << 63), false);"),
    (O, "ETH path without the feed", "return src == SOURCE_USDG_HUB ? quoteAmount : FullMath.mulDiv(quoteAmount, ethUsd, _usdScale);", "return quoteAmount;"),
    (O, "USDG hub not preferred", "(ok, tick) = _orryPerQuoteTick(usdg);\n        if (ok) return (SOURCE_USDG_HUB, tick, 0);", "ok = false;"),
    (O, "source view ignores the USDG hub", "(bool ok,) = _orryPerQuoteTick(usdg);\n        if (ok) return SOURCE_USDG_HUB;", "bool ok;"),
    (O, "orientation not flipped", "return (true, p.orryIsCurrency0 ? -meanTick : meanTick);", "return (true, meanTick);"),
    (O, "uninitialized hub used", "if (!p.initialized) return (false, 0);", ""),
    (O, "ETH path ignores a stale feed", "if (!ok || !fresh) revert IOrreryHook.OracleNotReady();", "if (!ok) revert IOrreryHook.OracleNotReady();"),
    (O, "ready ignores the feed on the ETH path", "return fresh ? SOURCE_ETH_HUB : SOURCE_NONE;", "return SOURCE_ETH_HUB;"),
]

originals = {}
results = []
only = sys.argv[1] if len(sys.argv) > 1 else None
shard_i, shard_n = (int(x) for x in os.environ.get("MUT_SHARD", "0/1").split("/"))
start = int(os.environ.get("MUT_FROM", "0"))
path_filter = os.environ.get("MUT_PATH", "")
try:
    for idx, (path, name, old, new) in enumerate(MUTATIONS):
        if only and only not in name:
            continue
        if path_filter and path_filter not in path:
            continue
        if idx < start or idx % shard_n != shard_i:
            continue
        if path not in originals:
            originals[path] = open(path).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(path, "w").write(src.replace(old, new, 1))
        run = subprocess.run(TEST_ARGS, capture_output=True, text=True)
        out = run.stdout + run.stderr
        # a failure reason may itself contain "]" (forge prints large numbers as "123 [1.2e2]"), so match up to the test name
        failed = sorted(set(re.findall(r"^\[FAIL.*?\]\s+(\w+)\(", out, re.M)))
        compile_error = "Compiler run failed" in out
        results.append((name, failed, compile_error))
        open(path, "w").write(src)
        print(f"{idx:3d} " + ("CAUGHT  " if failed or compile_error else "MISSED  ") + name
              + (f"  by {', '.join(failed[:3])}" if failed else (" (compile error)" if compile_error else "")), flush=True)
finally:
    for path, src in originals.items():
        open(path, "w").write(src)

caught = sum(1 for _, f, c in results if f or c)
print(f"\n{caught}/{len(results)} mutations caught")
sys.exit(0 if caught == len(results) else 1)
