#!/usr/bin/env python3
"""Test for the FX ADD-RACK reader (fx_addrack.py) — Serum 2's dynamic "+ FX" rack, where modules
are ADDED (not a fixed list) and STACK per bus. This is the add-rack counterpart to the fixed-rack
detect_fx_chain (fx_rack_test.py). Asserts on REAL committed fixtures captured LIVE via computer-use
(Ableton-hosted Serum 2), plus graceful degradation, resolution-independence, and determinism.

Headline guards:
  • ORDER + NAMES: the 5-module MAIN chain reads exactly [Chorus, Distortion, Reverb, Delay,
    Compressor] in order, every name template-matched with wide confidence margin.
  • BUS naming under REFLOW: MAIN / BUS 1 / BUS 2 each read correctly even though the active tab
    widens and shifts the others.
  • HONEST degradation: Flanger (no template in the 5-effect bank) is still DETECTED as a present
    module but reported name=None / status="unidentified" — never a confident-wrong guess.

    python3 service/teardown/synth_from_screen/fx_addrack_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen.fx_addrack import read_addrack  # noqa: E402

PANELS = os.path.join(_HERE, "fixtures", "panels")
fails: list[str] = []

# the two real loaded fixtures' exact ordered chains (between them they exercise all 12 bank effects)
ID = ["Chorus", "Distortion", "Reverb", "Delay", "Compressor"]                       # serum2_fx_loaded (MAIN)
BUS2 = ["Flanger", "Bode", "Convolve", "Equalizer", "Filter", "Hyper/Dimension", "Phaser"]  # bus2_loaded


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def _img(fn):
    p = os.path.join(PANELS, fn)
    return cv2.imread(p) if os.path.isfile(p) else None


# ── REAL fixture: MAIN bus, 5 modules added (Chorus → Distortion → Reverb → Delay → Compressor) ──
loaded = _img("serum2_fx_loaded.png")
if loaded is not None:
    r = read_addrack(loaded, "serum")
    names = [m["name"] for m in r.get("chain", [])]
    check("loaded: active bus reads MAIN", r.get("bus") == "MAIN", str(r.get("bus")))
    check("loaded: EXACT ordered chain Chorus→Distortion→Reverb→Delay→Compressor",
          names == ["Chorus", "Distortion", "Reverb", "Delay", "Compressor"], str(names))
    check("loaded: every module identified", all(m["status"] == "identified" for m in r["chain"]),
          str([(m["name"], m["status"]) for m in r["chain"]]))
    check("loaded: every module on=True (presence = in-chain; bypass deferred)",
          all(m["on"] is True for m in r["chain"]))
    confs = [m["confidence"] for m in r.get("chain", [])]
    check("loaded: identified confidences all >= 0.88 (clear of match_min 0.82)",
          all(c >= 0.88 for c in confs), str(confs))
else:
    check("serum2_fx_loaded.png fixture present", False)

# ── REAL fixtures: empty buses → [] (and the correct bus name under tab REFLOW) ──
for fn, bus in [("serum2_fx_bus1_empty.png", "BUS 1"),
                ("serum2_fx_bus2_empty.png", "BUS 2"),
                ("serum2_fx.png", "MAIN")]:
    im = _img(fn)
    if im is not None:
        r = read_addrack(im, "serum")
        check(f"{fn}: bus={bus}, empty chain []",
              r.get("bus") == bus and r.get("chain") == [], str((r.get("bus"), r.get("chain"))))
    else:
        check(f"{fn} fixture present", False)

# ── BUS naming covers all three buses (reflow-robust) ──
buses_seen = set()
for fn in ["serum2_fx_loaded.png", "serum2_fx_bus1_empty.png", "serum2_fx_bus2_empty.png"]:
    im = _img(fn)
    if im is not None:
        buses_seen.add(read_addrack(im, "serum").get("bus"))
check("all three buses (MAIN/BUS 1/BUS 2) are distinctly named across fixtures",
      buses_seen == {"MAIN", "BUS 1", "BUS 2"}, str(buses_seen))

# ── REAL fixture: BUS 2 with the 7 OTHER bank effects (Flanger/Bode/Convolve/Equalizer/Filter/
#    Hyper-Dimension/Phaser) — exercises every bank template not on the MAIN fixture, in order ──
b2 = _img("serum2_fx_bus2_loaded.png")
if b2 is not None:
    r = read_addrack(b2, "serum")
    names = [m["name"] for m in r.get("chain", [])]
    check("bus2_loaded: active bus reads BUS 2", r.get("bus") == "BUS 2", str(r.get("bus")))
    check("bus2_loaded: EXACT ordered chain of the 7 other bank effects (incl. 'Hyper/Dimension')",
          names == BUS2, str(names))
    check("bus2_loaded: every module identified", all(m["status"] == "identified" for m in r["chain"]),
          str([(m["name"], m["status"]) for m in r["chain"]]))
else:
    check("serum2_fx_bus2_loaded.png fixture present", False)

# ── REAL fixture: Utility (the one FLAT routing util, distinct name) on BUS 1 — the 13th bank
#    effect. (Serum 2's 3 Splitters are NESTED band-split CONTAINERS, not flat modules, and their
#    variants share a "SPLITTER " prefix → deliberately NOT in the bank; see PANELS.md.) ──
ut = _img("serum2_fx_util.png")
if ut is not None:
    r = read_addrack(ut, "serum")
    check("util: BUS 1 + [Utility identified]",
          r.get("bus") == "BUS 1" and [m["name"] for m in r.get("chain", [])] == ["Utility"]
          and r["chain"][0]["status"] == "identified", str(r))
else:
    check("serum2_fx_util.png fixture present", False)

# ── honest degradation (LEAVE-ONE-OUT): drop each effect's template; its REAL row must read as
#    present-but-unidentified — NEVER mis-named as another bank effect. This is the misID-ceiling
#    guard on real rendered names (the 13-effect bank covers all audible FX + Utility). Uses the
#    public reader with a temporarily-reduced bank. ──
from teardown.synth_from_screen import fx_addrack as _M  # noqa: E402

def _read_minus(img, drop_name):
    real = _M._load_templates
    _M._load_templates = lambda synth, block: {k: v for k, v in real(synth, block).items() if k != drop_name}
    try:
        return read_addrack(img, "serum")
    finally:
        _M._load_templates = real

if loaded is not None and b2 is not None:
    misnamed = []          # (dropped_effect, what_it_got_mislabeled_as)
    bad_degrade = []
    loo = [(loaded, ID), (b2, BUS2)]
    if ut is not None:
        loo.append((ut, ["Utility"]))
    for im, expect in loo:
        for i, drop in enumerate(expect):
            tgt = _read_minus(im, drop)["chain"][i]   # the dropped effect's own row (rows are template-independent)
            if tgt["name"] is not None:
                misnamed.append((drop, tgt["name"]))  # matched a DIFFERENT bank template ≥ match_min → misID
            if not (tgt["status"] == "unidentified" and tgt["on"] is True):
                bad_degrade.append((drop, tgt["status"]))
    check("leave-one-out: a dropped effect is NEVER mis-named as another bank effect (misID ceiling, all 13)",
          not misnamed, str(misnamed))
    check("leave-one-out: a dropped effect's row stays present + status='unidentified'",
          not bad_degrade, str(bad_degrade))

# ── graceful degradation: never raise, never invent ──
blank = np.full((400, 400, 3), 20, np.uint8)
check("unknown synth → {}", read_addrack(blank, "nope") == {})
check("empty/None synth → {}", read_addrack(blank, "") == {} and read_addrack(blank, None) == {})
check("synth w/o fx_addrack block (vital) → {}", read_addrack(blank, "vital") == {})
check("Serum 1 (no fx_addrack block) → {}", read_addrack(blank, "serum1") == {})
check("None image → {} (no crash)", read_addrack(None, "serum") == {})
if loaded is not None:
    g = cv2.cvtColor(loaded, cv2.COLOR_BGR2GRAY)
    check("grayscale frame → {} (no crash)", read_addrack(g, "serum") == {})

# ── resolution sweep: count + bus survive at every scale; names need ~native res (downscale
#    degrades to unidentified, NEVER to a wrong name); upscale keeps full identification ──
if loaded is not None:
    for s in (0.66, 0.75, 1.5, 2.0):
        im = cv2.resize(loaded, (int(loaded.shape[1] * s), int(loaded.shape[0] * s)))
        r = read_addrack(im, "serum")
        names = [m["name"] for m in r.get("chain", [])]
        wrong = [n for n in names if n is not None and n not in ID]
        check(f"loaded @{s}x: bus MAIN, 5 rows, NO wrong name (≤honest unidentified)",
              r.get("bus") == "MAIN" and len(r.get("chain", [])) == 5 and not wrong,
              str((r.get("bus"), names)))
    # at >= native scale names must still be fully identified (the property real captures rely on)
    up = cv2.resize(loaded, (int(loaded.shape[1] * 2.0), int(loaded.shape[0] * 2.0)))
    check("loaded @2.0x: names still fully identified",
          [m["name"] for m in read_addrack(up, "serum").get("chain", [])] == ID)

# ── negative: a non-FX page must NOT fabricate a chain (the active-bus gate) ──
# GLOBAL/MIX have bright labels at the row positions; without the bus gate they'd hallucinate rows.
for fn in ("serum2_osc.png", "serum2_mix.png", "serum2_matrix.png", "serum2_global.png"):
    im = _img(fn)
    if im is not None:
        r = read_addrack(im, "serum")
        check(f"non-FX page {fn}: no active bus → no fabricated chain ([])",
              r.get("bus") is None and r.get("chain") == [], str((r.get("bus"), len(r.get("chain", [])))))

# ── zero-dimension 3-channel frame must NOT raise (never-raises contract) ──
for sh in ((10, 0, 3), (0, 5, 3)):
    try:
        check(f"zero-dim {sh} frame → {{}} (no crash)", read_addrack(np.zeros(sh, np.uint8), "serum") == {})
    except Exception as e:  # noqa: BLE001
        check(f"zero-dim {sh} frame → {{}} (no crash)", False, f"RAISED {type(e).__name__}")

# ── template-bank DISAMBIGUATION: the load-bearing margin claim, asserted not assumed ──
# (1) no two bank effects are mutually confusable; (2) each real row beats its runner-up by a margin.
from teardown.synth_from_screen.fx_addrack import _load_addrack, _load_templates  # noqa: E402

cfg = _load_addrack("serum")
if cfg is not None:
    tmpls = _load_templates("serum", cfg["block"])
    match_min = float(cfg["block"]["chain"].get("match_min", 0.70))
    check("template bank loaded (>=5 effects)", len(tmpls) >= 5, str(sorted(tmpls)))
    worst = 1.0
    for an, at in tmpls.items():
        for bn, bt in tmpls.items():
            if an == bn:
                continue
            s = float(cv2.matchTemplate(at, bt, cv2.TM_CCOEFF_NORMED)[0, 0])
            worst = min(worst, match_min - s)
    check("no two bank effects cross-match >= match_min (unambiguous bank)", worst > 0.0,
          f"closest pair within {match_min - worst:.3f} of threshold")
if loaded is not None and cfg is not None:
    # every identified row clears match_min with real headroom (its own confidence) — guards the
    # gap between the correct-match floor (~0.90) and match_min (0.82) so a bank drifting toward
    # ambiguity (a correct match sinking toward the threshold) fails the test.
    confs = [m["confidence"] for m in read_addrack(loaded, "serum")["chain"] if m["status"] == "identified"]
    check("every identified row clears match_min by >= 0.05 headroom",
          bool(confs) and all(c >= match_min + 0.05 for c in confs), str(confs))

# ── determinism: identical structured output across 3 reads ──
if loaded is not None:
    outs = [read_addrack(loaded, "serum") for _ in range(3)]
    check("read_addrack deterministic x3", outs[0] == outs[1] == outs[2])

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
