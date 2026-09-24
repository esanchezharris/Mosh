#!/usr/bin/env python3
"""Render each bundled 4OSC preset (and the default 4OSC) on a 4-bar progression.

One --run-script per render (state never spans invocations), isolated harness session
(_harness/demo-native-render-*), MOSH_NO_AUDIO=1, MOSH_ENABLE_SA3=0 and a caller-chosen
MOSH_SERVICE_PORT (so a helper it may spawn never collides with the owner's). Renders the
presets STAGED IN THE GIVEN APP BUNDLE (Contents/Resources/presets/4osc), on Am-F-C-G whole
-note triads at 90 BPM (Bass: single roots A1-F1-C2-G1), plus the default 4OSC for
comparison. Writes <out>/<name>.wav + <out>/summary.json (peak/RMS dBFS over both channels,
mono spectral centroid). 4OSC starts each voice at a random phase, so peaks move by ~1-2 dB
between runs; RMS and centroid are stable.
usage: render_4osc_presets.py <Mosh binary> <out dir> [service port, default 18880]
"""
import json, math, os, subprocess, sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "verify-hardware"))
import verify as V  # noqa: E402  (load_wav / mono / spectral_centroid)

BIN = Path(sys.argv[1])
OUT = Path(sys.argv[2])
PORT = sys.argv[3] if len(sys.argv) > 3 else "18880"
PRESET_DIR = BIN.parents[1] / "Resources" / "presets" / "4osc"
SCRATCH = OUT / "_run"   # scripts, results and stderr per render
OUT.mkdir(parents=True, exist_ok=True)
SCRATCH.mkdir(parents=True, exist_ok=True)

BPM = 90.0
BAR_S = 4 * 60.0 / BPM            # 2.6667 s
LEN_S = 4 * BAR_S                 # 10.6667 s
CHORDS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]   # Am  F  C  G
BASS_ROOTS = [[33], [29], [36], [31]]                                # A1 F1 C2 G1


def script(name, preset_file, bars):
    cmds = [
        {"command": "set_tempo", "args": {"bpm": BPM}},
        {"command": "create_track", "args": {"name": name}, "capture": {"T": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "start": 0.0, "length": LEN_S},
         "capture": {"C": "clipId"}},
    ]
    for bar, pitches in enumerate(bars):
        for p in pitches:
            cmds.append({"command": "add_note", "args": {"clipId": "${C}", "pitch": p, "start": bar * 4.0,
                                                          "length": 3.95, "velocity": 100}})
    if preset_file:
        cmds.append({"command": "load_preset", "args": {"trackId": "${T}", "file": str(preset_file)}})
    cmds.append({"command": "__snapshot", "args": {"label": "final"}})
    return cmds


def run(leaf, cmds, wav):
    cmds = cmds + [{"command": "export_audio", "args": {"file": str(wav), "range": "custom", "start": 0.0,
                                                          "end": round(LEN_S, 3), "tail": "cut"}}]
    spath, opath = SCRATCH / f"{leaf}.script.jsonl", SCRATCH / f"{leaf}.results.jsonl"
    spath.write_text("\n".join(json.dumps(c) for c in cmds) + "\n")
    if opath.exists():
        opath.unlink()
    if wav.exists():
        wav.unlink()
    env = dict(os.environ)
    env.update({"MOSH_RUN_SCRIPT": str(spath), "MOSH_RUN_SCRIPT_OUT": str(opath),
                "MOSH_SELFTEST_SESSION": f"_harness/{leaf}", "MOSH_NO_AUDIO": "1", "MOSH_ENABLE_SA3": "0",
                "MOSH_SERVICE_PORT": PORT})
    proc = subprocess.run([str(BIN), "--run-script", "-ApplePersistenceIgnoreState", "YES"], env=env,
                          capture_output=True, text=True, timeout=300)
    (SCRATCH / f"{leaf}.stderr.log").write_text(proc.stderr[-20000:])
    results = [json.loads(l) for l in opath.read_text().splitlines() if l.strip()] if opath.exists() else []
    bad = [r for r in results if not r.get("ok", False)]
    if proc.returncode != 0 or bad or not wav.exists():
        raise SystemExit(f"{leaf}: rc={proc.returncode} failed={bad[:3]}")
    lp = next((r for r in results if r.get("command") == "load_preset"), None)
    return lp.get("data") if lp else None


def features(wav):
    data, sr, ch = V.load_wav(wav)
    allv = np.abs(data)
    peak = float(allv.max()) if allv.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(data)))) if data.size else 0.0
    m = V.mono(data)
    return {
        "samplerate": sr, "channels": ch, "seconds": round(m.size / sr, 3),
        "peak_dbfs": round(20 * math.log10(max(peak, 1e-12)), 2),
        "rms_dbfs": round(20 * math.log10(max(rms, 1e-12)), 2),
        "centroid_hz": round(float(V.spectral_centroid(m, sr)), 1),
        "clipped_samples": int(np.sum(allv >= 0.999)),
    }


if __name__ == "__main__":
    renders = [("_default-4osc", None, CHORDS)]
    for name in ["Keys", "Bass", "Pad", "Lead", "Pluck"]:
        renders.append((name, PRESET_DIR / f"{name}.json", BASS_ROOTS if name == "Bass" else CHORDS))
    renders.append(("Bass-on-chords", PRESET_DIR / "Bass.json", CHORDS))   # what the demo does: Keys track → Bass
    renders.append(("_default-4osc-bass-roots", None, BASS_ROOTS))       # the sine baseline for the Bass roots
    summary = {}
    for name, pf, bars in renders:
        wav = OUT / f"{name}.wav"
        leaf = "demo-native-render-" + name.strip("_").lower()
        applied = run(leaf, script(name, pf, bars), wav)
        f = features(wav)
        f["load_preset"] = applied
        summary[name] = f
        print(f"{name:16s} peak {f['peak_dbfs']:7.2f} dBFS  rms {f['rms_dbfs']:7.2f} dBFS  "
              f"centroid {f['centroid_hz']:8.1f} Hz  clipped {f['clipped_samples']}  {f['seconds']} s")
    (OUT / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
