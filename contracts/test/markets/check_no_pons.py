#!/usr/bin/env python3
"""DP-10 (G-1, G-2) source check for the wave R1 markets (docs/ORRY-R1-SPEC.md 3), copied from lane B's check.

Run from contracts/: python3 test/markets/check_no_pons.py
Fails when a market source names a Pons address or a Pons fee call, or calls a mint function.
The bytecode-level check is test/markets/MarketsNoPons.t.sol.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = sorted((ROOT / "src/markets").glob("*.sol"))
PATTERNS = {
    "Pons V2 factory address": r"7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    "Pons FeeEscrow address": r"d3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
    "Pons MemeHook address": r"E5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
    "FeeEscrow-like interface": r"\bIFeeEscrow\b|\bFeeEscrow\b",
    "FeeEscrow claim calls": r"\.claim\s*\(|\.claimToken\s*\(|\.credit\s*\(|\.creditToken\s*\(",
    "MemeHook fee sweep": r"sweepPoolFees",
    "creator fee recipient calls": r"CreatorFeeRecipient",
    "mint call (G-2)": r"\.mint\s*\(|\bmint\s*\(",
}

bad = 0
for src in SOURCES:
    code = src.read_text()
    # comments may name Pons (they explain R-1); only code counts
    code = re.sub(r"//[^\n]*", "", code)
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    for what, pat in PATTERNS.items():
        for m in re.finditer(pat, code, flags=re.I):
            line = code[: m.start()].count("\n") + 1
            print(f"FAIL {src.name}: {what} at code line {line}: {m.group(0)}")
            bad += 1
print(f"{len(SOURCES)} sources, {len(PATTERNS)} patterns, {bad} hits")
sys.exit(1 if bad else 0)
