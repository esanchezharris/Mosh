#!/usr/bin/env python3
"""Golden tests for stable_audio3_adapter.clamp_nl (05 §6) — HERMETIC: pure float
math, no MLX (the heavy imports live inside render()/available(), not at module top).
3× deterministic.

clamp_nl is the AUTHORITATIVE re-imagine noise guard. It rejects a degenerate
sub-NL_MIN nl (a near-identity no-op) in BOTH modes; clamps to NL_MAX_RECOGNIZABLE
(0.5) in normal mode so a whole-clip re-imagine stays recognizable AND never triggers
the onset-prior per-window pulse (measured 2026-07-17: the pulse reasserts at nl>=0.7);
and in Lab passes the raw value through UNCLAMPED (the ASTD "unlock the raw range"
posture — nl=1.0 == generate-from-scratch; nl>1.0 is degenerate but the user's call).

Run:  python3 service/adapters/stable_audio3_adapter_test.py    (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))   # service/ on the path

from adapters import stable_audio3_adapter as A  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _raises(nl, lab):
    try:
        A.clamp_nl(nl, lab)
        return False
    except ValueError:
        return True


# ── normal mode: the 0.5 recognizability / no-pulse guard ─────────────────────
check("normal keeps an in-range nl (0.4 -> 0.4)", abs(A.clamp_nl(0.4, False) - 0.4) < 1e-9)
check("normal clamps nl above 0.5 down to 0.5 (0.7 -> 0.5)", abs(A.clamp_nl(0.7, False) - 0.5) < 1e-9)
check("normal clamps to NL_MAX_RECOGNIZABLE exactly", abs(A.clamp_nl(0.9, False) - A.NL_MAX_RECOGNIZABLE) < 1e-9)

# ── Lab: uncapped pass-through (no 1.0 ceiling) ───────────────────────────────
check("Lab passes 0.7 through unclamped", abs(A.clamp_nl(0.7, True) - 0.7) < 1e-9)
check("Lab passes 1.0 (== generate) through", abs(A.clamp_nl(1.0, True) - 1.0) < 1e-9)
check("Lab does NOT impose a 1.0 ceiling (1.5 -> 1.5)", abs(A.clamp_nl(1.5, True) - 1.5) < 1e-9)

# ── the NL_MIN degenerate floor holds in BOTH modes ───────────────────────────
check("nl below NL_MIN raises (normal)", _raises(0.005, False))
check("nl below NL_MIN raises (Lab)", _raises(0.005, True))
check("nl == NL_MIN is accepted (boundary)", abs(A.clamp_nl(A.NL_MIN, False) - A.NL_MIN) < 1e-9)

# ── determinism ───────────────────────────────────────────────────────────────
check("clamp_nl is deterministic",
      A.clamp_nl(0.7, False) == A.clamp_nl(0.7, False) and A.clamp_nl(1.5, True) == A.clamp_nl(1.5, True))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
