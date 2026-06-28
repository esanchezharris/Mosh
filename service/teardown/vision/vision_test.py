#!/usr/bin/env python3
"""Test for §2 detectors. The matching logic (daw/synth keyword) is checked via the text
path (deterministic, no OCR); piano-roll uses real cv2 on a synthetic grid; and one real
OCR round-trip (rendered text → ocr_text → parse) confirms the Tesseract primitive works.

    python3 service/teardown/vision/vision_test.py   (needs cv2 + PIL + tesseract)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.vision import daw_detect, ocr_text, piano_roll_present, synth_gui_present  # noqa: E402
from teardown.video2recipe.ocr import parse_key, parse_tempo  # noqa: E402

fails: list[str] = []
_BLANK = np.zeros((8, 8, 3), np.uint8)


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


_FONTS = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",
          "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/SFNS.ttf"]


def _font(sz):
    from PIL import ImageFont
    for p in _FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


def render_text(text, w=1100, h=200, sz=110):
    import cv2
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (w, h), "white")
    ImageDraw.Draw(im).text((20, 30), text, fill="black", font=_font(sz))
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def make_grid(w=600, h=400):
    import cv2
    img = np.full((h, w, 3), 30, np.uint8)
    for y in range(20, h, 24):
        cv2.line(img, (0, y), (w, y), (90, 90, 90), 1)   # ~16 horizontal lanes
    for x in range(40, w, 60):
        cv2.line(img, (x, 0), (x, h), (130, 130, 130), 1)  # ~9 vertical bars
    return img


# ── DAW / synth keyword logic (text path — deterministic) ────────────────────
check("daw_detect FL", daw_detect(_BLANK, text="FL Studio 21 — project.flp")["daw"] == "fl_studio")
check("daw_detect Ableton", daw_detect(_BLANK, text="Ableton Live 12 Suite")["daw"] == "ableton")
check("daw_detect Logic", daw_detect(_BLANK, text="Logic Pro session")["daw"] == "logic")
check("daw_detect unknown", daw_detect(_BLANK, text="some random window")["daw"] == "unknown")
check("synth Serum", synth_gui_present(_BLANK, text="SERUM  by Xfer Records")["plugin"] == "Serum")
check("synth Vital", synth_gui_present(_BLANK, text="Vital - wavetable")["plugin"] == "Vital")
check("synth none", synth_gui_present(_BLANK, text="a mixer view")["present"] is False)

# ── piano-roll on a synthetic grid (real cv2) ────────────────────────────────
check("piano_roll_present on a grid", piano_roll_present(make_grid())["present"] is True)
check("piano_roll_present on blank → False", piano_roll_present(np.full((400, 600, 3), 255, np.uint8))["present"] is False)

# ── real OCR round-trip (Tesseract on clean rendered text) ───────────────────
t = parse_tempo(ocr_text(render_text("Tempo  140 BPM")))
check("OCR→parse tempo = 140", t == 140, f"got {t}")
k = parse_key(ocr_text(render_text("Key  F# Minor")))
check("OCR→parse key = F# minor", k == "F# minor", f"got {k}")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
