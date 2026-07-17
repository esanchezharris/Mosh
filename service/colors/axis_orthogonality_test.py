#!/usr/bin/env python3
"""Golden tests for colour-axis orthogonalization (`colors/ortho.py`) — HERMETIC:
runs against the committed COLORRACK_DATA vecs; pure numpy, no MLX. 3× deterministic.

Two jobs:
  (a) SNAPSHOT the current within-layer correlations as a regression guard — steers only
      compose linearly when they share a `peak_layer` (dit_mlx_medium.py residual add), so
      the interesting pairs are same-layer. The measured offenders (2026-07-17): L4
      futuristic↔tension ~51.3°, L17 distortion↔epic ~67.7°; the rest of L17 is ~87–98°.
  (b) VERIFY `orthogonalize_group`: symmetric (Löwdin) orthogonalization makes a same-layer
      group mutually orthogonal (|cos|≈0) while PRESERVING each vector's L2 norm (so the
      existing astd_max ceilings stay ~valid); a 1-vector group and a near-parallel group
      pass through unchanged; deterministic.

Run:  python3 service/colors/axis_orthogonality_test.py     (exit 0 = all pass)
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))   # service/ on the path

from colors import ortho  # noqa: E402

DATA = os.path.join(HERE, "COLORRACK_DATA")
REG = json.load(open(os.path.join(DATA, "colors.json")))["colors"]

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def vec(name):
    return np.load(os.path.join(DATA, REG[name]["vec_path"])).astype(np.float32)


def angle_deg(a, b):
    c = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def layer_of(name):
    return int(REG[name]["peak_layer"])


# ── (a) regression snapshot of the shipped rack ───────────────────────────────
check("L4 shares 3 colours (brightness, futuristic, tension)",
      sorted(n for n in REG if layer_of(n) == 4) == ["brightness", "futuristic", "tension"])
check("L17 shares 5 colours (air, distortion, epic, grid_tightness, sustain)",
      sorted(n for n in REG if layer_of(n) == 17) == ["air", "distortion", "epic", "grid_tightness", "sustain"])

a_ft = angle_deg(vec("futuristic"), vec("tension"))
a_de = angle_deg(vec("distortion"), vec("epic"))
a_ae = angle_deg(vec("air"), vec("epic"))
check("futuristic↔tension is the L4 offender (~51.3°)", abs(a_ft - 51.3) < 1.5, f"{a_ft:.1f}°")
check("distortion↔epic is the L17 offender (~67.7°)", abs(a_de - 67.7) < 1.5, f"{a_de:.1f}°")
check("air↔epic is already ~orthogonal (>85°)", a_ae > 85.0, f"{a_ae:.1f}°")


# ── (b) orthogonalize_group makes a same-layer group orthogonal, norm-preserved ─
def assert_group_orthogonal(label, names):
    vs = [vec(n) for n in names]
    out = ortho.orthogonalize_group(vs)
    check(f"{label}: same count + 1536-d order preserved",
          len(out) == len(vs) and all(o.shape == v.shape for o, v in zip(out, vs)))
    # mutually orthogonal
    max_cos = 0.0
    for i in range(len(out)):
        for j in range(i + 1, len(out)):
            c = abs(float(np.dot(out[i], out[j]) / (np.linalg.norm(out[i]) * np.linalg.norm(out[j]))))
            max_cos = max(max_cos, c)
    check(f"{label}: all pairs orthogonal (max |cos| < 1e-4)", max_cos < 1e-4, f"max|cos|={max_cos:.2e}")
    # norms preserved
    max_rel = max(abs(np.linalg.norm(o) - np.linalg.norm(v)) / np.linalg.norm(v)
                  for o, v in zip(out, vs))
    check(f"{label}: each L2 norm preserved (rel err < 1e-4)", max_rel < 1e-4, f"max rel={max_rel:.2e}")


assert_group_orthogonal("L4 group", ["brightness", "futuristic", "tension"])
assert_group_orthogonal("L17 group", ["air", "distortion", "epic", "grid_tightness", "sustain"])

# ── (c) guards: singleton + near-parallel pass through unchanged ───────────────
solo = [vec("grit")]
solo_out = ortho.orthogonalize_group(solo)
check("singleton group returns the same vector unchanged",
      len(solo_out) == 1 and np.array_equal(solo_out[0], solo[0]))

base = np.arange(1536, dtype=np.float32) + 1.0
near = base * np.float32(1.0001) + np.float32(1e-3)          # ~collinear with base
np_out = ortho.orthogonalize_group([base, near])
check("near-parallel group is left unchanged (ill-conditioned overlap guard)",
      np.array_equal(np_out[0], base) and np.array_equal(np_out[1], near),
      f"angle={angle_deg(base, near):.4f}°")

# ── (d) determinism ───────────────────────────────────────────────────────────
g = ["air", "distortion", "epic", "grid_tightness", "sustain"]
o1 = ortho.orthogonalize_group([vec(n) for n in g])
o2 = ortho.orthogonalize_group([vec(n) for n in g])
check("orthogonalize_group is deterministic", all(np.array_equal(a, b) for a, b in zip(o1, o2)))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
