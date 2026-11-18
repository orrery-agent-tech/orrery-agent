#!/usr/bin/env python3
"""Compares the ABI of each wave R1 market contract with the frozen ABI in services/packages/shared/src/markets-abi.ts.

Run from contracts/ after `forge build`: python3 test/markets/check_abi.py
Reads the build artifacts in out/. Functions, events and errors must match exactly. Allowed extras: the constructor, the
Uniswap v4 `unlockCallback` of the market's pool leg (as on lane B's OrryBuyback), and on OrryPriceOracle the hook's
`OracleNotReady` error it reverts with while not ready. `Burned` is part of the frozen ABI since D-R1-1.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TS = ROOT.parent / "services/packages/shared/src/markets-abi.ts"
PAIRS = {
    "SealedBatchMarket": "iSealedBatchMarketAbi",
    "MarketFactory": "iMarketFactoryAbi",
    "FeeTiers": "iFeeTiersAbi",
    "OrryPriceOracle": "iOrryPriceOracleAbi",
}
EXTRA_OK = {("constructor", ""), ("error", "OracleNotReady"), ("function", "unlockCallback")}


def frozen(name):
    m = re.search(r"export const " + name + r" = (\[.*?\]) as const;", TS.read_text(), re.S)
    return json.loads(m.group(1))


def sig(item):
    def t(p):
        if p["type"].startswith("tuple"):
            return "(" + ",".join(t(c) for c in p["components"]) + ")" + p["type"][5:]
        return p["type"]
    ins = ",".join(t(p) for p in item.get("inputs", []))
    outs = ",".join(t(p) for p in item.get("outputs", []))
    idx = ",".join(str(p.get("indexed", False)) for p in item.get("inputs", [])) if item["type"] == "event" else ""
    return (item["type"], item.get("name", ""), ins, outs, item.get("stateMutability", ""), idx)


ok = True
for contract, abi_name in PAIRS.items():
    built = json.loads((ROOT / "out" / f"{contract}.sol" / f"{contract}.json").read_text())["abi"]
    want = {sig(i) for i in frozen(abi_name)}
    have = {sig(i) for i in built}
    missing = want - have
    extra = {s for s in have - want if (s[0], s[1]) not in EXTRA_OK}
    status = "OK" if not (missing or extra) else "MISMATCH"
    ok &= status == "OK"
    allowed = sorted(f"{s[0]} {s[1]}" for s in have - want if (s[0], s[1]) in EXTRA_OK)
    print(f"{contract}: {status} ({len(want)} frozen entries; allowed extras: {', '.join(allowed) or 'none'})")
    for s in sorted(missing):
        print("  missing", s)
    for s in sorted(extra):
        print("  extra  ", s)
sys.exit(0 if ok else 1)
