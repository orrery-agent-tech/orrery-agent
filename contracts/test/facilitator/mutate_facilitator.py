#!/usr/bin/env python3
"""Mutation check for wave 3's facilitator contracts (MerchantSplitter, MerchantSplitterFactory, X402Permit2Proxy), on the
pattern of test/orry/earn/mutate_earn.py.

Run from contracts/:  python3 test/facilitator/mutate_facilitator.py        (RANGE=0:10 python3 ... runs a slice)
Each mutation replaces one exact snippet, runs the facilitator tests, restores the source, and prints CAUGHT or MISSED.
The unmutated suite runs first and must pass, so a compile error that has nothing to do with a mutation can never count
as a catch.
"""
import os
import re
import subprocess
import sys
import time

TEST_ARGS = ["heavy", "forge", "test", "--match-path", "test/facilitator/**"]
S = "src/facilitator/MerchantSplitter.sol"
F = "src/facilitator/MerchantSplitterFactory.sol"
P = "src/facilitator/X402Permit2Proxy.sol"

MUTATIONS = [
    # ---------------------------------------------------------------- splitter: fee path
    (S, "USDG fee paid to the merchant", "IERC20(token).safeTransfer(f.treasury(), fee);", "IERC20(token).safeTransfer(m, fee);"),
    (S, "ORRY fee not burned", "                IOrryToken(token).burn(fee);\n", ""),
    (S, "burn event missing", "                emit Burned(BURN_SOURCE, fee);\n", ""),
    (S, "wrong burn source", "uint8 private constant BURN_SOURCE = 7;", "uint8 private constant BURN_SOURCE = 6;"),
    (S, "ORRY fee sent to the treasury", "            if (token == f.orry()) {", "            if (false) {"),
    (S, "merchant not paid", "        IERC20(token).safeTransfer(m, toMerchant);\n", ""),
    (S, "other tokens charged", "        if (token == f.usdg() || token == f.orry()) {", "        if (true) {"),
    (S, "ORRY carries no fee", "        if (token == f.usdg() || token == f.orry()) {", "        if (token == f.usdg()) {"),
    (S, "fee rounds up", "            fee = amount * bps / BPS;", "            fee = (amount * bps + BPS - 1) / BPS;"),
    (S, "fee in pips not bps", "            fee = amount * bps / BPS;", "            fee = amount * bps / 1_000_000;"),
    # ---------------------------------------------------------------- splitter: discount
    (S, "discount ignored", "uint256 bps = uint256(f.FEE_BPS()) * (BPS - discount) / BPS;", "uint256 bps = uint256(f.FEE_BPS());"),
    (S, "discount doubled", "uint256 bps = uint256(f.FEE_BPS()) * (BPS - discount) / BPS;", "uint256 bps = uint256(f.FEE_BPS()) * (BPS - (discount * 2 > BPS ? BPS : discount * 2)) / BPS;"),
    (S, "discount not clamped", "            d = v > BPS ? BPS : v;", "            d = v;"),
    (S, "failing tiers read blocks the forward", "        try IFeeTiers(tiers).discountBps(m) returns (uint16 v) {\n            d = v > BPS ? BPS : v;\n        } catch {}", "        uint16 v = IFeeTiers(tiers).discountBps(m);\n        d = v > BPS ? BPS : v;"),
    (S, "zero tiers address read", "        if (tiers == address(0)) return 0;\n", ""),
    (S, "Forwarded reports no discount", "emit Forwarded(token, toMerchant, fee, discount);", "emit Forwarded(token, toMerchant, fee, 0);"),
    (S, "previewForward reads no balance", "return _split(IMerchantSplitterFactory(factory), token, IERC20(token).balanceOf(address(this)));", "return _split(IMerchantSplitterFactory(factory), token, 0);"),
    # ---------------------------------------------------------------- splitter: initialization
    (S, "anyone reinitializes", "        if (factory != address(0)) revert AlreadyInitialized();\n", ""),
    (S, "implementation left open", "        factory = address(this);\n", ""),
    (S, "forward without a merchant", "        if (m == address(0)) revert NotFactory();\n", ""),
    (S, "empty forward passes", "        if (amount == 0) revert NothingToForward();\n", ""),
    # ---------------------------------------------------------------- factory
    (F, "fee cap raised", "if (feeBps > 100) revert FeeTooHigh();", "if (feeBps > 1000) revert FeeTooHigh();"),
    (F, "zero treasury accepted", " || treasury_ == address(0)) revert ZeroAddress();", ") revert ZeroAddress();"),
    (F, "zero merchant accepted", "        if (merchant == address(0)) revert ZeroAddress();\n", ""),
    (F, "second create allowed past the guard", "        if (isSplitter[splitterOf(merchant)]) revert SplitterExists();\n", ""),
    (F, "isSplitter not recorded", "        isSplitter[splitter] = true;\n", ""),
    (F, "splitter not initialized", "        IMerchantSplitter(splitter).initialize(merchant);\n", ""),
    (F, "splitter initialized to the caller", "IMerchantSplitter(splitter).initialize(merchant);", "IMerchantSplitter(splitter).initialize(msg.sender);"),
    (F, "address not keyed by the merchant", "splitter = Clones.cloneDeterministic(implementation, bytes32(uint256(uint160(merchant))));", "splitter = Clones.cloneDeterministic(implementation, bytes32(uint256(uint160(merchant)) + 1));"),
    (F, "SplitterCreated missing", "        emit SplitterCreated(merchant, splitter);\n", ""),
    # ---------------------------------------------------------------- proxy
    (P, "pays less than signed", "requestedAmount: permit.permitted.amount}", "requestedAmount: permit.permitted.amount / 2}"),
    (P, "witness names the payer", "keccak256(abi.encode(WITNESS_TYPEHASH, to))", "keccak256(abi.encode(WITNESS_TYPEHASH, from))"),
    (P, "zero payee accepted", "        if (to == address(0)) revert ZeroAddress();\n        permit2", "        permit2"),
    (P, "zero Permit2 accepted", "        if (permit2_ == address(0)) revert ZeroAddress();\n", ""),
    (P, "Paid event missing", "        emit Paid(permit.permitted.token, from, to, permit.permitted.amount, permit.nonce);\n", ""),
]

only = sys.argv[1:]  # optional substrings to run a subset
# optional RANGE=a:b (python slice of MUTATIONS) to split a run across copies of contracts/ in parallel
if os.environ.get("RANGE"):
    a, b = os.environ["RANGE"].split(":")
    MUTATIONS = MUTATIONS[int(a or 0):int(b) if b else None]
originals = {}
results = []
start = time.time()
if os.environ.get("BASELINE", "1") != "0":
    base = subprocess.run(TEST_ARGS, capture_output=True, text=True)
    if base.returncode != 0:
        print(base.stdout[-3000:] + base.stderr[-3000:])
        sys.exit("baseline: the unmutated suite does not pass; no mutation result would mean anything")
    print("baseline passes", flush=True)
try:
    for path, name, old, new in MUTATIONS:
        if only and not any(o in name for o in only):
            continue
        if path not in originals:
            originals[path] = open(path).read()
        src = originals[path]
        assert src.count(old) == 1, f"snippet must occur once for: {name} (found {src.count(old)})"
        open(path, "w").write(src.replace(old, new, 1))
        run = subprocess.run(TEST_ARGS, capture_output=True, text=True)
        out = run.stdout + run.stderr
        # non-greedy up to "] name(": a failure reason may itself hold brackets such as "[1e24]"
        failed = sorted(set(re.findall(r"^\[FAIL.*?\] (\w+)\(", out, re.M)))
        if not failed and re.search(r"Encountered a total of [1-9]\d* failing", out):
            failed = ["(unparsed failing test)"]
        compile_error = "Compiler run failed" in out
        results.append((name, failed, compile_error))
        open(path, "w").write(src)
        print(("CAUGHT  " if failed or compile_error else "MISSED  ") + name + (f"  by {', '.join(failed[:3])}" if failed else (" (compile error)" if compile_error else "")), flush=True)
finally:
    for path, src in originals.items():
        open(path, "w").write(src)

caught = sum(1 for _, f, c in results if f or c)
print(f"\n{caught}/{len(results)} mutations caught in {int(time.time() - start)} s")
sys.exit(0 if caught == len(results) else 1)
