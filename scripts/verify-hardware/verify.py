#!/usr/bin/env python3
"""Offline render-to-WAV hardware-verification harness for Mosh.

Drives `Mosh --run-script` to bounce the *real* signal chain to WAV files, then
asserts on their contents with numpy — proving the audio is actually produced
(not just that the command plumbing returns ok). Deterministic and headless: no
audio device, no one present. Audition the saved WAVs (in verify-artifacts/) any
time. See docs/VERIFICATION.md.

Usage:
    python3 scripts/verify-hardware/verify.py            # offline checks (1,2,3,5)
    python3 scripts/verify-hardware/verify.py --sa3      # also the SA3 transform check
    python3 scripts/verify-hardware/verify.py --bin <path-to-Mosh>
"""
import argparse
import json
import os
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
ART = REPO / "verify-artifacts"


# ── driving the binary ──────────────────────────────────────────────────────────
def find_binary(explicit=None):
    if explicit:
        return Path(explicit)
    for c in [
        REPO / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh",
        REPO / "build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh",
        Path("/Applications/Mosh.app/Contents/MacOS/Mosh"),
    ]:
        if c.exists():
            return c
    sys.exit("Mosh binary not found — build it (./run-mosh.sh build) or pass --bin")


def run_script(binary, commands, session, sa3=False, extra_env=None, timeout=180):
    """Write commands as JSONL, run `--run-script`, return (results, proc)."""
    spath = ART / f"{session}.script.jsonl"
    opath = ART / f"{session}.results.jsonl"
    spath.write_text("\n".join(json.dumps(c) for c in commands) + "\n")
    if opath.exists():
        opath.unlink()
    env = dict(os.environ)
    env.update({
        "MOSH_RUN_SCRIPT": str(spath),
        "MOSH_RUN_SCRIPT_OUT": str(opath),
        "MOSH_SELFTEST_SESSION": session,
        "MOSH_ENABLE_SA3": "1" if sa3 else "0",
    })
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run([str(binary), "--run-script"], env=env,
                          capture_output=True, text=True, timeout=timeout)
    results = []
    if opath.exists():
        for line in opath.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    results.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return results, proc


def failed_commands(results):
    return [r for r in results if not r.get("ok", False)]


# ── WAV analysis ────────────────────────────────────────────────────────────────
def load_wav(path):
    """Return (samples[ndarray, shape=(frames,) or (frames,ch)], samplerate, channels)."""
    with wave.open(str(path), "rb") as w:
        nframes, ch, sr, sw = w.getnframes(), w.getnchannels(), w.getframerate(), w.getsampwidth()
        raw = w.readframes(nframes)
    if sw == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sw == 3:  # 24-bit little-endian signed
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v & 0x800000, v - 0x1000000, v)
        data = v.astype(np.float64) / 8388608.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {sw} bytes")
    if ch > 1:
        data = data.reshape(-1, ch)
    return data, sr, ch


def mono(data):
    return data.mean(axis=1) if data.ndim > 1 else data


def stats(path):
    data, sr, ch = load_wav(path)
    m = mono(data)
    return {
        "samplerate": sr, "channels": ch, "frames": int(m.size),
        "duration_s": round(m.size / sr, 3) if sr else 0.0,
        "peak": round(float(np.max(np.abs(m))) if m.size else 0.0, 5),
        "rms": round(float(np.sqrt(np.mean(m ** 2))) if m.size else 0.0, 5),
    }


def diff_rms(a, b):
    """RMS of the sample-aligned difference of two WAVs (how different they are)."""
    ma, mb = mono(load_wav(a)[0]), mono(load_wav(b)[0])
    n = min(ma.size, mb.size)
    if n == 0:
        return 0.0
    return round(float(np.sqrt(np.mean((ma[:n] - mb[:n]) ** 2))), 5)


# ── scenarios ───────────────────────────────────────────────────────────────────
class Ctx:
    def __init__(self, binary):
        self.bin = binary


def row(name, passed, detail):
    return {"check": name, "pass": bool(passed), "detail": detail}


def check_makes_sound(ctx):
    out = ART / "01_makes_sound.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Tone"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-makes-sound")
    fails = failed_commands(results)
    if fails or not out.exists():
        return row("Makes sound", False, {"failed_commands": fails, "exists": out.exists(), "stderr": proc.stderr[-400:]})
    st = stats(out)
    ok = st["peak"] > 0.05 and st["rms"] > 0.01 and 1.0 < st["duration_s"] < 6.0
    return row("Makes sound", ok, {"wav": str(out), **st})


def check_drums(ctx):
    out = ART / "02_drums.wav"
    notes = []
    for beat in range(4):
        notes.append({"pitch": 36, "start": beat, "length": 0.5, "velocity": 120})       # kick on every beat
        if beat % 2 == 1:
            notes.append({"pitch": 38, "start": beat, "length": 0.5, "velocity": 110})    # snare on 2 & 4
        notes.append({"pitch": 42, "start": beat + 0.5, "length": 0.25, "velocity": 90})  # closed hat offbeats
    cmds = [
        {"command": "create_track", "args": {"name": "Drums", "type": "drum"}, "capture": {"T": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "start": 0, "length": 4, "notes": notes}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-drums")
    fails = failed_commands(results)
    if fails or not out.exists():
        return row("Drums audible", False, {"failed_commands": fails, "exists": out.exists(), "stderr": proc.stderr[-400:]})
    st = stats(out)
    ok = st["peak"] > 0.02 and st["rms"] > 0.002        # the silent-drums regression guard
    return row("Drums audible", ok, {"wav": str(out), **st})


def check_neural_ab(ctx):
    dry, wet = ART / "03_neural_dry.wav", ART / "03_neural_wet.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Neural"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}},
        {"command": "export_audio", "args": {"file": str(dry)}},                                    # dry reference
        {"command": "add_neural_insert", "args": {"trackId": "${T}", "modelId": "nam"}, "capture": {"NI": "index"}},
        {"command": "set_neural_param", "args": {"trackId": "${T}", "index": "${NI}", "paramId": "drive", "value": 95.0}},
        {"command": "set_neural_param", "args": {"trackId": "${T}", "index": "${NI}", "paramId": "mix", "value": 100.0}},
        {"command": "export_audio", "args": {"file": str(wet)}},                                    # neural-processed
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-neural-ab")
    fails = failed_commands(results)
    if fails or not (dry.exists() and wet.exists()):
        return row("Tier-A neural A/B", False, {"failed_commands": fails, "stderr": proc.stderr[-400:]})
    sdry, swet, d = stats(dry), stats(wet), diff_rms(dry, wet)
    ok = sdry["rms"] > 0.01 and swet["rms"] > 0.005 and d > 0.005    # both audible AND meaningfully different
    return row("Tier-A neural A/B", ok, {"dry": sdry, "wet": swet, "diff_rms": d})


def check_full_loop(ctx):
    out = ART / "05_full_loop.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Lead"}, "capture": {"T1": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T1}", "seconds": 2.0, "freq": 220.0}},
        {"command": "add_neural_insert", "args": {"trackId": "${T1}", "modelId": "nam"}, "capture": {"NI": "index"}},
        {"command": "set_neural_param", "args": {"trackId": "${T1}", "index": "${NI}", "paramId": "drive", "value": 60.0}},
        {"command": "set_track_volume", "args": {"trackId": "${T1}", "value": 0.8}},
        {"command": "create_track", "args": {"name": "Pad"}, "capture": {"T2": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T2}", "seconds": 2.0, "freq": 330.0}},
        {"command": "set_track_volume", "args": {"trackId": "${T2}", "value": 0.6}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-full-loop")
    fails = failed_commands(results)
    if fails or not out.exists():
        return row("Full producer loop", False, {"failed_commands": fails, "exists": out.exists(), "stderr": proc.stderr[-400:]})
    st = stats(out)
    ok = st["peak"] > 0.05 and st["rms"] > 0.01 and 1.0 < st["duration_s"] < 6.0
    return row("Full producer loop", ok, {"wav": str(out), **st})


OFFLINE_CHECKS = [check_makes_sound, check_drums, check_neural_ab, check_full_loop]


# ── main ────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Mosh offline render-to-WAV verification")
    ap.add_argument("--bin", help="path to the Mosh binary (default: newest local build)")
    ap.add_argument("--sa3", action="store_true", help="also run the SA3 generative-transform check (needs the service)")
    args = ap.parse_args()

    ART.mkdir(exist_ok=True)
    ctx = Ctx(find_binary(args.bin))
    print(f"binary: {ctx.bin}")
    print(f"artifacts: {ART}\n")

    rows = []
    for fn in OFFLINE_CHECKS:
        r = fn(ctx)
        rows.append(r)
        mark = "PASS" if r["pass"] else "FAIL"
        print(f"  [{mark}] {r['check']}")
        print(f"         {json.dumps(r['detail'])}")

    if args.sa3:
        from sa3_check import check_sa3_transform   # noqa: lazy import, optional
        r = check_sa3_transform(ctx, ART, run_script, stats, diff_rms, failed_commands)
        rows.append(r)
        print(f"  [{'PASS' if r['pass'] else 'FAIL'}] {r['check']}")
        print(f"         {json.dumps(r['detail'])}")

    report = ART / "report.json"
    report.write_text(json.dumps(rows, indent=2) + "\n")
    npass = sum(1 for r in rows if r["pass"])
    print(f"\n{npass}/{len(rows)} checks passed — report: {report}")
    return 0 if npass == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
