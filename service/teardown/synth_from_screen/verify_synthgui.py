#!/usr/bin/env python3
"""REAL §5b proof — read a patch off an ACTUAL synth GUI via a calibrated profile.

Captures the Vital standalone GUI (Init Preset), loads the calibrated profile
(profiles/vital.json, scaled to the frame), and reads ENV1's ADSR. The read is APPROXIMATE
by design (the §5b/§8 thesis: the screen gives a picture, §8 refines it) — so the assertion
is on the RELATIVE structure that a real read must get right: on the Init Preset, SUSTAIN is
the highest ADSR value, and every value is a valid normalized [0,1] with a confidence.

Needs cv2 (teardown venv) + Vital.app (for the capture) OR a pre-captured frame via
VITAL_FRAME=<png>. Absent either → SKIP (exit 0).

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/synth_from_screen/verify_synthgui.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

VITAL_APP = "/Applications/Vital.app"


def _vital_window_id():
    """The Vital GUI window id via Quartz (no Accessibility), or None. Skips tiny chrome
    windows (the real GUI is large)."""
    try:
        import Quartz
        opt = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
        wins = Quartz.CGWindowListCopyWindowInfo(opt, Quartz.kCGNullWindowID)
        vit = [w for w in wins if "vital" in str(w.get("kCGWindowOwnerName", "")).lower()
               and w.get("kCGWindowBounds", {}).get("Width", 0) >= 700
               and w.get("kCGWindowBounds", {}).get("Height", 0) >= 400]
        vit.sort(key=lambda w: -(w.get("kCGWindowBounds", {}).get("Width", 0)
                                 * w.get("kCGWindowBounds", {}).get("Height", 0)))
        return vit[0].get("kCGWindowNumber") if vit else None
    except Exception:
        return None


def capture_vital() -> str | None:
    """Open Vital, capture ONLY its GUI window (Quartz window-id). Polls up to ~30s for the
    window to render; returns None (→ SKIP) if it can't get a window-targeted shot — a
    full-screen fallback would misalign the window-calibrated profile, so we never do that."""
    if not os.path.isdir(VITAL_APP):
        return None
    subprocess.run(["open", "-a", "Vital"], check=False)
    wid = None
    for _ in range(15):                       # ~30s: Vital can be slow to first-render
        time.sleep(2)
        wid = _vital_window_id()
        if wid:
            time.sleep(1)                     # let it finish drawing
            break
    out = os.path.join(tempfile.mkdtemp(prefix="vital-cap-"), "vital.png")
    if wid:
        subprocess.run(["screencapture", "-x", "-o", f"-l{wid}", out], check=False)
    subprocess.run(["osascript", "-e", 'quit app "Vital"'], check=False)
    if wid and os.path.isfile(out) and os.path.getsize(out) > 0:
        return out
    return None


def main() -> int:
    try:
        import cv2
        from teardown.synth_from_screen.export import load_profile, read_patch
    except Exception as e:  # noqa: BLE001
        print(f"  SKIP  cv2/§5b unavailable ({e})")
        return 0

    # frame source, in order: explicit VITAL_FRAME → a fresh live window capture →
    # the committed reference fixture (a clean Vital window shot, so this is reproducible
    # even when live capture is flaky / Vital isn't installed).
    fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "vital_init.png")
    frame = os.environ.get("VITAL_FRAME", "").strip() or None
    if frame and not os.path.isfile(frame):
        frame = None
    if not frame and os.environ.get("VITAL_LIVE_CAPTURE") == "1":
        frame = capture_vital()
    if not frame and os.path.isfile(fixture):
        frame = fixture
        print("  (using committed reference fixture; set VITAL_LIVE_CAPTURE=1 to re-capture live)")
    if not frame:
        print("  SKIP  no Vital frame (fixture missing; install Vital.app + VITAL_LIVE_CAPTURE=1)")
        return 0

    img = cv2.imread(frame)
    if img is None:
        print(f"  SKIP  could not read frame {frame}")
        return 0
    h, w = img.shape[:2]
    profile = load_profile("vital", w, h)
    print(f"  frame {w}x{h}; profile 'vital' ({len(profile)} controls)")
    out = read_patch(img, profile)

    adsr = {k: out["params"][k] for k in
            ("env1_delay", "env1_attack", "env1_hold", "env1_decay", "env1_sustain", "env1_release")
            if k in out["params"]}
    for k, v in adsr.items():
        print(f"    {k:16s} = {v:.3f}  conf {out['confidence'][k]:.2f}")

    fails = []
    if len(adsr) < 6:
        fails.append(f"profile did not read all 6 ADSR knobs ({list(adsr)})")
    if adsr and not all(0.0 <= v <= 1.0 for v in adsr.values()):
        fails.append("a value left the normalized [0,1] range")
    if adsr and max(adsr, key=adsr.get) != "env1_sustain":
        fails.append(f"sustain not the highest ADSR value (got {max(adsr, key=adsr.get)}) — "
                     f"relative read wrong")
    if not all(0.0 <= c <= 1.0 for c in out["confidence"].values()):
        fails.append("a confidence left [0,1]")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print("\n  PASS — §5b read a REAL Vital GUI via the calibrated profile; ENV1 sustain is the "
          "highest ADSR value (relative structure correct; absolute values are §8-refined).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
