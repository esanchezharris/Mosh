#!/usr/bin/env python3
"""Lane A — render-ahead ("Live") mechanics self-test (hermetic, fake adapter).

Proves the RenderAheadScheduler end to end on a real headless build WITHOUT SA3:
  1. ARM a wave clip → the layer reports liveArmed + a window count = ceil(clipLen / 8s).
  2. A wait-tick renders the due windows INLINE, incrementally stitches them (service
     /stitch_windows, 1ms), and REPOINTS the clip's source to the growing file → the layer
     goes appliedInPlace/ready and an export of the clip is the re-imagined audio (differs
     from the raw source).
  3. The stitched render-ahead file is full-length + non-silent, and every 8s window boundary
     is GAPLESS at the sample level (no discontinuity spike) — continuity by construction.
  4. A mid-play param change RE-LAYS from the playhead forward with the new params (a second
     export differs from the first).
  5. DISARM clears liveArmed (the consolidated file stays as the clip source).

Uses the fake adapter (MOSH_ENABLE_SA3=0) so it runs offline + deterministically. The real
by-ear SA3 gapless quality is the owner's gate (A0 already proved that with real SA3); this
locks the SCHEDULING / STITCH / REPOINT / RE-LAY mechanics against regression.

Run:  python3 scripts/verify-hardware/verify_render_ahead.py
      (auto-finds the release binary; override with MOSH_BIN=/path/to/Mosh)
"""
import glob
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify as V  # noqa: E402  (run_script / load_wav / mono / stats / diff_rms / _mosh_session_base / ART)
import numpy as np  # noqa: E402

SESSION = "verify-render-ahead"
WIN = float(os.environ.get("SA3_SECONDS", "8.0"))
CLIP_S = 20.0
FREQ = 173.0   # unique tone freq → never collides with a cached tone from another section


def _find(obj, key):
    """Depth-first: yield every dict in `obj` that carries `key`."""
    if isinstance(obj, dict):
        if key in obj:
            yield obj
        for v in obj.values():
            yield from _find(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from _find(v, key)


def _layer(snap):
    layers = list(_find(snap, "liveArmed"))
    return layers[0] if layers else {}


def boundary_gapless(path, win=WIN):
    """Max sample-diff at each stitch boundary vs the global p99.9 — a click would be a big
    outlier. Returns (ok, worst_ratio, boundaries)."""
    data, sr, _ = V.load_wav(path)
    m = V.mono(data)
    if m.size < sr:
        return False, 999.0, []
    diff = np.abs(np.diff(m))
    p99_9 = float(np.percentile(diff, 99.9)) + 1e-9
    dur = m.size / sr
    bounds = [win * k for k in range(1, int(np.ceil(dur / win)))]
    worst = 0.0
    for b in bounds:
        s = int(b * sr)
        lo, hi = max(0, s - int(0.03 * sr)), min(diff.size, s + int(0.03 * sr))
        if hi > lo:
            worst = max(worst, float(diff[lo:hi].max()) / p99_9)
    return (worst <= 3.0), round(worst, 2), [round(b, 1) for b in bounds]


def main():
    binary = os.environ.get("MOSH_BIN") or str(
        HERE.parent.parent / "build-macos-arm64-release" / "Mosh_artefacts" / "Release"
        / "Mosh.app" / "Contents" / "MacOS" / "Mosh")
    if not Path(binary).exists():
        print(f"FAIL: binary not found: {binary}")
        return 1

    out1 = V.ART / "ra_export_1.wav"
    out2 = V.ART / "ra_export_2.wav"
    raw_tone = V._session_dir(SESSION) / "audio" / f"tone-{int(FREQ)}.wav"
    ENV = {"MOSH_SERVICE_PORT": "8797", "MOSH_ENABLE_TRANSFORM": "0"}

    cmds = [
        {"command": "create_track", "args": {"name": "Live"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip",
         "args": {"trackId": "${T}", "seconds": CLIP_S, "freq": FREQ, "name": f"tone-{int(FREQ)}"},
         "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "fake"},
         "capture": {"L": "layerId"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "seed": 7}},
        {"command": "__snapshot", "args": {"label": "before_arm"}},
        {"command": "render_ahead_arm", "args": {"clipId": "${C}"}},
        {"command": "__snapshot", "args": {"label": "after_arm"}},
        # one wait-tick at the top: cw=0, lookahead=2 → renders all 3 windows of the 20s clip inline
        {"command": "render_ahead_tick", "args": {"playheadSec": 0.0, "wait": True}},
        {"command": "__snapshot", "args": {"label": "after_tick"}},
        {"command": "export_audio", "args": {"file": str(out1)}},
        # mid-play knob change → re-lay from the playhead with the new nl, then re-render inline
        {"command": "set_render_param", "args": {"clipId": "${C}", "nl": 0.95}},
        {"command": "render_ahead_tick", "args": {"playheadSec": 0.0, "wait": True}},
        {"command": "export_audio", "args": {"file": str(out2)}},
        {"command": "render_ahead_arm", "args": {"clipId": "${C}", "armed": False}},
        {"command": "__snapshot", "args": {"label": "after_disarm"}},
    ]

    results, proc = V.run_script(binary, cmds, SESSION, extra_env=ENV, timeout=180)
    fails = V.failed_commands(results)

    def snap(label):
        return V._snap_for(results, label)

    arm_res = next((r for r in results if r.get("command") == "render_ahead_arm" and r.get("ok")
                    and isinstance(r.get("data"), dict) and "windows" in r["data"]), {})
    tick_res = [r for r in results if r.get("command") == "render_ahead_tick" and r.get("ok")]

    lay_before = _layer(snap("before_arm"))
    lay_after_arm = _layer(snap("after_arm"))
    lay_after_tick = _layer(snap("after_tick"))
    lay_after_disarm = _layer(snap("after_disarm"))

    live_dir = V._session_dir(SESSION) / "renders"
    ra_files = sorted(glob.glob(str(live_dir / "**" / "live" / "render_ahead_*.wav"), recursive=True),
                      key=lambda p: int(Path(p).stem.split("_")[-1]))
    ra_final = ra_files[-1] if ra_files else None

    # ── assertions ──
    checks = {}
    checks["no_failed_commands"] = (not fails)
    checks["arm_reports_3_windows"] = (arm_res.get("data", {}).get("windows") == int(np.ceil(CLIP_S / WIN)))
    checks["not_live_before_arm"] = (lay_before.get("liveArmed") is False)
    checks["live_after_arm"] = (lay_after_arm.get("liveArmed") is True)
    checks["placed_all_windows"] = bool(tick_res) and tick_res[0].get("data", {}).get("placed") == int(np.ceil(CLIP_S / WIN))
    checks["applied_after_tick"] = (lay_after_tick.get("appliedInPlace") is True and lay_after_tick.get("status") == "ready")
    checks["disarm_clears_live"] = (lay_after_disarm.get("liveArmed") is False)

    ra_stat = V.stats(ra_final) if ra_final and Path(ra_final).exists() else {}
    checks["render_ahead_full_length"] = bool(ra_stat) and abs(ra_stat.get("duration_s", 0) - CLIP_S) < 0.6
    checks["render_ahead_non_silent"] = bool(ra_stat) and ra_stat.get("rms", 0) > 0.001

    gapless_ok, worst, bounds = (boundary_gapless(ra_final) if ra_final and Path(ra_final).exists() else (False, 999, []))
    checks["boundaries_gapless"] = gapless_ok

    # the clip's source IS the re-imagine now → export differs from the raw source tone
    reimagined = (out1.exists() and raw_tone.exists() and V.diff_rms(str(raw_tone), str(out1)) > 0.001)
    checks["export_is_reimagined"] = reimagined
    # the param change re-laid new audio → the two exports differ
    relay_changed = (out1.exists() and out2.exists() and V.diff_rms(str(out1), str(out2)) > 0.001)
    checks["param_change_relays"] = relay_changed

    ok = all(checks.values())
    print(json.dumps({
        "check": "render_ahead_mechanics",
        "ok": ok,
        "checks": checks,
        "detail": {
            "arm": arm_res.get("data"),
            "tick": [t.get("data") for t in tick_res],
            "render_ahead_file": ra_final,
            "render_ahead_stats": ra_stat,
            "boundary_worst_ratio": worst, "boundaries": bounds,
            "export1_vs_raw_rms": V.diff_rms(str(raw_tone), str(out1)) if (out1.exists() and raw_tone.exists()) else None,
            "export1_vs_export2_rms": V.diff_rms(str(out1), str(out2)) if (out1.exists() and out2.exists()) else None,
            "failed_commands": [f.get("command") for f in fails],
            "stderr_tail": proc.stderr[-500:] if not ok else "",
        },
    }, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
