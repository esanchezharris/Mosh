#!/usr/bin/env python3
"""REAL §5b proof — read patches off ACTUAL synth GUIs via calibrated profiles.

Covers both calibrated synths:
  • Vital  — captured from the free standalone (open -a Vital).
  • Serum 2 — captured via the Mosh HOST (Mosh --demo3 loads Serum 2 + opens its native
              editor; we screencapture the 'Serum 2' window). Serum has no standalone, so the
              hosted editor IS the capture path the owner asked for.

Each synth reads its ENV 1 ADSR off a frame and asserts the read is ABSOLUTELY correct on the
Init patch: SUSTAIN is the highest ADSR value AND reads ~full (~1.0), and the at-minimum knobs
read ~0. This is the white-pointer read (the colourless pointer line, ignoring the colour
fill-arc) — the fix that stopped a full arc's centroid from reading ~0.5.

Frame source per synth, in order: explicit <SYNTH>_FRAME=<png> → a fresh live capture (set
<SYNTH>_LIVE_CAPTURE=1; needs cv2 + Quartz + the app) → the committed reference fixture. Absent
all → SKIP (exit 0), so this never breaks the deterministic suite.

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
MOSH_BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"
HERE = os.path.dirname(os.path.abspath(__file__))


def _window_id(name_substr: str, by_title: bool, min_w: int = 700, min_h: int = 400):
    """Largest on-screen window whose owner (or title) matches, via Quartz (no Accessibility)."""
    try:
        import Quartz
        opt = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
        wins = Quartz.CGWindowListCopyWindowInfo(opt, Quartz.kCGNullWindowID)
        key = "kCGWindowName" if by_title else "kCGWindowOwnerName"
        hits = [w for w in wins if name_substr.lower() in str(w.get(key, "")).lower()
                and w.get("kCGWindowBounds", {}).get("Width", 0) >= min_w
                and w.get("kCGWindowBounds", {}).get("Height", 0) >= min_h]
        hits.sort(key=lambda w: -(w.get("kCGWindowBounds", {}).get("Width", 0)
                                  * w.get("kCGWindowBounds", {}).get("Height", 0)))
        return hits[0].get("kCGWindowNumber") if hits else None
    except Exception:
        return None


def _capture_window(launch, owner_or_title, by_title, quit_app, tries=15, gap=2.0) -> str | None:
    """Launch an app, poll for its target window, screencapture ONLY that window, quit. Never
    falls back to a full-screen grab (that would misalign the window-calibrated profile)."""
    launch()
    wid = None
    for _ in range(tries):
        time.sleep(gap)
        wid = _window_id(owner_or_title, by_title)
        if wid:
            time.sleep(2)
            break
    out = os.path.join(tempfile.mkdtemp(prefix="synthgui-"), "frame.png")
    if wid:
        subprocess.run(["screencapture", "-x", "-o", f"-l{wid}", out], check=False)
    quit_app()
    return out if (wid and os.path.isfile(out) and os.path.getsize(out) > 0) else None


def capture_vital() -> str | None:
    if not os.path.isdir(VITAL_APP):
        return None
    return _capture_window(lambda: subprocess.run(["open", "-a", "Vital"], check=False),
                           "vital", by_title=False,
                           quit_app=lambda: subprocess.run(["osascript", "-e", 'quit app "Vital"'], check=False))


def capture_serum() -> str | None:
    if not os.path.isfile(MOSH_BIN):
        return None
    env = dict(os.environ, MOSH_ENABLE_SA3="0")
    proc = subprocess.Popen([MOSH_BIN, "--demo3"], env=env)  # loads Serum 2 + opens its editor
    out = _capture_window(lambda: None, "Serum", by_title=True, tries=20,
                          quit_app=lambda: subprocess.run(["osascript", "-e", 'quit app "Mosh"'], check=False))
    try:
        proc.terminate(); time.sleep(1); proc.kill()
    except Exception:
        pass
    return out


# per-synth config: (fixture, capture fn, env prefix, ADSR keys in order, absolute expectations)
# controls_expect: hand-labeled [lo, hi] bounds for OSC/FILTER knobs on the Init patch, read off
# the VISIBLE pointer (pan/cutoff dead-centre → ~0.5; res/drive/wtpos at min → ~0; mix/rand at
# max → ~1; level high-but-not-max). The reader must land inside these to pass — real proof the
# OSC/filter coords + the blue_tick/white reader recover correct positions, not just the ENV row.
SYNTHS = {
    "vital": dict(
        fixture="vital_init.png", capture=capture_vital, env="VITAL",
        adsr=["env1_delay", "env1_attack", "env1_hold", "env1_decay", "env1_sustain", "env1_release"],
        at_min=["env1_delay", "env1_hold"], near_min=["env1_attack"],
        controls_expect={
            "osc1_pan": [0.42, 0.58], "osc1_unison": [0.42, 0.58], "osc1_phase": [0.42, 0.58],
            "osc1_level": [0.60, 0.85], "osc2_pan": [0.42, 0.58], "osc3_pan": [0.42, 0.58],
            "osc2_level": [0.60, 0.85], "osc3_level": [0.60, 0.85]}),
    "serum": dict(
        fixture="serum_init.png", capture=capture_serum, env="SERUM",
        adsr=["env1_attack", "env1_hold", "env1_decay", "env1_sustain", "env1_release"],
        at_min=["env1_hold"], near_min=["env1_attack"],
        controls_expect={
            "filter_cutoff": [0.42, 0.58], "filter_res": [0.0, 0.20], "filter_pan": [0.42, 0.58],
            "filter_drive": [0.0, 0.12], "filter_mix": [0.85, 1.0],
            "oscA_pan": [0.42, 0.58], "oscA_wtpos": [0.0, 0.12], "oscA_level": [0.60, 0.90],
            "oscB_pan": [0.42, 0.58], "oscC_pan": [0.42, 0.58], "noise_pan": [0.42, 0.58]}),
    # Serum 1 (the original): captured from the installed plugin hosted in Ableton (Mosh's host
    # crashes on it). No automated live-capture path — reads the committed fixture only.
    "serum1": dict(
        fixture="serum1_init.png", capture=lambda: None, env="SERUM1",
        adsr=["env1_attack", "env1_hold", "env1_decay", "env1_sustain", "env1_release"],
        at_min=["env1_hold"], near_min=["env1_attack"],
        controls_expect={
            "filter_cutoff": [0.42, 0.58], "filter_res": [0.0, 0.20], "filter_pan": [0.42, 0.58],
            "filter_drive": [0.0, 0.12], "filter_mix": [0.85, 1.0],
            "oscA_pan": [0.42, 0.58], "oscA_wtpos": [0.0, 0.12], "oscA_rand": [0.85, 1.0],
            "oscA_level": [0.60, 0.90], "oscB_pan": [0.42, 0.58], "oscB_rand": [0.85, 1.0],
            "sub_pan": [0.42, 0.58], "noise_pitch": [0.42, 0.58]}),
}


def _frame_for(cfg) -> str | None:
    fixture = os.path.join(HERE, "fixtures", cfg["fixture"])
    explicit = os.environ.get(f"{cfg['env']}_FRAME", "").strip() or None
    if explicit and os.path.isfile(explicit):
        return explicit
    if os.environ.get(f"{cfg['env']}_LIVE_CAPTURE") == "1":
        live = cfg["capture"]()
        if live:
            return live
    return fixture if os.path.isfile(fixture) else None


def _check_one(name: str, cfg: dict) -> int:
    """Returns 0 (pass/skip) or 1 (fail) for one synth."""
    import cv2
    from teardown.synth_from_screen.export import load_profile, read_patch

    frame = _frame_for(cfg)
    if not frame:
        print(f"[{name}] SKIP  no frame (fixture missing; install the app + {cfg['env']}_LIVE_CAPTURE=1)")
        return 0
    img = cv2.imread(frame)
    if img is None:
        print(f"[{name}] SKIP  could not read frame {frame}")
        return 0
    h, w = img.shape[:2]
    profile = load_profile(name, w, h, img)  # img → host-invariant (logo-landmark) calibration
    out = read_patch(img, profile)
    adsr = {k: out["params"][k] for k in cfg["adsr"] if k in out["params"]}
    print(f"[{name}] frame {w}x{h}; profile ({len(profile)} controls)")
    for k in cfg["adsr"]:
        if k in adsr:
            print(f"    {k:16s} = {adsr[k]:.3f}  conf {out['confidence'][k]:.2f}")

    fails = []
    if len(adsr) < len(cfg["adsr"]):
        fails.append(f"profile did not read all {len(cfg['adsr'])} ADSR knobs ({list(adsr)})")
    if adsr and not all(0.0 <= v <= 1.0 for v in adsr.values()):
        fails.append("a value left the normalized [0,1] range")
    if adsr and max(adsr, key=adsr.get) != "env1_sustain":
        fails.append(f"sustain not the highest ADSR value (got {max(adsr, key=adsr.get)})")
    if "env1_sustain" in adsr and adsr["env1_sustain"] < 0.90:
        fails.append(f"sustain absolute read too low ({adsr['env1_sustain']:.3f}; Init patch is "
                     f"full → expected ≥0.90 — the fill-arc is masking the pointer)")
    for k in cfg["at_min"]:
        if k in adsr and adsr[k] > 0.12:
            fails.append(f"{k} should sit at minimum on the Init patch (got {adsr[k]:.3f})")
    for k in cfg["near_min"]:
        if k in adsr and adsr[k] > 0.25:
            fails.append(f"{k} should be near-min on the Init patch (got {adsr[k]:.3f})")
    if adsr and min(out["confidence"][k] for k in adsr) < 0.6:
        fails.append("white-pointer read confidence below 0.6 — pointer not cleanly isolated")

    # OSC/FILTER knobs: assert each read lands inside its hand-labeled bound + reads confidently.
    expect = cfg.get("controls_expect", {})
    for k, (lo, hi) in expect.items():
        if k not in out["params"]:
            fails.append(f"{k} missing from the profile read")
            continue
        v = out["params"][k]
        print(f"    {k:16s} = {v:.3f}  conf {out['confidence'][k]:.2f}  (expect [{lo},{hi}])")
        if not (lo <= v <= hi):
            fails.append(f"{k} read {v:.3f} outside hand-labeled [{lo},{hi}]")
        if out["confidence"][k] < 0.6:
            fails.append(f"{k} read confidence {out['confidence'][k]:.2f} below 0.6")

    if fails:
        print(f"[{name}] FAIL: " + "; ".join(fails))
        return 1
    print(f"[{name}] PASS — white-pointer read recovers ABSOLUTE values (SUSTAIN ~full, at-min "
          f"knobs ~0); the colour fill-arc no longer masks the pointer.")
    return 0


def main() -> int:
    try:
        import cv2  # noqa: F401
        from teardown.synth_from_screen.export import load_profile  # noqa: F401
    except Exception as e:  # noqa: BLE001
        print(f"  SKIP  cv2/§5b unavailable ({e})")
        return 0
    rc = 0
    for name, cfg in SYNTHS.items():
        rc |= _check_one(name, cfg)
    return rc


if __name__ == "__main__":
    sys.exit(main())
