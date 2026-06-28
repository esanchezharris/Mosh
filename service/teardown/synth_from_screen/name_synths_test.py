#!/usr/bin/env python3
"""Test for §2 VISUAL synth naming (page_detect.name_synths_in_frames) — names a synth from its
on-screen GUI even when OCR can't read the stylized logo, so §4's skeleton creates the synth
element (which §5b enrich then reads). Deterministic + portable (committed fixtures; no binary).

Headline guards:
  • a real Vital GUI capture → ["Vital"]; a real Serum 2 capture → ["Serum 2"] (display names that
    §5b enrich's candidate resolution understands);
  • a non-GUI frame → [] (no spurious naming);
  • UNIQUENESS — a stubbed frame where two profiles both fire → that frame names nothing (the blind
    Vital↔Serum cross-fire can't mislabel);
  • deterministic 3×.

    python3 service/teardown/synth_from_screen/name_synths_test.py   (needs cv2/numpy)
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

import cv2  # noqa: E402

from teardown.synth_from_screen import page_detect as pd  # noqa: E402
from teardown.synth_from_screen.page_detect import name_synths_in_frames  # noqa: E402

FIX = os.path.join(_HERE, "fixtures")
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


vital = cv2.imread(os.path.join(FIX, "vital_init.png"))
serum = cv2.imread(os.path.join(FIX, "serum_init.png"))
gray = np.full((900, 1400, 3), 40, np.uint8)

if vital is None or serum is None:
    check("fixtures present (vital_init.png, serum_init.png)", False, FIX)
    print(f"\n{'ALL PASS' if not fails else 'FAILURES'}  ({len(fails)} failure(s))")
    sys.exit(len(fails))

check("Vital GUI capture → ['Vital']", name_synths_in_frames([vital]) == ["Vital"],
      str(name_synths_in_frames([vital])))
check("Serum 2 GUI capture → ['Serum 2']", name_synths_in_frames([serum]) == ["Serum 2"],
      str(name_synths_in_frames([serum])))
check("non-GUI frame → [] (no spurious name)", name_synths_in_frames([gray]) == [])
check("mixed frames → both synths named (deduped, sorted)",
      name_synths_in_frames([vital, gray, serum]) == ["Serum 2", "Vital"],
      str(name_synths_in_frames([vital, gray, serum])))
check("empty input → []", name_synths_in_frames([]) == [])
check("None/garbage frames tolerated → []", name_synths_in_frames([None, np.zeros((2, 0, 3), np.uint8)]) == [])

# ── uniqueness guard: a frame where TWO profiles fire → names nothing (no cross-fire mislabel) ──
_orig = pd.detect_active_tab
try:
    pd.detect_active_tab = lambda img, key: ({"tab": "X", "confidence": 0.9, "strength": 9.0}
                                             if key in ("serum", "serum1") else {"tab": None})
    check("two profiles fire on a frame → that frame names nothing (uniqueness)",
          name_synths_in_frames([gray]) == [], str(name_synths_in_frames([gray])))
    pd.detect_active_tab = lambda img, key: ({"tab": "X", "confidence": 0.9, "strength": 9.0}
                                             if key == "vital" else {"tab": None})
    check("exactly one profile fires → it is named", name_synths_in_frames([gray]) == ["Vital"],
          str(name_synths_in_frames([gray])))
finally:
    pd.detect_active_tab = _orig

# ── determinism ──────────────────────────────────────────────────────────────────────────────
outs = [tuple(name_synths_in_frames([vital, serum])) for _ in range(3)]
check("name_synths deterministic x3", outs[0] == outs[1] == outs[2], str(outs[0]))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
