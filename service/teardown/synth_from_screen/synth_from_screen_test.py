#!/usr/bin/env python3
"""Test for §5b — the knob-angle reading core on SYNTHETIC knobs (known values), plus
read_patch over a profile. Real per-synth profile calibration needs real frames (gated);
this proves the generic core recovers a value from the pointer angle.

    python3 service/teardown/synth_from_screen/synth_from_screen_test.py   (needs cv2/numpy)
"""
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen import read_knob, read_patch  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def draw_knob(img, cx, cy, r, value, sweep=270.0):
    cv2.circle(img, (cx, cy), r, (200, 200, 200), -1)        # light body
    phi = -sweep / 2 + value * sweep                          # clockwise from top
    rad = math.radians(phi)
    ex = int(cx + math.sin(rad) * r * 0.9)
    ey = int(cy - math.cos(rad) * r * 0.9)
    cv2.line(img, (cx, cy), (ex, ey), (20, 20, 20), 2)        # dark pointer


# ── single-knob recovery across the sweep ────────────────────────────────────
for v in [0.0, 0.25, 0.5, 0.75, 1.0]:
    img = np.full((120, 120, 3), 30, np.uint8)
    draw_knob(img, 60, 60, 40, v)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    rv = read_knob(gray, 60, 60, 40)["value"]
    check(f"knob value {v} recovered (±0.08)", abs(rv - v) < 0.08, f"got {rv}")

# ── white-pointer mode: a colourless pointer drawn over a SATURATED fill-arc ──────
# This is the Vital/Serum case. Reading all bright pixels would fold the arc into the
# centroid (a full arc's centroid sits at the top → reads ~0.5); "white" mode must isolate
# the desaturated pointer and recover the TRUE value even at full fill.
def draw_arc_knob(img, cx, cy, r, value, sweep=270.0, arc_bgr=(180, 200, 40)):
    cv2.circle(img, (cx, cy), r, (40, 40, 40), -1)             # dark body
    a0 = -sweep / 2                                            # start (down-left)
    a1 = -sweep / 2 + value * sweep                            # up to the value
    # teal/cyan fill-arc from start to value (saturated colour)
    for deg in np.arange(a0, a1, 1.0):
        rad = math.radians(deg)
        ex = int(cx + math.sin(rad) * r * 0.85)
        ey = int(cy - math.cos(rad) * r * 0.85)
        cv2.circle(img, (ex, ey), max(2, r // 12), arc_bgr, -1)
    # the white pointer line AT the value angle (colourless, bright)
    radv = math.radians(a1)
    ex = int(cx + math.sin(radv) * r * 0.9)
    ey = int(cy - math.cos(radv) * r * 0.9)
    cv2.line(img, (cx, cy), (ex, ey), (245, 245, 245), 3)


for v in [0.0, 0.3, 0.6, 1.0]:
    panelw = np.full((160, 160, 3), 25, np.uint8)
    draw_arc_knob(panelw, 80, 80, 55, v)
    rv = read_knob(cv2.cvtColor(panelw, cv2.COLOR_BGR2GRAY), 80, 80, 55,
                   img_bgr=panelw, pointer="white")
    check(f"white-pointer over fill-arc: value {v} (±0.08)", abs(rv["value"] - v) < 0.08,
          f"got {rv['value']} conf {rv['confidence']}")
# the regression that motivated this: a FULL arc must NOT read ~0.5 (the centroid trap)
panelf = np.full((160, 160, 3), 25, np.uint8)
draw_arc_knob(panelf, 80, 80, 55, 1.0)
naive = read_knob(cv2.cvtColor(panelf, cv2.COLOR_BGR2GRAY), 80, 80, 55, dark_pointer=False)["value"]
white = read_knob(cv2.cvtColor(panelf, cv2.COLOR_BGR2GRAY), 80, 80, 55, img_bgr=panelf, pointer="white")["value"]
check("naive bright-pixel read is fooled by a full arc (~0.5)", naive < 0.8, f"naive={naive}")
check("white-pointer read recovers full value (~1.0)", white > 0.9, f"white={white}")


# ── white mode is SKIN-RELATIVE: light-grey body + colored arc must not flood the read ──
# (review finding: absolute brightness thresholds let a light knob body flood the centroid)
def draw_skin_knob(body_bgr, ptr_bgr, value, sweep=270.0):
    img = np.full((160, 160, 3), 25, np.uint8)
    cv2.circle(img, (80, 80), 55, body_bgr, -1)
    a0 = -sweep / 2; a1 = -sweep / 2 + value * sweep
    for deg in np.arange(a0, a1, 1.0):     # saturated blue fill-arc (must be ignored)
        rad = math.radians(deg)
        cv2.circle(img, (int(80 + math.sin(rad) * 55 * 0.85), int(80 - math.cos(rad) * 55 * 0.85)),
                   max(2, 55 // 12), (200, 120, 40), -1)
    radv = math.radians(a1)
    cv2.line(img, (80, 80), (int(80 + math.sin(radv) * 55 * 0.9), int(80 - math.cos(radv) * 55 * 0.9)), ptr_bgr, 3)
    return img

for tag, body, ptr in [("light body + white ptr", (180, 180, 180), (245, 245, 245)),
                       ("dark body + white ptr", (40, 40, 40), (245, 245, 245)),
                       ("light body + dark ptr", (195, 195, 195), (25, 25, 25))]:
    for v in [0.2, 0.85]:
        im = draw_skin_knob(body, ptr, v)
        rv = read_knob(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), 80, 80, 55, img_bgr=im, pointer="white")
        check(f"skin-relative read: {tag} v={v}", abs(rv["value"] - v) < 0.08, f"got {rv['value']}")

# ── blue rim-tick mode (Serum 1 & 2) ─────────────────────────────────────────────
# Serum marks a knob's value with a saturated BLUE tick at the rim. On Serum 2's GLOSSY skin a
# bright top-bevel highlight is low-chroma like the white pointer, so the white read is dragged
# toward ~0.5 on low-value knobs. The blue tick is high-chroma → it reads the value cleanly.
def draw_glossy_tick_knob(value, sweep=270.0, bevel=True):
    img = np.full((160, 160, 3), 25, np.uint8)
    cx, cy, r = 80, 80, 55
    cv2.circle(img, (cx, cy), r, (110, 110, 110), -1)          # glossy mid-grey body
    if bevel:                                                  # bright top-edge bevel (the fooler)
        for deg in np.arange(-45, 45, 1.0):
            rad = math.radians(deg)
            cv2.circle(img, (int(cx + math.sin(rad) * r * 0.9), int(cy - math.cos(rad) * r * 0.9)),
                       2, (235, 235, 235), -1)
        for deg in np.arange(-45, 45, 1.0):                    # inner top highlight too
            rad = math.radians(deg)
            cv2.circle(img, (int(cx + math.sin(rad) * r * 0.6), int(cy - math.cos(rad) * r * 0.6)),
                       2, (225, 225, 225), -1)
    a1 = -sweep / 2 + value * sweep
    radv = math.radians(a1)
    cv2.line(img, (cx, cy), (int(cx + math.sin(radv) * r * 0.8), int(cy - math.cos(radv) * r * 0.8)),
             (235, 235, 235), 3)                               # white pointer
    cv2.circle(img, (int(cx + math.sin(radv) * r * 1.0), int(cy - math.cos(radv) * r * 1.0)),
               4, (230, 110, 30), -1)                          # saturated BLUE rim tick at the value
    return img

for v in [0.0, 0.25, 0.5, 0.75, 1.0]:
    im = draw_glossy_tick_knob(v)
    rv = read_knob(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), 80, 80, 55, img_bgr=im, pointer="blue_tick")
    check(f"blue_tick value {v} recovered (±0.08)", abs(rv["value"] - v) < 0.08,
          f"got {rv['value']} conf {rv['confidence']}")

# the regression that motivated blue_tick: a LOW value on a glossy bevelled knob — white reads ~0.5,
# blue_tick recovers the true low value.
im_low = draw_glossy_tick_knob(0.1)
g_low = cv2.cvtColor(im_low, cv2.COLOR_BGR2GRAY)
white_low = read_knob(g_low, 80, 80, 55, img_bgr=im_low, pointer="white")["value"]
tick_low = read_knob(g_low, 80, 80, 55, img_bgr=im_low, pointer="blue_tick")["value"]
check("white read is fooled by the top-bevel highlight (reads high)", white_low > 0.25, f"white={white_low}")
check("blue_tick recovers the true low value (~0.1)", tick_low < 0.2, f"tick={tick_low}")

# fallback: blue_tick with NO blue tick present (non-default skin) → falls back to the white pointer.
im_noblue = draw_glossy_tick_knob(0.7, bevel=False)
# overwrite the blue tick with a colourless one so only the white pointer remains
cv2.circle(im_noblue, (80, 80), 55, (110, 110, 110), -1)
radv = math.radians(-135 + 0.7 * 270)
cv2.line(im_noblue, (80, 80), (int(80 + math.sin(radv) * 55 * 0.8), int(80 - math.cos(radv) * 55 * 0.8)),
         (240, 240, 240), 3)
rv_fb = read_knob(cv2.cvtColor(im_noblue, cv2.COLOR_BGR2GRAY), 80, 80, 55, img_bgr=im_noblue, pointer="blue_tick")
check("blue_tick falls back to white pointer when no tick (~0.7)", abs(rv_fb["value"] - 0.7) < 0.1,
      f"got {rv_fb['value']}")

# ── read_patch must not crash on a malformed control spec (missing geometry) ──────
malformed = {
    "good": {"type": "knob", "cx": 60, "cy": 60, "r": 40, "range": [0.0, 1.0]},
    "no_cx": {"type": "knob", "cy": 60, "r": 40},           # missing cx → skip, not crash
    "no_bbox": {"type": "toggle"},                          # missing bbox → skip, not crash
}
mp = np.full((120, 120, 3), 30, np.uint8)
draw_knob(mp, 60, 60, 40, 0.5)
res_mal = read_patch(mp, malformed)
check("read_patch skips malformed specs without crashing", "good" in res_mal["params"] and "no_cx" not in res_mal["params"],
      str(res_mal["params"]))

# ── white mode hardening: invalid img_bgr must NOT crash, falls back to grayscale ──
panelg = np.full((160, 160, 3), 25, np.uint8)
draw_arc_knob(panelg, 80, 80, 55, 0.5)
g = cv2.cvtColor(panelg, cv2.COLOR_BGR2GRAY)
# (a) pointer="white" but img_bgr is 2D (grayscale) → no IndexError, grayscale fallback
r_2d = read_knob(g, 80, 80, 55, dark_pointer=False, img_bgr=g, pointer="white")
check("white mode with a 2D img_bgr does not crash (falls back)", 0.0 <= r_2d["value"] <= 1.0, str(r_2d))
# (b) pointer="white" but img_bgr spatial dims differ from gray → no broadcast error
big = np.full((320, 320, 3), 25, np.uint8)
r_mismatch = read_knob(g, 80, 80, 55, dark_pointer=False, img_bgr=big, pointer="white")
check("white mode with a mismatched-size img_bgr does not crash", 0.0 <= r_mismatch["value"] <= 1.0, str(r_mismatch))

# ── classify-free knob edge cases must never raise (degenerate inputs) ────────
tiny = np.full((4, 4, 3), 25, np.uint8)
check("knob on a tiny frame returns gracefully",
      read_knob(cv2.cvtColor(tiny, cv2.COLOR_BGR2GRAY), 2, 2, 3, img_bgr=tiny, pointer="white")["confidence"] == 0.0)


# ── read_patch over a 2-knob profile ─────────────────────────────────────────
panel = np.full((120, 260, 3), 30, np.uint8)
draw_knob(panel, 60, 60, 40, 0.3)
draw_knob(panel, 200, 60, 40, 0.7)
profile = {
    "cutoff": {"type": "knob", "cx": 60, "cy": 60, "r": 40, "range": [0.0, 1.0]},
    "reso": {"type": "knob", "cx": 200, "cy": 60, "r": 40, "range": [0.0, 1.0]},
}
res = read_patch(panel, profile)
check("read_patch cutoff ≈ 0.3", abs(res["params"]["cutoff"] - 0.3) < 0.1, str(res["params"]))
check("read_patch reso ≈ 0.7", abs(res["params"]["reso"] - 0.7) < 0.1, str(res["params"]))
check("per-param confidence present", all(c > 0 for c in res["confidence"].values()))

# ── range scaling ────────────────────────────────────────────────────────────
panel2 = np.full((120, 120, 3), 30, np.uint8)
draw_knob(panel2, 60, 60, 40, 0.5)
res2 = read_patch(panel2, {"freq": {"type": "knob", "cx": 60, "cy": 60, "r": 40, "range": [20.0, 20000.0]}})
check("range scaling maps 0.5 → mid of [20,20000]", 9000 < res2["params"]["freq"] < 11000, str(res2["params"]))

# ── determinism ──────────────────────────────────────────────────────────────
img6 = np.full((120, 120, 3), 30, np.uint8)
draw_knob(img6, 60, 60, 40, 0.6)
g6 = cv2.cvtColor(img6, cv2.COLOR_BGR2GRAY)
check("read_knob deterministic x3", len({read_knob(g6, 60, 60, 40)["value"] for _ in range(3)}) == 1)

# ── per-synth profiles: load + resolution-scaling (the calibrated Vital profile) ──────
from teardown.synth_from_screen.export import list_profiles, load_profile  # noqa: E402

check("vital profile is registered", "vital" in list_profiles(), str(list_profiles()))
check("serum profile is registered", "serum" in list_profiles(), str(list_profiles()))
check("serum1 (original Serum) profile is registered", "serum1" in list_profiles(), str(list_profiles()))
s1 = load_profile("serum1", 1800, 1494)
# serum1 (original): ENV (5, no delay) + OSC A + FILTER, all blue_tick (Serum's rim-tick reader).
check("serum1 profile: ENV (no delay) + OSC A + FILTER, blue_tick",
      "env1_delay" not in s1 and s1["env1_sustain"].get("pointer") == "blue_tick"
      and {"filter_cutoff", "filter_res", "oscA_level"} <= set(s1), str(list(s1)))
# serum 2: ENV (no delay) + OSC A + FILTER, blue_tick (glossy skin needs the rim tick, not white).
sp = load_profile("serum", 2380, 1544)
check("serum 2 profile: ENV (no delay) + OSC A + FILTER, blue_tick",
      "env1_delay" not in sp and sp["env1_sustain"].get("pointer") == "blue_tick"
      and {"filter_cutoff", "filter_mix", "oscA_wtpos"} <= set(sp), str(list(sp)))
# vital ADSR stays white-pointer (teal fill-arc + white line, no blue rim tick).
check("vital profile uses white-pointer mode",
      load_profile("vital", 2342, 1436)["env1_sustain"].get("pointer") == "white")
# reference_size in vital.json is 2342x1436; loading at the SAME size is identity
ref = load_profile("vital", 2342, 1436)
check("vital profile loads ENV + OSC 1/2/3 controls", len(ref) == 14 and "env1_sustain" in ref and "osc1_level" in ref and "osc3_pan" in ref)
check("identity load keeps reference coords", ref["env1_sustain"]["cx"] == 2106 and ref["env1_sustain"]["cy"] == 426)
# loading at HALF size scales coords by ~0.5 (so one profile works at any capture res)
half = load_profile("vital", 1171, 718)
check("half-size load scales cx", abs(half["env1_sustain"]["cx"] - 1053) <= 1, str(half["env1_sustain"]["cx"]))
check("half-size load scales cy", abs(half["env1_sustain"]["cy"] - 213) <= 1, str(half["env1_sustain"]["cy"]))
check("half-size load scales radius", abs(half["env1_sustain"]["r"] - 15) <= 1, str(half["env1_sustain"]["r"]))

# ── tab/page detection (which page of the synth is shown) ─────────────────────
from teardown.synth_from_screen.page_detect import detect_active_tab, identify_synth  # noqa: E402

# synthetic Serum-style strip: a green dot over the active tab, grey dots over the rest. The
# detector must pick the tab nearest the green dot, at ANY resolution (profile scales coords).
def make_serum_strip(active_x_ref, w=2380, h=1544):
    img = np.full((h, w, 3), 30, np.uint8)
    for name, x in {"OSC": 395, "MIX": 533, "FX": 670, "MATRIX": 807, "GLOBAL": 944}.items():
        col = (60, 230, 90) if x == active_x_ref else (90, 90, 90)   # BGR: green vs grey
        cv2.circle(img, (x, 110), 7, col, -1)
    return img

for want, ax in [("OSC", 395), ("FX", 670), ("GLOBAL", 944)]:
    r = detect_active_tab(make_serum_strip(ax), "serum")
    check(f"synthetic serum strip: green dot → {want}", r["tab"] == want, str(r))
# resolution independence: same strip at half size still resolves
r_half = detect_active_tab(cv2.resize(make_serum_strip(670), (1190, 772)), "serum")
check("tab detection is resolution-independent (half-size FX)", r_half["tab"] == "FX", str(r_half))
# a blank frame (no GUI) yields no tab, never a crash
check("blank frame → no tab", detect_active_tab(np.full((400, 400, 3), 20, np.uint8), "serum")["tab"] is None)
check("unknown synth → no tab", detect_active_tab(make_serum_strip(395), "nope")["tab"] is None)

# real committed panels (downscaled own-captures): each must detect its own active tab + synth
PANELS = os.path.join(_HERE, "fixtures", "panels")
panel_cases = [("serum2_osc.png", "serum", "OSC"), ("vital_voice.png", "vital", "VOICE"),
               ("vital_effects.png", "vital", "EFFECTS"), ("vital_matrix.png", "vital", "MATRIX"),
               ("vital_advanced.png", "vital", "ADVANCED"),
               # Serum 1 (the original) — all 4 tabs, captured live via Ableton
               ("serum1_osc.png", "serum1", "OSC"), ("serum1_fx.png", "serum1", "FX"),
               ("serum1_matrix.png", "serum1", "MATRIX"), ("serum1_global.png", "serum1", "GLOBAL")]
for fn, synth, want in panel_cases:
    p = os.path.join(PANELS, fn)
    if not os.path.isfile(p):
        continue   # a deploy bundle may strip large reference fixtures; repo always has them
    im = cv2.imread(p)
    # the load-bearing API: with the synth KNOWN (from §4's plugin-name OCR) the active tab is
    # recovered exactly. Tested rigorously across all three synths' pages.
    r = detect_active_tab(im, synth)
    check(f"real panel {fn}: active tab → {want}", r["tab"] == want, str(r))
    # identify_synth (synth UNKNOWN) is best-effort — it can cross-match visually-similar plugins
    # at low resolution — so we only assert it returns a self-consistent answer, never crashes.
    ids = identify_synth(im, ["serum", "serum1", "vital"])
    check(f"identify_synth on {fn} is coherent",
          ids["synth"] is not None and detect_active_tab(im, ids["synth"])["tab"] == ids["tab"], str(ids))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
