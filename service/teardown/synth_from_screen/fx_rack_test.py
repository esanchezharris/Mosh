#!/usr/bin/env python3
"""Test for the FX-CHAIN detector — "which effects are enabled, and in what order" read from a
synth's EFFECTS/FX page (the effects RACK LIST). Asserts on the REAL committed fixtures (Vital +
Serum 1), plus a synthetic strip, graceful degradation, and determinism.

    python3 service/teardown/synth_from_screen/fx_rack_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen.fx_rack import detect_fx_chain  # noqa: E402

PANELS = os.path.join(_HERE, "fixtures", "panels")

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── REAL fixture: Vital EFFECTS page ──────────────────────────────────────────
# vital_effects.png (1171x718, EFFECTS tab). Fixed order (9): Chorus, Compressor, Delay,
# Distortion, Equalizer, Filter, Flanger, Phaser, Reverb. ENABLED: Chorus + Delay only.
VITAL_ORDER = ["Chorus", "Compressor", "Delay", "Distortion", "Equalizer",
               "Filter", "Flanger", "Phaser", "Reverb"]
VITAL_ON = {"Chorus", "Delay"}
pv = os.path.join(PANELS, "vital_effects.png")
if os.path.isfile(pv):
    im = cv2.imread(pv)
    chain = detect_fx_chain(im, "vital")
    check("vital: 9 effects detected", len(chain) == 9, str(len(chain)))
    check("vital: effects in fixed rack order",
          [e["name"] for e in chain] == VITAL_ORDER, str([e["name"] for e in chain]))
    for e in chain:
        want = e["name"] in VITAL_ON
        check(f"vital: {e['name']} on=={want}", e["on"] == want, str(e))
    check("vital: exactly Chorus+Delay on",
          {e["name"] for e in chain if e["on"]} == VITAL_ON,
          str({e["name"] for e in chain if e["on"]}))
else:
    check("vital_effects.png fixture present", False, pv)

# ── REGRESSION: Delay-ALONE (Chorus off). The detector USED to misread this as "Chorus on" ──────
# because it sampled x_dot=430 — the effect ICON / expanded PANEL column — and Vital's panels STACK
# by enabled-order, so Delay's panel slid up into Chorus's row slot. The fix samples the FIXED rack
# power-dot column (x_dot=160). Captured live (computer-use) with only Delay enabled.
pdo = os.path.join(PANELS, "vital_delay_only.png")
if os.path.isfile(pdo):
    chain = detect_fx_chain(cv2.imread(pdo), "vital")
    on = {e["name"] for e in chain if e["on"]}
    check("vital Delay-alone: ONLY Delay on (not Chorus — the stacking-panel bug)",
          on == {"Delay"}, str(on))
else:
    check("vital_delay_only.png fixture present", False, pdo)

# ── REAL fixture: Serum 1 FX page (Init = ALL OFF) ────────────────────────────
# serum1_fx.png (900x747, FX tab). Fixed order (10). ENABLED: NONE (Init patch).
SERUM1_ORDER = ["Hyper/Dimension", "Distortion", "Flanger", "Phaser", "Chorus",
                "Compressor", "Delay", "Reverb", "EQ", "Filter"]
ps = os.path.join(PANELS, "serum1_fx.png")
if os.path.isfile(ps):
    im = cv2.imread(ps)
    chain = detect_fx_chain(im, "serum1")
    check("serum1: 10 effects detected", len(chain) == 10, str(len(chain)))
    check("serum1: effects in fixed rack order",
          [e["name"] for e in chain] == SERUM1_ORDER, str([e["name"] for e in chain]))
    check("serum1: ALL off (Init patch)",
          all(not e["on"] for e in chain), str([e["name"] for e in chain if e["on"]]))
else:
    check("serum1_fx.png fixture present", False, ps)

# ── resolution independence: the same Vital page at a different capture size ───────
if os.path.isfile(pv):
    im = cv2.imread(pv)
    big = cv2.resize(im, (int(im.shape[1] * 1.5), int(im.shape[0] * 1.5)))
    chain = detect_fx_chain(big, "vital")
    check("vital @1.5x: same 9 effects, same Chorus+Delay on",
          len(chain) == 9 and {e["name"] for e in chain if e["on"]} == VITAL_ON, str(chain))

# ── synthetic strip: N rows, some with a bright saturated dot at x_dot → on, rest off ──
# We draw a strip and a throwaway profile-less path by reusing the serum1 geometry via a fake synth
# is not possible (profiles are files), so we exercise the detector through a temp profile written
# next to the others — instead, test the indicator logic directly on a strip with a known synth.
# Simplest hermetic check: draw a vital-EFFECTS-shaped dot column over a copy of the fixture's
# geometry by writing a tiny synthetic frame and a matching ad-hoc profile in-memory is overkill;
# we draw onto a blank frame at the VITAL reference dot positions, lighting a chosen subset.
def make_synthetic_vital(lit_indices, w=1171, h=718):
    """Blank frame with the Vital effects-rack power-dot column (ref/2 == fixture space): lit rows
    get a bright saturated magenta dot, off rows a grey one — at the calibrated power-dot column
    x=80, y=84, pitch=68 (ref 160/168/136, halved)."""
    img = np.full((h, w, 3), 30, np.uint8)
    x = 80
    for i in range(9):
        y = 84 + i * 68
        col = (200, 40, 220) if i in lit_indices else (90, 90, 90)  # BGR magenta vs grey
        cv2.circle(img, (x, y), 8, col, -1)
    return img

for lit in [set(), {0}, {0, 2}, {1, 3, 8}, set(range(9))]:
    img = make_synthetic_vital(lit)
    chain = detect_fx_chain(img, "vital")
    got = {i for i, e in enumerate(chain) if e["on"]}
    check(f"synthetic strip: lit rows {sorted(lit)} read on", got == lit, f"got {sorted(got)}")
check("synthetic strip: count + order preserved",
      [e["name"] for e in detect_fx_chain(make_synthetic_vital({0}), "vital")] == VITAL_ORDER)

# ── graceful: unknown synth / no fx_list / grayscale never raise, return [] ────────
if os.path.isfile(pv):
    im = cv2.imread(pv)
    check("unknown synth → []", detect_fx_chain(im, "nope_not_a_synth") == [])
    # falsy synth (e.g. identify_synth returned {"synth": None}) must not raise → [] (mirrors read_matrix)
    check("empty/None synth → [] (no crash)",
          detect_fx_chain(im, "") == [] and detect_fx_chain(im, None) == [])
    # serum.json (Serum 2) deliberately has NO fx_list → []
    check("synth without an fx_list block → []", detect_fx_chain(im, "serum") == [])
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    check("grayscale (2D) frame → [] (no crash)", detect_fx_chain(g, "vital") == [])
check("None image → [] (no crash)", detect_fx_chain(None, "vital") == [])
# tiny frame must not raise (rows fall off the edge → just read off)
tiny = np.full((4, 4, 3), 30, np.uint8)
check("tiny frame → no crash", isinstance(detect_fx_chain(tiny, "vital"), list))

# ── determinism: same input → identical output 3x ─────────────────────────────
if os.path.isfile(pv):
    im = cv2.imread(pv)
    outs = [detect_fx_chain(im, "vital") for _ in range(3)]
    check("vital detection deterministic x3", outs[0] == outs[1] == outs[2])
if os.path.isfile(ps):
    im = cv2.imread(ps)
    outs = [detect_fx_chain(im, "serum1") for _ in range(3)]
    check("serum1 detection deterministic x3", outs[0] == outs[1] == outs[2])

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
