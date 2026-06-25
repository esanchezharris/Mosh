#!/usr/bin/env python3
"""Unit test for the judge-panel reasoning readout (AL-006).

The Audiobox judge scores four aesthetic axes (PQ/CE/CU/PC). AL-006 surfaces the
judge's *reasoning* — a short, human-readable sentence — alongside the bare pq/pq_base
numbers in the generative drawer. The reasoning is synthesized by a pure function in
`quality_readout.judge_reasoning(...)` so it is dep-free and unit-testable here, and
shared by both the real Audiobox path (sa3/qa.py) and the fake adapter.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import quality_readout as qr  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── the reasoning helper exists and is callable ──
check("judge_reasoning is callable", callable(getattr(qr, "judge_reasoning", None)))

if callable(getattr(qr, "judge_reasoning", None)):
    # High PQ → reasoning mentions strong/good production quality.
    high = qr.judge_reasoning(axes={"PQ": 8.4, "CE": 7.1, "CU": 7.8, "PC": 5.0}, flags=[])
    check("high pq → non-empty string", isinstance(high, str) and len(high) > 0, repr(high))
    check("high pq reads positive", "strong" in high.lower() or "good" in high.lower() or "high" in high.lower(), high)

    # Low PQ → reasoning reads weak/poor.
    low = qr.judge_reasoning(axes={"PQ": 2.1, "CE": 2.0, "CU": 2.5, "PC": 1.0}, flags=[])
    check("low pq reads weak", "weak" in low.lower() or "poor" in low.lower() or "low" in low.lower(), low)
    check("high and low differ", high != low)

    # Flags get folded into the reasoning so the judge explains *why*.
    flagged = qr.judge_reasoning(axes={"PQ": 3.5, "CE": 4.0, "CU": 4.0, "PC": 3.0},
                                 flags=["clipping: peak -0.05 dBFS (4 samples at full scale)"])
    check("flag surfaces in reasoning", "clip" in flagged.lower(), flagged)

    # Robust to a missing-axes call (fake/heuristic path may pass only flags).
    only_flags = qr.judge_reasoning(axes=None, flags=["heavy_drive"])
    check("axes=None returns a string", isinstance(only_flags, str), repr(only_flags))

    # Robust to an empty call (no axes, no flags) — still a usable sentence.
    empty = qr.judge_reasoning(axes=None, flags=None)
    check("empty call returns a string", isinstance(empty, str) and len(empty) > 0, repr(empty))


print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
