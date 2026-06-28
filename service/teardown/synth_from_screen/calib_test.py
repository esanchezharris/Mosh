#!/usr/bin/env python3
"""Test for host-invariant calibration (calib.compute_calibration) — especially the EMBEDDED-window
case: a synth GUI smaller than / anywhere within a DAW screenshot (the common real-tutorial shape,
not a full-screen standalone capture). The old single-scale calibration assumed the content filled
the frame width, so an embedded window failed the logo match → fell back to proportional → tabs/knobs
read at ~0.5 confidence (below the 0.6 gate). Multi-scale matching recovers it.

Deterministic + portable (synthesizes embedded frames from the committed vital_init.png; no binary).

    python3 service/teardown/synth_from_screen/calib_test.py   (needs cv2/numpy)
"""
import json
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen.calib import compute_calibration  # noqa: E402
from teardown.synth_from_screen.page_detect import detect_active_tab  # noqa: E402

FIX = os.path.join(_HERE, "fixtures", "vital_init.png")
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


if not os.path.isfile(FIX):
    check("vital_init.png fixture present", False, FIX)
    print(f"\n{'ALL PASS' if not fails else 'FAILURES'}  ({len(fails)} failure(s))")
    sys.exit(len(fails))

full = cv2.imread(FIX)
data = json.load(open(os.path.join(_HERE, "profiles", "vital.json")))


def _embed(scale: float, padx: float = 0.7, pady: float = 0.8):
    """The Vital GUI at `scale` of reference, placed in a larger gray frame (an embedded window)."""
    h, w = full.shape[:2]
    sw, sh = int(w * scale), int(h * scale)
    small = cv2.resize(full, (sw, sh))
    frame = np.full((int(sh / pady) + 60, int(sw / padx) + 40, 3), 40, np.uint8)
    frame[30:30 + sh, 20:20 + sw] = small
    return frame


# ── full-screen: host-invariant calib at ~base scale, tab reads cleanly ──────────────────────
c_full = compute_calibration(data, full)
check("full-screen → host-invariant calib (high score, s≈1.0)",
      c_full is not None and c_full["score"] > 0.9 and abs(c_full["s"] - 1.0) < 0.05, str(c_full))
check("full-screen tab confidence 1.0", detect_active_tab(full, "vital")["confidence"] >= 0.99)

# ── embedded: the headline fix — calib recovers the window scale, tab reads ≥0.85 (was ~0.51) ──
for scale in (0.5, 0.65, 0.8):
    fr = _embed(scale)
    c = compute_calibration(data, fr)
    check(f"embedded @{scale} → calib found at the right scale (s≈{scale})",
          c is not None and abs(c["s"] - scale) < 0.06, str(c))
    conf = detect_active_tab(fr, "vital")["confidence"]
    check(f"embedded @{scale} tab confidence ≥0.85 (clears the 0.6 gate; was ~0.51 single-scale)",
          conf >= 0.85, str(conf))

# ── a window placed off-center (not top-left) is still found (translation-tolerant) ──────────
h, w = full.shape[:2]
sw, sh = int(w * 0.55), int(h * 0.55)
off = np.full((sh + 200, sw + 300, 3), 40, np.uint8)
off[150:150 + sh, 250:250 + sw] = cv2.resize(full, (sw, sh))
check("off-center embedded window found (translation-tolerant)",
      detect_active_tab(off, "vital")["confidence"] >= 0.85,
      str(detect_active_tab(off, "vital")["confidence"]))

# ── negative: a frame with NO Vital GUI → no calibration (no false logo match) ───────────────
gray = np.full((900, 1400, 3), 40, np.uint8)
check("non-GUI frame → no calibration (no false match)", compute_calibration(data, gray) is None)

# ── determinism ──────────────────────────────────────────────────────────────────────────────
fr = _embed(0.65)
outs = [round(compute_calibration(data, fr)["s"], 4) for _ in range(3)]
check("embedded calib deterministic x3", outs[0] == outs[1] == outs[2], str(outs))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
