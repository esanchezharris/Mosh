#!/usr/bin/env python3
"""Golden tests for the ColorRack runtime (05 §6) — HERMETIC: runs against the
committed COLORRACK_DATA registry + vecs; pure numpy/json, no MLX. 3× deterministic.

Focus: the ASTD quality-collapse clamp must not be bypassed by DUPLICATE color
names. Two identical colors (e.g. two 'grit') each land a steer on the SAME
peak_layer with the same vec; downstream both ADD, doubling the effective alpha
past the color's ASTD ceiling (a prime-directive violation). resolve_steers must
de-duplicate by name (keep first) BEFORE the ≤3 budget so a duplicate can neither
stack on itself nor consume a slot.

Run:  python3 service/colors/colors_runtime_test.py     (exit 0 = all pass)
"""
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from colors import runtime  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


REG = runtime.registry()
assert "grit" in REG and "brightness" in REG, "test needs the committed COLORRACK_DATA registry"

GRIT_CEIL = float(REG["grit"]["astd_max"])
GRIT_LAYER = int(REG["grit"]["peak_layer"])


def _agg(steers):
    agg = defaultdict(float)
    for layer, alpha, _vec in steers:
        agg[layer] += alpha
    return agg


# ── The defect: duplicate color names bypass the ASTD clamp ───────────────────
dup = runtime.resolve_steers([{"name": "grit", "value": 100}, {"name": "grit", "value": 100}])
check("resolve_steers([grit, grit]) yields ONE grit steer (dedup by name, not two)",
      len(dup) == 1, f"got {len(dup)} steers")
check("de-duped grit lands a single steer on grit's peak_layer",
      [s[0] for s in dup] == [GRIT_LAYER], f"layers={[s[0] for s in dup]}")
_dup_agg = _agg(dup)
check("aggregate alpha on grit's layer stays within the ASTD ceiling (not doubled)",
      abs(_dup_agg[GRIT_LAYER]) <= GRIT_CEIL + 1e-6,
      f"agg={_dup_agg[GRIT_LAYER]:.4f} ceil={GRIT_CEIL:.4f}")

# A duplicate must not consume a budget slot: [grit, grit, brightness] de-dups to
# {grit, brightness} → 2 colors (a2 backoff), so brightness still gets its steer.
dup_slot = runtime.resolve_steers([
    {"name": "grit", "value": 100},
    {"name": "grit", "value": 100},
    {"name": "brightness", "value": 100},
])
_names_in = {GRIT_LAYER, int(REG["brightness"]["peak_layer"])}
check("a duplicate does not consume a ≤3 slot (brightness still lands)",
      len(dup_slot) == 2 and {s[0] for s in dup_slot} == _names_in,
      f"got {len(dup_slot)} steers on layers {sorted({s[0] for s in dup_slot})}")

# Dedup keeps the FIRST occurrence's value (not the last).
first_val = runtime.resolve_steers([{"name": "grit", "value": 100}, {"name": "grit", "value": 50}])
one_grit = runtime.resolve_steers([{"name": "grit", "value": 100}])
check("dedup keeps the FIRST occurrence (value 100 wins over a later 50)",
      len(first_val) == 1 and abs(first_val[0][1] - one_grit[0][1]) < 1e-6,
      f"dup-first alpha={first_val[0][1]:.4f} single-100 alpha={one_grit[0][1]:.4f}")

# The de-duped duplicate must be identical to the single-color result.
check("resolve_steers([grit, grit]) == resolve_steers([grit]) (single-color equivalence)",
      len(dup) == len(one_grit) and dup[0][0] == one_grit[0][0]
      and abs(dup[0][1] - one_grit[0][1]) < 1e-6,
      f"dup={[(s[0], round(s[1], 4)) for s in dup]} single={[(s[0], round(s[1], 4)) for s in one_grit]}")

# ── Sanity: unique multi-color path is unaffected ─────────────────────────────
two = runtime.resolve_steers([{"name": "grit", "value": 100}, {"name": "brightness", "value": 100}])
check("two DISTINCT colors → two steers (dedup does not touch unique names)",
      len(two) == 2, f"got {len(two)} steers")

# ── Orthogonalization opt-in (default OFF ⇒ byte-identical) ────────────────────
import numpy as np  # noqa: E402


def _cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


# futuristic + tension share peak_layer 4 and are correlated (~51° / cos 0.62).
_pair = [{"name": "futuristic", "value": 100}, {"name": "tension", "value": 100}]
_base = runtime.resolve_steers(_pair)                        # default: orthogonalize=False
_orth = runtime.resolve_steers(_pair, orthogonalize=True)

check("default keeps the correlated same-layer pair as the RAW vecs (not orthogonalized)",
      len(_base) == 2 and abs(_cos(_base[0][2], _base[1][2])) > 0.5,
      f"cos={abs(_cos(_base[0][2], _base[1][2])):.3f}")
check("orthogonalize=True makes the same-layer pair orthogonal",
      len(_orth) == 2 and abs(_cos(_orth[0][2], _orth[1][2])) < 1e-4,
      f"cos={abs(_cos(_orth[0][2], _orth[1][2])):.2e}")
check("orthogonalize preserves each vec's L2 norm",
      all(abs(np.linalg.norm(o[2]) - np.linalg.norm(b[2])) / np.linalg.norm(b[2]) < 1e-4
          for o, b in zip(_orth, _base)))
check("orthogonalize leaves alphas + layers untouched",
      [(o[0], round(o[1], 6)) for o in _orth] == [(b[0], round(b[1], 6)) for b in _base])

# grit (layer 14) is solo across the rack — even orthogonalize=True can't change a
# single-per-layer vec (no same-layer partner to de-correlate against).
_solo = runtime.resolve_steers([{"name": "grit", "value": 100}], orthogonalize=True)
_solo_off = runtime.resolve_steers([{"name": "grit", "value": 100}])
check("a solo colour is unchanged under orthogonalize=True",
      len(_solo) == 1 and np.array_equal(_solo[0][2], _solo_off[0][2]))

# grit (L14) + brightness (L4) live on DIFFERENT layers → each solo-per-layer → untouched.
_cross = runtime.resolve_steers(
    [{"name": "grit", "value": 100}, {"name": "brightness", "value": 100}], orthogonalize=True)
_cross_off = runtime.resolve_steers(
    [{"name": "grit", "value": 100}, {"name": "brightness", "value": 100}])
check("a cross-layer pair is untouched (orthogonalization is same-layer only)",
      len(_cross) == 2 and all(np.array_equal(a[2], b[2]) for a, b in zip(_cross, _cross_off)))
# ── Time-scheduled steering: the "sustain" color carries an envelope ──────────
assert "sustain" in REG, "test needs the committed 'sustain' color"
SUS_LAYER = int(REG["sustain"]["peak_layer"])

# Default (with_envelopes=False): 3-tuples, BYTE-IDENTICAL to before (existing callers).
sus3 = runtime.resolve_steers([{"name": "sustain", "value": 100}])
check("default resolve_steers stays 3-tuples (backward-compatible)",
      len(sus3) == 1 and len(sus3[0]) == 3, f"tuple len={len(sus3[0]) if sus3 else 0}")
check("sustain lands a steer on its peak_layer", sus3 and sus3[0][0] == SUS_LAYER)
check("sustain alpha within its ASTD ceiling",
      sus3 and abs(sus3[0][1]) <= float(REG["sustain"]["astd_max"]) + 1e-6)

# with_envelopes=True: 4-tuples; sustain's 4th element is its hold envelope.
sus4 = runtime.resolve_steers([{"name": "sustain", "value": 100}], with_envelopes=True)
check("with_envelopes → 4-tuple", sus4 and len(sus4[0]) == 4, f"len={len(sus4[0]) if sus4 else 0}")
check("sustain envelope is the hold spec",
      sus4 and isinstance(sus4[0][3], dict) and sus4[0][3].get("kind") == "hold",
      f"env={sus4[0][3] if sus4 else None}")

# A color WITHOUT an envelope (grit) → 4th element None (uniform steer).
grit4 = runtime.resolve_steers([{"name": "grit", "value": 100}], with_envelopes=True)
check("non-envelope color → 4th element None", grit4 and grit4[0][3] is None,
      f"env={grit4[0][3] if grit4 else '—'}")

# with_envelopes must not change layer/alpha vs the default path.
check("with_envelopes leaves (layer, alpha) identical to default",
      sus4 and sus3 and sus4[0][0] == sus3[0][0] and abs(sus4[0][1] - sus3[0][1]) < 1e-9)

# ── Orthogonalize + envelopes compose (the #359×#362 crash-case) ──────────────
# A same-layer (L17) stack where one member (sustain) carries a hold envelope, with
# BOTH orthogonalize AND with_envelopes on: must not crash on the 4-tuples, must
# orthogonalize the vecs, and must PRESERVE sustain's envelope (not silently strip it).
oe = runtime.resolve_steers(
    [{"name": "sustain", "value": 100}, {"name": "distortion", "value": 100}],
    orthogonalize=True, with_envelopes=True)
check("ortho+envelopes: no crash, 2 four-tuples",
      len(oe) == 2 and all(len(t) == 4 for t in oe), f"lens={[len(t) for t in oe]}")
check("ortho+envelopes: same-layer vecs orthogonalized",
      abs(_cos(oe[0][2], oe[1][2])) < 1e-4, f"cos={abs(_cos(oe[0][2], oe[1][2])):.2e}")
_sus_oe = next((t for t in oe if t[0] == SUS_LAYER and isinstance(t[3], dict)), None)
check("ortho+envelopes: sustain's hold envelope is PRESERVED (not stripped)",
      _sus_oe is not None and _sus_oe[3].get("kind") == "hold",
      f"sustain 4th={_sus_oe[3] if _sus_oe else None}")

# ── Determinism ───────────────────────────────────────────────────────────────
again = runtime.resolve_steers([{"name": "grit", "value": 100}, {"name": "grit", "value": 100}])
check("resolve_steers is deterministic",
      [(l, round(a, 6)) for l, a, _ in dup] == [(l, round(a, 6)) for l, a, _ in again])

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
