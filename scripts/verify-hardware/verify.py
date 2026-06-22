#!/usr/bin/env python3
"""Offline render-to-WAV hardware-verification harness for Mosh.

Drives `Mosh --run-script` to bounce the *real* signal chain to WAV files, then
asserts on their contents with numpy — proving the audio is actually produced
(not just that the command plumbing returns ok). Deterministic and headless: no
audio device, no one present. Audition the saved WAVs (in verify-artifacts/) any
time. See docs/VERIFICATION.md.

Usage:
    python3 scripts/verify-hardware/verify.py            # offline checks (makes-sound, drums, transform, full-loop)
    python3 scripts/verify-hardware/verify.py --sa3      # also the real SA3 transform check
    python3 scripts/verify-hardware/verify.py --bin <path-to-Mosh>
"""
import argparse
import glob
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


def _mosh_session_base():
    """Mosh's session base (JUCE userApplicationDataDirectory), OS-specific."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Mosh"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Mosh"
    return Path.home() / ".local" / "share" / "Mosh"


def check_transform(ctx):
    """Route B: the Tier-B transform render mode produces real, non-silent audio that
    differs from its input. Runs OFFLINE — the fake transform adapter is stdlib-only
    (no model, no SA3), so this is part of the default offline set. (The Tier-A neural
    A/B check was removed when the synthetic neural insert was; transform is the
    generative-coloration path now.)"""
    SESSION = "verify-transform"
    out = ART / "03_transform.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Xform"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "transform", "mode": "transform"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "target": "flute", "strength": 80, "seed": 1}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},   # blocks until rendered
        {"command": "accept_render", "args": {"clipId": "${C}"}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    # MOSH_ENABLE_TRANSFORM=0 pins the FAKE transform adapter so this deterministic check
    # is unaffected by any real RAVE models installed in RAVE_MODEL_DIR (the real path is
    # covered by --rave). Mirrors the selftest's hermetic gate.
    results, proc = run_script(ctx.bin, cmds, SESSION,
                               extra_env={"MOSH_SERVICE_PORT": "8795", "MOSH_ENABLE_TRANSFORM": "0"})
    fails = failed_commands(results)
    outputs = sorted(glob.glob(str(_mosh_session_base() / SESSION / "renders" / "*" / "output.wav")))
    if fails or not outputs:
        return row("Transform render (fake)", False,
                   {"failed_commands": fails, "exists": bool(outputs), "stderr": proc.stderr[-500:]})
    xout = outputs[0]
    job_dir = Path(xout).parent
    xin = job_dir / "input.wav"
    so = stats(xout)
    transformed = diff_rms(str(xin), xout) if xin.exists() else None
    mode = adapter = None
    manifest = job_dir / "output_manifest.json"
    if manifest.exists():
        try:
            m = json.loads(manifest.read_text())
            mode, adapter = m.get("mode"), m.get("adapter")
        except json.JSONDecodeError:
            pass
    final = stats(out) if out.exists() else None
    ok = (so["rms"] > 0.001 and (transformed is None or transformed > 0.001)
          and mode == "transform" and (final and final["rms"] > 0.001))
    return row("Transform render (fake)", ok,
               {"wav": str(xout), **so, "diff_from_input_rms": transformed,
                "mode": mode, "adapter": adapter, "final_export": str(out)})


def check_full_loop(ctx):
    out = ART / "05_full_loop.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Lead"}, "capture": {"T1": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T1}", "seconds": 2.0, "freq": 220.0}},
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


def check_relative_ref_export(ctx):
    """Regression guard for the export-on-MP-audio-clip hang. A wave clip relinked to a
    co-located source on an unsaved edit stores a RELATIVE reference (the same shape
    mp_commit_track produces). Before the fix that ref mis-resolved to a non-existent
    path → the offline render recursed forever (ArrangerLauncherSwitchingNode) and
    export never returned. Asserts the export COMPLETES (no hang — a regression shows as
    a timeout) and is non-silent. Engine-only (no service / no models)."""
    SESSION = "verify-relref"
    out = ART / "06_relative_ref_export.wav"
    tone = _mosh_session_base() / SESSION / "audio" / "tone.wav"   # add_test_tone_clip writes here
    cmds = [
        {"command": "create_track", "args": {"name": "A"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0, "name": "tone"}, "capture": {"C": "clipId"}},
        {"command": "relink_clip", "args": {"clipId": "${C}", "file": str(tone)}},   # co-located → RELATIVE ref
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    try:
        results, proc = run_script(ctx.bin, cmds, SESSION, timeout=90)
    except subprocess.TimeoutExpired:
        return row("Relative-ref export (MP-hang guard)", False,
                   {"error": "export HUNG (timed out) — the MP/relative-source export hang regressed"})
    fails = failed_commands(results)
    if fails or not out.exists():
        return row("Relative-ref export (MP-hang guard)", False,
                   {"failed_commands": fails, "exists": out.exists(), "stderr": proc.stderr[-300:]})
    st = stats(out)
    ok = st["rms"] > 0.001 and st["peak"] > 0.01
    return row("Relative-ref export (MP-hang guard)", ok, {"wav": str(out), **st})


OFFLINE_CHECKS = [check_makes_sound, check_drums, check_transform, check_full_loop, check_relative_ref_export]


# ── main ────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Mosh offline render-to-WAV verification")
    ap.add_argument("--bin", help="path to the Mosh binary (default: newest local build)")
    ap.add_argument("--sa3", action="store_true", help="also run the SA3 generative-transform check (needs the service)")
    ap.add_argument("--rave", action="store_true", help="also run the real RAVE transform-path check (needs service/transform/.venv)")
    ap.add_argument("--rave-insert", action="store_true", help="also run the real-time RAVE insert offline-render check (needs an anira build + service/transform/.venv)")
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

    if args.rave:
        from rave_check import check_rave   # noqa: lazy import, optional
        r = check_rave(ctx)
        rows.append(r)
        print(f"  [{'PASS' if r['pass'] else 'FAIL'}] {r['check']}")
        print(f"         {json.dumps(r['detail'])}")

    if args.rave_insert:
        from rave_insert_check import check_rave_insert   # noqa: lazy import, optional
        r = check_rave_insert(ctx, ART, run_script, stats, diff_rms, failed_commands)
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
