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
import hashlib
import json
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
ART = REPO / "verify-artifacts"
GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
GOLDEN_MANIFEST = GOLDEN_DIR / "manifest.json"


# ── driving the binary ──────────────────────────────────────────────────────────
def find_binary(explicit=None):
    if explicit:
        return Path(explicit)
    # "newest local build" for real: a stale Debug tree must not shadow a fresh
    # Release rebuild (it silently verified 6-day-old code once — pick by mtime).
    candidates = [c for c in [
        REPO / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh",
        REPO / "build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh",
        Path("/Applications/Mosh.app/Contents/MacOS/Mosh"),
    ] if c.exists()]
    if candidates:
        return max(candidates, key=lambda c: c.stat().st_mtime)
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


def _service_port(preferred):
    """The preferred service port if nothing is listening there, else a fresh OS-assigned
    free port. Mosh ADOPTS any healthy service already on its port — including a foreign
    session's, running with THAT session's env instead of this run's pins
    (MOSH_ENABLE_TRANSFORM=0 etc.), which false-fails checks in undiagnosable ways
    (proven: an orphaned real-RAVE service squatting 8801 broke check_reactive_rerender
    with "no RAVE model for target ''"). Probing keeps the historical ports when quiet."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", int(preferred)))
            return str(preferred)
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return str(s.getsockname()[1])


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


# ── golden-audio gate ─────────────────────────────────────────────────────────
# `--selftest` proves commands dispatch; it does NOT prove the SAMPLES are right.
# This turns the offline renders into a regression GATE: bit-deterministic engine/stdlib
# paths get an exact SHA-256 baseline; every case also carries a small feature vector so a
# checksum miss is DIAGNOSABLE (which feature moved) instead of opaque. Model paths (real
# SA3 / real RAVE) are never checksummed — they stay on the perceptual bounds in their own
# checks. Regenerate intentionally on a real DSP/adapter change with `--update-golden`
# (human-eyeballed diff). WAVs are gitignored; we commit checksums + features, never audio.
def pcm_sha256(path):
    """SHA-256 of the decoded PCM FRAMES only — deliberately excludes the WAV header. JUCE
    writes a non-deterministic header (a bext/timestamp chunk varies run-to-run by ~784
    bytes), but the audio SAMPLES are bit-deterministic, so the frames are the honest
    fingerprint of "did the render change"."""
    with wave.open(str(path), "rb") as w:
        frames = w.readframes(w.getnframes())
    return hashlib.sha256(frames).hexdigest()


def spectral_centroid(m, sr):
    """Magnitude-weighted mean frequency (Hz) over a Hann-windowed whole-signal rFFT — a
    cheap, stable tonal feature that explains a checksum miss a bare RMS can't."""
    if m.size < 2 or not sr:
        return 0.0
    spec = np.abs(np.fft.rfft(m * np.hanning(m.size)))
    freqs = np.fft.rfftfreq(m.size, d=1.0 / sr)
    tot = float(spec.sum())
    return round(float((freqs * spec).sum() / tot), 1) if tot > 0 else 0.0


def wav_features(path):
    data, sr, _ = load_wav(path)
    m = mono(data)
    return {
        "frames": int(m.size),
        "peak": round(float(np.max(np.abs(m))) if m.size else 0.0, 5),
        "rms": round(float(np.sqrt(np.mean(m ** 2))) if m.size else 0.0, 5),
        "centroid_hz": spectral_centroid(m, sr),
    }


# Bit-deterministic offline renders → checksum baselines. Keyed by a stable case name; the
# WAV is the one the matching OFFLINE check writes. Relational checks (bypass/relref/
# portability) and the non-deterministic synth-bounce (midi_render) are deliberately NOT
# checksum-gated. transform_fake is keyed to the fake adapter's stdlib determinism.
GOLDEN_SPEC = {
    "makes_sound":    ART / "01_makes_sound.wav",
    "drums":          ART / "02_drums.wav",
    "transform_fake": ART / "03_transform.wav",
    "full_loop":      ART / "05_full_loop.wav",
    # DAW-parity P4: goldens ONLY where silent drift evades property checks — the fade
    # curve SHAPE and the master summing path. Budget-capped: prefer relational checks.
    "clip_fades":     ART / "11_fades_faded.wav",
    "master_gain":    ART / "12_master_gain.wav",
}
# Per-feature absolute tolerances for the diagnostic readout on a checksum miss.
FEATURE_TOL = {"peak": 0.002, "rms": 0.002, "centroid_hz": 3.0, "frames": 0}


def _feature_diff(now, base):
    out = {}
    for k, v in now.items():
        b = base.get(k)
        if b is None:
            out[k] = {"now": v, "golden": None}
            continue
        delta = round(abs(v - b), 5)
        if delta > FEATURE_TOL.get(k, 0):
            out[k] = {"now": v, "golden": b, "delta": delta, "tol": FEATURE_TOL.get(k, 0)}
    return out


def run_golden_gate(update=False):
    """Compare each produced deterministic WAV to its committed baseline (or rewrite the
    baseline when update=True). Returns (rows, manifest) — rows fold into the main verdict."""
    golden = {}
    if GOLDEN_MANIFEST.exists():
        try:
            golden = json.loads(GOLDEN_MANIFEST.read_text()).get("cases", {})
        except json.JSONDecodeError:
            golden = {}

    rows, new_cases = [], {}
    for key, wav in GOLDEN_SPEC.items():
        if not Path(wav).exists():
            rows.append(row(f"golden:{key}", False, {"error": "WAV not produced (its check failed?)", "wav": str(wav)}))
            continue
        sha, feats = pcm_sha256(wav), wav_features(wav)
        new_cases[key] = {"kind": "checksum", "pcm_sha256": sha, "features": feats}
        if update:
            rows.append(row(f"golden:{key}", True, {"updated": True, "sha": sha[:12], **feats}))
            continue
        g = golden.get(key)
        if not g:
            rows.append(row(f"golden:{key}", False, {"error": "no baseline — run verify.py --update-golden", "sha": sha[:12]}))
            continue
        ok = sha == g.get("pcm_sha256")
        detail = {"match": ok, "sha": sha[:12], "golden_sha": str(g.get("pcm_sha256"))[:12]}
        if not ok:
            detail["feature_diff"] = _feature_diff(feats, g.get("features", {}))
        rows.append(row(f"golden:{key}", ok, detail))

    if update:
        GOLDEN_DIR.mkdir(exist_ok=True)
        manifest = {
            "schemaVersion": 1,
            "engine": {"sampleRate": 44100, "blockSize": 512, "note": "canonical macOS arm64 build"},
            "cases": new_cases,
        }
        GOLDEN_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    return rows


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
                               extra_env={"MOSH_SERVICE_PORT": _service_port(8795), "MOSH_ENABLE_TRANSFORM": "0"})
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
    mode = adapter = reasoning = None
    manifest = job_dir / "output_manifest.json"
    if manifest.exists():
        try:
            m = json.loads(manifest.read_text())
            mode, adapter = m.get("mode"), m.get("adapter")
            reasoning = m.get("reasoning")   # AL-006: judge's human-readable readout
        except json.JSONDecodeError:
            pass
    final = stats(out) if out.exists() else None
    # AL-006: the judge-panel reasoning must ride the manifest so the drawer can explain
    # the score (not just print pq). Asserted on the offline fake path that the native
    # gate always exercises.
    has_reasoning = isinstance(reasoning, str) and len(reasoning) > 0
    ok = (so["rms"] > 0.001 and (transformed is None or transformed > 0.001)
          and mode == "transform" and has_reasoning and (final and final["rms"] > 0.001))
    return row("Transform render (fake)", ok,
               {"wav": str(xout), **so, "diff_from_input_rms": transformed,
                "mode": mode, "adapter": adapter, "reasoning": reasoning,
                "final_export": str(out)})


def check_compile_render(ctx):
    """L1: the prompt compiler turns a loose instruction into a VALIDATED render envelope,
    applies it to the clip's render layer (the SAME PARAMS set_render_param writes), and the
    resulting render is non-silent + differs from the input. Generative-only, fake-pinned
    (backend:"fake" forces the deterministic compiler), offline — no LLM, no SA3. Proves the
    native compile_render → render_layer → WAV path end to end."""
    SESSION = "verify-compile"
    out = ART / "08_compile.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Comp"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        # one command compiles "make it gritty and lo-fi" → a re-imagine envelope (grit colour
        # + nl) and applies it to a fresh render layer (adapter defaults to fake here).
        {"command": "compile_render", "args": {"clipId": "${C}", "instruction": "make it gritty and lo-fi", "backend": "fake", "wait": True}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "accept_render", "args": {"clipId": "${C}"}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION, extra_env={"MOSH_SERVICE_PORT": _service_port(8796)})
    fails = failed_commands(results)
    comp = next((r for r in results if r.get("command") == "compile_render"), None)
    cdata = (comp or {}).get("data", {}) or {}
    outputs = sorted(glob.glob(str(_mosh_session_base() / SESSION / "renders" / "*" / "output.wav")))
    detail = {"failed_commands": fails, "compile": cdata}
    if fails or not outputs:
        detail["stderr"] = proc.stderr[-500:]
        return row("Compile render (fake, generative-only)", False, detail)
    xout = outputs[0]
    xin = Path(xout).parent / "input.wav"
    so = stats(xout)
    differs = diff_rms(str(xin), xout) if xin.exists() else None
    final = stats(out) if out.exists() else None
    ok = (cdata.get("mode") == "reimagine" and cdata.get("backend") == "fake"
          and so["rms"] > 0.001 and (differs is None or differs > 0.001)
          and final and final["rms"] > 0.001)
    detail.update({"wav": str(xout), **so, "diff_from_input_rms": differs,
                   "mode": cdata.get("mode"), "backend": cdata.get("backend"),
                   "reasoning": cdata.get("reasoning"), "final_export": str(out)})
    return row("Compile render (fake, generative-only)", ok, detail)


def check_compile_corrective(ctx):
    """L1.1 honest boundary: compile_render classifies a CORRECTIVE request, names the
    corrective tool (AutoTune/etc.) the caller should run, and MUTATES NOTHING — no render
    layer, no re-performed audio. Generative-only, fake-pinned, offline."""
    SESSION = "verify-compile-corr"
    cmds = [
        {"command": "create_track", "args": {"name": "C"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "compile_render", "args": {"clipId": "${C}", "instruction": "fix the tuning, it's pitchy", "backend": "fake", "wait": True}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION, extra_env={"MOSH_SERVICE_PORT": _service_port(8798)})
    fails = failed_commands(results)
    comp = next((r for r in results if r.get("command") == "compile_render"), None)
    cdata = (comp or {}).get("data", {}) or {}
    outputs = glob.glob(str(_mosh_session_base() / SESSION / "renders" / "*" / "output.wav"))
    ok = (not fails and cdata.get("mode") == "corrective" and cdata.get("subtype") == "pitch"
          and cdata.get("tool") == "moshAutoTune" and not outputs)   # named the tool, rendered nothing
    return row("Compile corrective (honest boundary)", ok,
               {"failed_commands": fails, "mode": cdata.get("mode"), "subtype": cdata.get("subtype"),
                "tool": cdata.get("tool"), "rendered_outputs": len(outputs),
                "stderr": proc.stderr[-300:] if not ok else ""})


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


def check_export_range_tail(ctx):
    """G1: export_audio range (invariant 78) + delay-tail policy (invariant 81), proven on
    the ACTUAL rendered WAV — `--selftest` only checks the command's reported
    seconds/rangeStart/rangeEnd fields, never the bytes that hit disk. A 4s tone: the full
    export's real duration is ~4s; a custom [1,3] range's real duration is ~2s and its
    frame count is smaller than the full render's — direct hardware proof that only the
    requested span was rendered (not the whole edit, trimmed after the fact). Then the tail
    policy: load a reverb pushed hot (big room, fully wet) so its decay rings well past a
    short render's end, and compare tail:'cut' vs tail:'include' on the IDENTICAL [0,1]
    custom range — tail:'include' must produce a measurably LONGER actual WAV (it captured
    the ringing decay), while tail:'cut' stays at ~the requested span. Engine-only (no
    service / no models), offline."""
    SESSION = "verify-export-range-tail"
    full_out = ART / "10_export_full.wav"
    custom_out = ART / "10_export_custom.wav"
    cut_out = ART / "10_export_tail_cut.wav"
    include_out = ART / "10_export_tail_include.wav"
    countin_out = ART / "10_export_countin.wav"

    cmds = [
        {"command": "create_track", "args": {"name": "RangeTail"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 4.0, "freq": 220.0}},
        # Full export (no range args) — the un-ranged baseline.
        {"command": "export_audio", "args": {"file": str(full_out)}},
        # Custom [1,3] range — invariant 78: a shorter requested span -> a shorter actual render.
        {"command": "export_audio", "args": {"file": str(custom_out),
                                             "range": "custom", "start": 1.0, "end": 3.0}},
        # A hot reverb so tail:'include' has something audible to capture past the range end.
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": "reverb"}, "capture": {"RV": "index"}},
        {"command": "set_plugin_param", "args": {"trackId": "${T}", "index": "${RV}", "paramIndex": 0, "value": 0.95}},
        {"command": "set_plugin_param", "args": {"trackId": "${T}", "index": "${RV}", "paramIndex": 2, "value": 1.0}},
        # tail:'cut' vs tail:'include' on the SAME [0,1] custom range — invariant 81.
        {"command": "export_audio", "args": {"file": str(cut_out),
                                             "range": "custom", "start": 0.0, "end": 1.0, "tail": "cut"}},
        {"command": "export_audio", "args": {"file": str(include_out),
                                             "range": "custom", "start": 0.0, "end": 1.0,
                                             "tail": "include", "tailSeconds": 2.0}},
        # Count-in must NEVER leak into a render (the pre-roll is a monitoring aid, not
        # song time): with 2 count-in bars set, the identical custom export is frame-
        # identical to the one above.
        {"command": "set_count_in", "args": {"bars": 2}},
        {"command": "export_audio", "args": {"file": str(countin_out),
                                             "range": "custom", "start": 1.0, "end": 3.0}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION)
    fails = failed_commands(results)
    outs = (full_out, custom_out, cut_out, include_out, countin_out)
    if fails or not all(p.exists() for p in outs):
        return row("Export range + tail (G1)", False,
                   {"failed_commands": fails,
                    "exists": {p.name: p.exists() for p in outs},
                    "stderr": proc.stderr[-500:]})

    full_st, custom_st, cut_st, include_st, countin_st = (stats(p) for p in outs)

    # invariant 78: the requested SPAN, not the whole edit, is what was actually rendered —
    # EXACTLY, on the deterministic no-tail path: a [1,3] custom range is (3-1)*sr frames,
    # not "about 2 seconds".
    exact_frames = int(round(2.0 * custom_st["samplerate"]))
    range_ok = (3.5 < full_st["duration_s"] < 4.5
                and custom_st["frames"] == exact_frames
                and custom_st["frames"] < full_st["frames"])

    # invariant 81: tail:'include' must make the ACTUAL rendered WAV measurably longer
    # than tail:'cut' on the identical range (it captured the reverb decay past the
    # requested end), while tail:'cut' stays close to the requested 1s span.
    tail_ok = (0.7 < cut_st["duration_s"] < 1.5
               and include_st["duration_s"] > cut_st["duration_s"] + 0.5
               and include_st["frames"] > cut_st["frames"])

    # invariant 5: count-in bars change NOTHING about an export.
    countin_ok = countin_st["frames"] == custom_st["frames"]

    ok = range_ok and tail_ok and countin_ok
    return row("Export range + tail (G1)", ok,
               {"full": full_st, "custom": custom_st, "tail_cut": cut_st, "tail_include": include_st,
                "custom_frames_exact": custom_st["frames"] == exact_frames,
                "countin_excluded": countin_ok,
                "range_ok": range_ok, "tail_ok": tail_ok})


def check_bypass_layer(ctx):
    """AL-008: bypass_layer must RE-ROUTE real audio, not just flip a ValueTree flag.

    A/B over three exports of the SAME edit:
      A (original)  — export the bare tone before any render layer exists.
      B (rendered)  — accept the transform render so the neural clip lands and PLAYS;
                      the mix now differs from the original (the model coloured it).
      C (bypassed)  — bypass_layer{true} mutes the landed neural clip; the mix must
                      collapse BACK to the original tone.

    Asserts: C ≈ A  (bypass restores the original — diff-RMS ~0)  AND
             B ≠ A  (the accepted render genuinely changed the audio — diff-RMS >> 0).
    Before the fix bypass_layer only set status=bypassed, so the landed neural clip
    kept playing → C still differed from A and this check FAILS (the RED that proves
    it). Uses the stdlib fake transform adapter (offline, MOSH_ENABLE_TRANSFORM=0)."""
    SESSION = "verify-bypass"
    orig = ART / "07a_bypass_original.wav"
    rendered = ART / "07b_bypass_rendered.wav"
    bypassed = ART / "07c_bypass_bypassed.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Byp"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "export_audio", "args": {"file": str(orig)}},                                      # A: original
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "transform", "mode": "transform"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "target": "flute", "strength": 80, "seed": 1}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "accept_render", "args": {"clipId": "${C}"}},
        {"command": "export_audio", "args": {"file": str(rendered)}},                                  # B: rendered plays
        {"command": "bypass_layer", "args": {"clipId": "${C}", "bypassed": True}},
        {"command": "export_audio", "args": {"file": str(bypassed)}},                                  # C: bypassed -> original
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION,
                               extra_env={"MOSH_SERVICE_PORT": _service_port(8796), "MOSH_ENABLE_TRANSFORM": "0"})
    fails = failed_commands(results)
    if fails or not (orig.exists() and rendered.exists() and bypassed.exists()):
        return row("Bypass layer re-route (A/B)", False,
                   {"failed_commands": fails,
                    "exists": {"orig": orig.exists(), "rendered": rendered.exists(), "bypassed": bypassed.exists()},
                    "stderr": proc.stderr[-500:]})
    rendered_vs_orig = diff_rms(str(orig), str(rendered))   # B vs A — the render changed it
    bypass_vs_orig = diff_rms(str(orig), str(bypassed))     # C vs A — bypass restored it
    # The accepted render must move the audio well clear of the original; bypass must
    # snap it back to within a hair of the original (mute is exact, so ~0).
    ok = (rendered_vs_orig > 0.01 and bypass_vs_orig < 0.001
          and bypass_vs_orig < rendered_vs_orig)
    return row("Bypass layer re-route (A/B)", ok,
               {"rendered_vs_orig_rms": rendered_vs_orig, "bypass_vs_orig_rms": bypass_vs_orig,
                "original": str(orig), "rendered": str(rendered), "bypassed": str(bypassed)})


def _data_field(results, command, field):
    """Pull result.data[field] from the matching command in a run-script result set.
    The MoshOps result envelope carries `command` + `data` (okResult)."""
    for r in results:
        if r.get("ok") and r.get("command") == command and isinstance(r.get("data"), dict):
            v = r["data"].get(field)
            if v is not None:
                return v
    return None


def check_render_artifact_portability(ctx):
    """AL-009 — Save-As consolidates a Tier-B render layer's cacheArtifact into the
    project's audio/renders/ and re-points it RELATIVE, so freeze_layer / re-accept survive
    a project move. Mirrors check_relative_ref_export (the wave-clip portability guard) for
    render artifacts: render a fake layer (cacheArtifact lands in the session pool as an
    absolute path), save_as to a standalone dir, then DELETE the pool render so resolution
    can only succeed via the consolidated co-located copy, reopen, and prove the
    artifact-gated ops (freeze_layer / accept_render) still work + the on-disk edit
    references the artifact relatively (no absolute pool path). Uses the fake adapter so it
    runs offline alongside check_transform."""
    import shutil
    SESSION = "verify-renderport"
    ENV = {"MOSH_SERVICE_PORT": _service_port(8796), "MOSH_ENABLE_TRANSFORM": "0"}
    dest_dir = ART / "al009-project"
    dest_edit = dest_dir / "renders.tracktionedit"
    out = ART / "07_render_portability.wav"
    pool_renders = _mosh_session_base() / SESSION / "renders"
    shutil.rmtree(dest_dir, ignore_errors=True)
    dest_dir.mkdir(parents=True, exist_ok=True)

    # 1) render a fake layer, then save_as OUTSIDE the session pool. clipId is captured into
    #    the result lines (add_test_tone_clip emits data.clipId).
    cmds = [
        {"command": "create_track", "args": {"name": "Gen"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 196.0}, "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "fake"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "seed": 7}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "save_as", "args": {"file": str(dest_edit)}},
    ]
    try:
        results, proc = run_script(ctx.bin, cmds, SESSION, extra_env=ENV, timeout=120)
    except subprocess.TimeoutExpired:
        return row("Render-artifact portability (AL-009)", False, {"error": "render/save_as HUNG (timed out)"})
    fails = failed_commands(results)
    # add_test_tone_clip dispatches to import_clip internally, so the result envelope's
    # `command` is "import_clip" (with data.clipId) — match by the clipId field, not the
    # command name, so the extraction can't break on that internal dispatch.
    clip_id = next((r["data"]["clipId"] for r in results
                    if r.get("ok") and isinstance(r.get("data"), dict) and r["data"].get("clipId")), None)
    renders_dir = dest_dir / "audio" / "renders"
    consolidated = renders_dir.is_dir() and any(renders_dir.glob("*.wav"))
    xml = dest_edit.read_text() if dest_edit.exists() else ""
    pool_abs = str(_mosh_session_base() / SESSION)
    rel_ok = ("audio/renders/" in xml) and ("../audio/renders/" not in xml) and (pool_abs not in xml)
    if fails or not clip_id or not consolidated or not rel_ok:
        return row("Render-artifact portability (AL-009)", False,
                   {"failed_commands": fails, "clip_id": clip_id, "consolidated": consolidated,
                    "relative_ref": rel_ok, "stderr": proc.stderr[-400:]})

    # 2) move the project, DELETE the pool render so only the co-located copy can resolve,
    #    reopen, and prove the artifact-gated ops still work (clip ids are preserved on open).
    moved = ART / "al009-moved"
    shutil.rmtree(moved, ignore_errors=True)
    shutil.copytree(dest_dir, moved)
    shutil.rmtree(pool_renders, ignore_errors=True)
    moved_edit = moved / "renders.tracktionedit"
    cmds2 = [
        {"command": "open_project", "args": {"file": str(moved_edit)}},
        {"command": "freeze_layer", "args": {"clipId": clip_id}},
        {"command": "accept_render", "args": {"clipId": clip_id}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    try:
        res2, proc2 = run_script(ctx.bin, cmds2, SESSION + "-moved", extra_env=ENV, timeout=120)
    except subprocess.TimeoutExpired:
        return row("Render-artifact portability (AL-009)", False, {"error": "moved-project ops HUNG (timed out)"})
    fails2 = failed_commands(res2)
    st = stats(out) if out.exists() else {}
    non_silent = bool(st) and st.get("rms", 0) > 0.001
    ok = (not fails2) and out.exists() and non_silent
    return row("Render-artifact portability (AL-009)", ok,
               {"consolidated": consolidated, "relative_ref": rel_ok,
                "failed_after_move": fails2, "wav": str(out), **st})


def check_midi_render(ctx):
    """Generative on ANY track: a render layer on a MIDI clip auto-BOUNCES the clip's
    instrument output to audio (input.wav) first, then the fake transform alters it.
    Proves the feature end-to-end on real rendered audio — the bounce is non-silent and
    the render differs from the dry bounce. Offline + deterministic (4OSC + fake adapter),
    so it joins the default set like check_transform."""
    SESSION = "verify-midi-render"
    notes = [{"pitch": 60 + i * 2, "start": i * 0.5, "length": 0.5, "velocity": 100} for i in range(4)]
    cmds = [
        {"command": "create_track", "args": {"name": "MidiGen"}, "capture": {"T": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "length": 2.0, "notes": notes}, "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "transform", "mode": "transform"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "target": "flute", "strength": 80, "seed": 1}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},   # auto-bounces, then renders
        {"command": "accept_render", "args": {"clipId": "${C}"}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION,
                              extra_env={"MOSH_SERVICE_PORT": _service_port(8796), "MOSH_ENABLE_TRANSFORM": "0"})
    fails = failed_commands(results)
    outputs = sorted(glob.glob(str(_mosh_session_base() / SESSION / "renders" / "*" / "output.wav")))
    if fails or not outputs:
        return row("Generative on MIDI (auto-bounce)", False,
                   {"failed_commands": fails, "exists": bool(outputs), "stderr": proc.stderr[-500:]})
    xout = outputs[0]
    job = Path(xout).parent
    xin = job / "input.wav"
    bounce = stats(str(xin)) if xin.exists() else None
    out_s = stats(xout)
    altered = diff_rms(str(xin), xout) if xin.exists() else None
    ok = (bounce is not None and bounce["rms"] > 0.001       # the MIDI bounce is non-silent audio
          and out_s["rms"] > 0.001                            # the render is non-silent
          and altered is not None and altered > 0.001)        # the model changed the bounced audio
    return row("Generative on MIDI (auto-bounce)", ok,
               {"bounce_input": str(xin), "bounce_rms": bounce["rms"] if bounce else None,
                "out_rms": out_s["rms"], "render_vs_bounce_rms": altered})


def _snap_for(results, label):
    for r in results:
        if r.get("command") == "__snapshot" and r.get("label") == label:
            return r.get("data") or {}
    return {}


def check_midi_reimagine_beneath(ctx):
    """Phase 2: re-imagining a MIDI clip RE-ROUTES the mix — a HIDDEN, instrument-free audio render
    plays beneath the now-muted MIDI, and Reset restores the bare instrument. The 4OSC synth bounce
    isn't bit-deterministic across exports, so this anchors on what IS deterministic — non-silence +
    the snapshot STATE — rather than fragile sample diffs:
      B (re-imagined) — export with the layer active. MUST be non-silent: the same-track design (a
                        synth on the source track overwrites the buffer) produced SILENCE here; the
                        dedicated hidden-track fix produces real audio. The snapshot at this point
                        shows the MIDI muted + reimagineActive + NO extra visible track (the hidden
                        render track is excluded from the snapshot).
      C (reset)       — export after reset. The hidden audio is gone, the live (non-silent) MIDI synth
                        plays again; the snapshot shows the MIDI un-muted + reimagineActive cleared.
    Offline + deterministic-enough (4OSC + fake transform, MOSH_ENABLE_TRANSFORM=0)."""
    SESSION = "verify-midi-beneath"
    reimagined = ART / "09b_midi_reimagined.wav"
    reset_wav = ART / "09c_midi_reset.wav"
    notes = [{"pitch": 60 + i * 2, "start": i * 0.5, "length": 0.5, "velocity": 100} for i in range(4)]
    cmds = [
        {"command": "create_track", "args": {"name": "MidiBeneath"}, "capture": {"T": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "length": 2.0, "notes": notes}, "capture": {"C": "clipId"}},
        {"command": "__snapshot", "args": {"label": "before"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "transform", "mode": "transform"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "target": "flute", "strength": 80, "seed": 1}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},                           # auto-applies beneath
        {"command": "__snapshot", "args": {"label": "after_render"}},
        {"command": "export_audio", "args": {"file": str(reimagined)}},                                  # B: hidden audio plays
        {"command": "reset_render_layer", "args": {"clipId": "${C}"}},
        {"command": "__snapshot", "args": {"label": "after_reset"}},
        {"command": "export_audio", "args": {"file": str(reset_wav)}},                                   # C: back to bare MIDI
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION,
                               extra_env={"MOSH_SERVICE_PORT": _service_port(8796), "MOSH_ENABLE_TRANSFORM": "0"})
    fails = failed_commands(results)
    if fails or not (reimagined.exists() and reset_wav.exists()):
        return row("MIDI re-imagine beneath", False,
                   {"failed_commands": fails,
                    "exists": {"reimagined": reimagined.exists(), "reset": reset_wav.exists()},
                    "stderr": proc.stderr[-500:]})

    def clip_state(snap):
        for t in snap.get("tracks", []):
            for c in t.get("clips", []):
                if c.get("type") == "midi":
                    rl = c.get("renderLayer") or {}
                    return {"mute": bool(c.get("mute")), "reimagineActive": bool(rl.get("reimagineActive"))}
        return {}
    def n_tracks(snap):
        return len(snap.get("tracks", []))

    before, after, post_reset = _snap_for(results, "before"), _snap_for(results, "after_render"), _snap_for(results, "after_reset")
    b_rms = stats(str(reimagined))["rms"]   # the hidden render must PLAY (same-track design → silence)
    c_rms = stats(str(reset_wav))["rms"]    # the live synth is back after reset
    st_after, st_reset = clip_state(after), clip_state(post_reset)
    ok = (b_rms > 0.01 and c_rms > 0.01                                              # both non-silent
          and st_after.get("mute") is True and st_after.get("reimagineActive") is True   # muted + active under the render
          and n_tracks(after) == n_tracks(before)                                   # the hidden render track is snapshot-excluded
          and st_reset.get("mute") is False and st_reset.get("reimagineActive") is False)  # reset restored the editable MIDI
    return row("MIDI re-imagine beneath", ok,
               {"reimagined_rms": b_rms, "reset_rms": c_rms,
                "state_after_render": st_after, "state_after_reset": st_reset,
                "visible_tracks_before_after": [n_tracks(before), n_tracks(after)]})


def check_reactive_rerender(ctx):
    """Phase 3: with an applied render LIVE, editing the source auto-re-renders the hidden audio —
    no manual re-imagine. Renders a MIDI beneath, then ADDS A NOTE and lets the per-clip debounce
    fire (MOSH_REACTIVE_DEBOUNCE_MS=1 + a message-loop pump via __wait). Asserts a NEW render ran
    automatically (a fresh durable audio file appears for the layer, keyed by the changed
    stableSourceSig) AND the beneath model stays live (MIDI muted + reimagineActive). The reactive
    path SPAWNS the service, so it's gated out of --selftest; here it runs on the fake transform."""
    SESSION = "verify-reactive"
    notes = [{"pitch": 60, "start": 0.0, "length": 0.5, "velocity": 100},
             {"pitch": 64, "start": 0.5, "length": 0.5, "velocity": 100}]
    cmds = [
        {"command": "create_track", "args": {"name": "Reactive"}, "capture": {"T": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "length": 2.0, "notes": notes}, "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "transform", "mode": "transform"}, "capture": {"L": "layerId"}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "add_note", "args": {"clipId": "${C}", "pitch": 67, "start": 1.0, "length": 0.5, "velocity": 110}},
        {"command": "__wait", "args": {"ms": 4000}},                                 # let the debounce + async render land
        {"command": "__snapshot", "args": {"label": "after_reactive"}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION,
                               extra_env={"MOSH_SERVICE_PORT": _service_port(8801), "MOSH_ENABLE_TRANSFORM": "0",
                                          "MOSH_REACTIVE_DEBOUNCE_MS": "1"})
    fails = failed_commands(results)
    layer_id = _data_field(results, "create_render_layer", "layerId")
    audio_dir = _mosh_session_base() / SESSION / "audio"
    files = sorted(glob.glob(str(audio_dir / f"{layer_id}-*.wav"))) if layer_id else []
    snap = _snap_for(results, "after_reactive")
    st = {}
    for t in snap.get("tracks", []):
        for c in t.get("clips", []):
            if c.get("type") == "midi":
                rl = c.get("renderLayer") or {}
                # status/error make a failure DIAGNOSABLE: render_layer returns ok=true with
                # status:"error" when the service-side render fails, which failed_commands
                # can't see (that opacity hid an orphan-service false-fail for weeks).
                st = {"mute": bool(c.get("mute")), "reimagineActive": bool(rl.get("reimagineActive")),
                      "notes": len(c.get("notes", [])),
                      "layer_status": rl.get("status"), "layer_error": rl.get("error")}
    # The edit changes the stableSourceSig → the auto-render writes a SECOND durable file (the first
    # render's still on disk). One file ⇒ no reactive render fired.
    ok = (not fails and layer_id is not None and len(files) >= 2
          and st.get("layer_status") == "ready"
          and st.get("mute") is True and st.get("reimagineActive") is True and st.get("notes") == 3)
    return row("Reactive auto-re-render on edit", ok,
               {"layer_audio_files": len(files), "state_after_edit": st, "failed_commands": fails})


def check_freeze_stops_rerender(ctx):
    """The inverse of check_reactive_rerender, and the only place the freeze can be PROVEN.
    Same setup — a live beneath-render on a MIDI clip — but freeze_layer runs before the edit.
    Asserts the edit fires NO second render (still exactly one durable audio file for the layer)
    while the beneath model stays live, then that unfreeze_layer re-arms the loop for real: a
    second edit after thawing DOES write a new file.

    Selftest can pin ids::reactive, but not this: reactiveTouch bails on !hasAudio() long before
    it reads the flag, so a headless run cannot tell a working freeze from a broken one. Freeze
    was shipped inert for exactly that long. This check is the guard against it going inert again."""
    SESSION = "verify-freeze"
    notes = [{"pitch": 60, "start": 0.0, "length": 0.5, "velocity": 100},
             {"pitch": 64, "start": 0.5, "length": 0.5, "velocity": 100}]
    cmds = [
        {"command": "create_track", "args": {"name": "Frozen"}, "capture": {"T": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "length": 2.0, "notes": notes}, "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "transform", "mode": "transform"}, "capture": {"L": "layerId"}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "freeze_layer", "args": {"clipId": "${C}"}},
        {"command": "add_note", "args": {"clipId": "${C}", "pitch": 67, "start": 1.0, "length": 0.5, "velocity": 110}},
        {"command": "__wait", "args": {"ms": 4000}},            # same window the reactive check needs to land a render
        {"command": "__snapshot", "args": {"label": "while_frozen"}},
        {"command": "unfreeze_layer", "args": {"clipId": "${C}"}},
        {"command": "add_note", "args": {"clipId": "${C}", "pitch": 71, "start": 1.5, "length": 0.5, "velocity": 110}},
        {"command": "__wait", "args": {"ms": 4000}},
        {"command": "__snapshot", "args": {"label": "after_thaw"}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION,
                               extra_env={"MOSH_SERVICE_PORT": _service_port(8802), "MOSH_ENABLE_TRANSFORM": "0",
                                          "MOSH_REACTIVE_DEBOUNCE_MS": "1"})
    fails = failed_commands(results)
    layer_id = _data_field(results, "create_render_layer", "layerId")
    audio_dir = _mosh_session_base() / SESSION / "audio"

    def layer_files():
        return sorted(glob.glob(str(audio_dir / f"{layer_id}-*.wav"))) if layer_id else []

    # One total, read at the end, pins BOTH phases: each edit's debounce window has fully
    # elapsed by then, so 1 file = the thaw never re-armed, 3 = the freeze never held, and only
    # 2 means the frozen edit rendered nothing and the thawed edit rendered once.
    def layer_state(label):
        snap = _snap_for(results, label)
        for t in snap.get("tracks", []):
            for c in t.get("clips", []):
                if c.get("type") == "midi":
                    rl = c.get("renderLayer") or {}
                    return {"reactive": rl.get("reactive"), "status": rl.get("status"),
                            "reimagineActive": bool(rl.get("reimagineActive")),
                            "notes": len(c.get("notes", []))}
        return {}

    frozen, thawed = layer_state("while_frozen"), layer_state("after_thaw")
    total = len(layer_files())
    # One file from the initial manual render; the frozen edit adds none. The thawed edit adds
    # one — that second file is what proves unfreeze restored a loop that actually runs, rather
    # than just flipping a flag the renderer ignores.
    ok = (not fails and layer_id is not None
          and total == 2
          and frozen.get("reactive") is False and frozen.get("reimagineActive") is True
          and frozen.get("notes") == 3
          and thawed.get("reactive") is True and thawed.get("notes") == 4)
    return row("Freeze stops the reactive re-render (and unfreeze restores it)", ok,
               {"layer_audio_files_total": total, "while_frozen": frozen, "after_thaw": thawed,
                "failed_commands": fails})


def check_crash_recovery(ctx):
    """A3: full JSONL-replay crash recovery. Run 1 saves a track (Alpha), then makes UNSAVED
    edits (track Beta + a clip on Beta) and __crash-es. Run 2 (same kept session) detects the
    unclean exit, replays the recovery-journal tail with id-rebinding (Beta gets a fresh
    engine id; the clip's reference to the old id must rebind), and the lost work comes back.
    Asserts: before-recover the saved state has 1 track; after-recover it has 2, and the
    recovered Beta carries its clip (proves the value-based id-rebinding worked)."""
    SESSION = "verify-recovery"
    base = _mosh_session_base() / SESSION
    if base.exists():
        shutil.rmtree(base, ignore_errors=True)
    keep = {"MOSH_RUNSCRIPT_KEEP_SESSION": "1"}

    run1 = [
        {"command": "create_track", "args": {"name": "Alpha"}, "capture": {"A": "trackId"}},
        {"command": "save", "args": {}},                                              # Alpha persisted; journal truncated
        {"command": "create_track", "args": {"name": "Beta"}, "capture": {"B": "trackId"}},  # UNSAVED tail begins
        {"command": "add_test_tone_clip", "args": {"trackId": "${B}", "seconds": 1.0, "freq": 220.0}},
        {"command": "__crash", "args": {}},                                            # sentinel set, no save
    ]
    run_script(ctx.bin, run1, SESSION, extra_env=keep, timeout=120)

    run2 = [
        {"command": "__snapshot", "args": {"label": "before"}},   # saved state (Alpha only)
        {"command": "recover_session", "args": {}},               # replay the crashed tail
        {"command": "__snapshot", "args": {"label": "after"}},    # Alpha + recovered Beta(+clip)
    ]
    results, proc = run_script(ctx.bin, run2, SESSION, extra_env=keep, timeout=120)

    before = after = beta_clips = None
    recovered, available = 0, False
    for r in results:
        if r.get("command") == "__snapshot":
            tracks = r.get("data", {}).get("tracks", [])
            if r.get("label") == "before":
                before = len(tracks)
                available = bool(r.get("data", {}).get("session", {}).get("recoveryAvailable"))
            elif r.get("label") == "after":
                after = len(tracks)
                beta = next((t for t in tracks if t.get("name") == "Beta"), None)
                beta_clips = len(beta.get("clips", [])) if beta else 0
        if r.get("command") == "recover_session":
            recovered = r.get("data", {}).get("recovered", 0)

    ok = (before == 1 and available and after == 2 and beta_clips == 1 and recovered >= 2)
    return row("Crash recovery (JSONL replay)", ok,
               {"before_tracks": before, "recoveryAvailable": available, "after_tracks": after,
                "recovered_cmds": recovered, "beta_clips": beta_clips, "stderr": proc.stderr[-300:] if not ok else ""})


def check_stem_export(ctx):
    """G7 — per-track stem export, common zero point (reality-pack invariant 84:
    "Stem export names and aligns each stem from the same zero point"). Two tracks
    with DIFFERENT tone content export to distinct, non-silent stems that share the
    SAME duration (both stems render over the identical {0, editLength} window —
    the structural half of "common zero point"; alignment itself needs no cross-
    correlation because both windows are literally the same range) and are
    genuinely different signals from each other AND from the full mix (a stem is
    not secretly the whole mix)."""
    stem_dir = ART / "07_stems"
    fullmix = ART / "07_stems_fullmix.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "A"}, "capture": {"TA": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${TA}", "seconds": 2.0, "freq": 220.0}},
        {"command": "create_track", "args": {"name": "B"}, "capture": {"TB": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${TB}", "seconds": 2.0, "freq": 660.0}},
        # Stems render PRE-master (by design); the mixdown includes the master, whose
        # untouched default is -3 dB. Pin the master to unity so the null test below
        # isolates zero-point alignment + completeness, not master policy.
        {"command": "set_master_volume", "args": {"db": 0.0}},
        {"command": "export_stems", "args": {"dir": str(stem_dir)}},
        {"command": "export_audio", "args": {"file": str(fullmix)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-stem-export")
    fails = failed_commands(results)
    if fails or not fullmix.exists() or len(results) < 6:
        return row("Stem export (G7)", False, {"failed_commands": fails, "exists": fullmix.exists(),
                                                "stderr": proc.stderr[-400:]})

    stems_res = next((r for r in results if r.get("command") == "export_stems"), {})
    stems = stems_res.get("data", {}).get("stems", [])
    if len(stems) != 2:
        return row("Stem export (G7)", False, {"error": f"expected 2 stems, got {len(stems)}",
                                                "stems": stems, "stderr": proc.stderr[-400:]})

    files = [Path(s["file"]) for s in stems]
    if not all(f.exists() for f in files):
        return row("Stem export (G7)", False, {"error": "a reported stem file is missing",
                                                "stems": [str(f) for f in files]})

    st = [stats(f) for f in files]
    non_silent = all(s["peak"] > 0.05 and s["rms"] > 0.01 for s in st)
    same_duration = abs(st[0]["duration_s"] - st[1]["duration_s"]) < 1e-3
    d_stems = diff_rms(files[0], files[1])
    d_mix = diff_rms(files[0], fullmix)

    # NULL TEST (invariant 84's strong form): on a linear mix of deterministic tones,
    # the SAMPLE-WISE SUM of the stems must reproduce the mixdown — proving zero-point
    # alignment AND completeness in one assertion (any stem offset, missing clip, or
    # per-stem processing difference breaks the null).
    s0, sr0, _ = load_wav(files[0])
    s1, _, _ = load_wav(files[1])
    mx, _, _ = load_wav(fullmix)
    m_sum, m_mix = mono(s0) + mono(s1), mono(mx)
    n = min(m_sum.size, m_mix.size)
    null_rms = float(np.sqrt(np.mean((m_sum[:n] - m_mix[:n]) ** 2))) if n else 1.0
    null_ok = n > 0 and abs(m_sum.size - m_mix.size) <= 1 and null_rms < 1e-3

    ok = non_silent and same_duration and d_stems > 0.05 and d_mix > 0.0 and null_ok

    return row("Stem export (G7)", ok, {
        "stems": [str(f) for f in files], "stats": st, "same_duration": same_duration,
        "diff_rms_stems": d_stems, "diff_rms_vs_mix": d_mix,
        "null_rms_sum_vs_mix": round(null_rms, 6), "null_ok": null_ok,
    })


def _synth_ramp_wav(path, seconds=1.0, freq=220.0, sr=44100):
    """Mono 16-bit sine whose amplitude ramps 0→0.6 — an ASYMMETRIC deterministic source,
    so a true reversal is distinguishable from the original at every sample."""
    import math, struct, wave as wavemod
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(seconds * sr)
    with wavemod.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(n):
            amp = 0.6 * (i / max(1, n - 1))
            frames += struct.pack("<h", int(amp * 32767 * math.sin(2 * math.pi * freq * i / sr)))
        w.writeframes(bytes(frames))
    return str(path)


def check_clip_reverse(ctx):
    """set_clip_reverse renders REAL reversed audio: export(reversed) must equal
    np.flip(export(original)) sample-for-sample on an asymmetric ramp source — the
    exact relational check no golden can beat. Plus normalize_clip: after
    normalize{targetDb:0} the exported peak sits at ~1.0 (the 0.6-peak ramp gains
    ~+4.4 dB), and it must work ON the reversed clip (the P3-found proxy bug)."""
    src = _synth_ramp_wav(ART / "13_ramp_src.wav")
    fwd = ART / "13_reverse_fwd.wav"
    rev = ART / "13_reverse_rev.wav"
    norm = ART / "13_reverse_norm.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Rev"}, "capture": {"T": "trackId"}},
        {"command": "set_master_volume", "args": {"db": 0.0}},   # unity master (default is -3 dB)
        {"command": "import_clip", "args": {"trackId": "${T}", "file": src}, "capture": {"C": "clipId"}},
        {"command": "export_audio", "args": {"file": str(fwd)}},
        {"command": "set_clip_reverse", "args": {"clipId": "${C}", "reversed": True}},
        # A reversed clip renders via a background-generated reversed proxy; without a
        # message-loop pump the export detects the missing source and errors ("render
        # stalled") — found by this check's first run. The __wait mirrors what the GUI's
        # live message loop does implicitly.
        {"command": "__wait", "args": {"ms": 4000}},
        {"command": "export_audio", "args": {"file": str(rev)}},
        {"command": "normalize_clip", "args": {"clipId": "${C}", "targetDb": 0.0}},
        {"command": "export_audio", "args": {"file": str(norm)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-clip-reverse")
    fails = failed_commands(results)
    if fails or not all(p.exists() for p in (fwd, rev, norm)):
        return row("Clip reverse + normalize render", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})
    f, _, _ = load_wav(fwd)
    r, _, _ = load_wav(rev)
    fm, rm = mono(f), mono(r)
    n = min(fm.size, rm.size)
    fl = np.flip(rm[:n])
    # The reversed proxy renders the EXACT flipped signal at a small constant sample
    # offset (measured: 4 samples — an upstream proxy rounding quirk, ~0.09 ms,
    # inaudible for reversal but real). Find the best lag in ±16 and require a true
    # NULL there; report the lag so growth of the offset reds visibly.
    best_lag, best_rms = 0, float("inf")
    for lag in range(-16, 17):
        if lag >= 0:
            d = fl[lag:n] - fm[:n - lag]
        else:
            d = fl[:n + lag] - fm[-lag:n]
        rms_l = float(np.sqrt(np.mean(d ** 2)))
        if rms_l < best_rms:
            best_lag, best_rms = lag, rms_l
    reversed_ok = best_rms < 1e-3 and abs(best_lag) <= 8 and stats(rev)["rms"] > 0.01
    norm_peak = stats(norm)["peak"]
    norm_ok = 0.9 < norm_peak <= 1.001
    ok = reversed_ok and norm_ok
    return row("Clip reverse + normalize render", ok,
               {"flip_null_rms": round(best_rms, 6), "flip_lag_samples": best_lag,
                "reversed_ok": reversed_ok, "normalized_peak": norm_peak, "norm_ok": norm_ok})


def check_clip_fades(ctx):
    """Fades render REAL amplitude curves (the L2 half of G4b): the un-faded head is
    sample-identical to the dry render, windowed RMS over the faded second decreases
    monotonically to ~silence — and the whole render is GOLDEN-pinned, because a curve
    SHAPE regression (sCurve→linear) slips straight past monotonic bounds."""
    dry = ART / "11_fades_dry.wav"
    wet = ART / "11_fades_faded.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Fd"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0},
         "capture": {"C": "clipId"}},
        {"command": "export_audio", "args": {"file": str(dry)}},
        {"command": "set_clip_fade", "args": {"clipId": "${C}", "fadeOutSec": 1.0, "curveOut": "sCurve"}},
        {"command": "export_audio", "args": {"file": str(wet)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-clip-fades")
    fails = failed_commands(results)
    if fails or not (dry.exists() and wet.exists()):
        return row("Clip fades render (G4b)", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})
    d, sr, _ = load_wav(dry)
    w, _, _ = load_wav(wet)
    dm, wm = mono(d), mono(w)
    n = min(dm.size, wm.size)
    half = n // 2
    head_rms = float(np.sqrt(np.mean((dm[:half] - wm[:half]) ** 2)))
    head_identical = head_rms < 1e-4
    win = sr // 4
    tail_rms = [float(np.sqrt(np.mean(wm[half + i * win: half + (i + 1) * win] ** 2)))
                for i in range(4)]
    monotone = all(tail_rms[i] > tail_rms[i + 1] for i in range(3))
    ends_silent = tail_rms[-1] < 0.02
    ok = head_identical and monotone and ends_silent
    return row("Clip fades render (G4b)", ok,
               {"wav": str(wet), "head_identical": head_identical,
                "tail_rms_windows": [round(v, 4) for v in tail_rms], "ends_silent": ends_silent})


def check_warp_stretch(ctx):
    """stretch_clip performs a REAL time-stretch: a 2s 220 Hz tone stretched to 2 bars
    (4s at the default 120 BPM) doubles in duration while its spectral centroid stays
    at ~220 Hz — pitch preserved, so it is elastique-style stretch, not resampling
    (a resample would land the centroid at ~110 Hz). Feature-vector only, NO golden:
    time-stretch output is not guaranteed bit-stable across engine/library bumps."""
    dry = ART / "14_warp_dry.wav"
    wet = ART / "14_warp_stretched.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Wp"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0},
         "capture": {"C": "clipId"}},
        {"command": "export_audio", "args": {"file": str(dry)}},
        {"command": "stretch_clip", "args": {"clipId": "${C}", "bars": 2}},
        # Warped (auto-tempo) clips render via a background-generated proxy too — same
        # pump requirement as reverse (found by this check's first run).
        {"command": "__wait", "args": {"ms": 4000}},
        {"command": "export_audio", "args": {"file": str(wet)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-warp-stretch")
    fails = failed_commands(results)
    if fails or not (dry.exists() and wet.exists()):
        return row("Warp/stretch render", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})
    dry_st, wet_st = stats(dry), stats(wet)
    d, sr, _ = load_wav(wet)
    cent = spectral_centroid(mono(d), sr)
    duration_ok = abs(wet_st["duration_s"] - 2.0 * dry_st["duration_s"]) < 0.15
    pitch_ok = abs(cent - 220.0) < 8.0
    ok = duration_ok and pitch_ok and wet_st["rms"] > 0.01
    return row("Warp/stretch render", ok,
               {"dry_s": dry_st["duration_s"], "stretched_s": wet_st["duration_s"],
                "centroid_hz": round(cent, 1), "duration_ok": duration_ok, "pitch_ok": pitch_ok})


def check_automation_ramp(ctx):
    """Automation is INCLUDED in the render (invariant 66's audible half): a low-shelf
    gain curve 0.5→0 over a 220 Hz tone (shelf frequency raised so the tone sits under
    it) makes the rendered level fall across the file and differ from the un-automated
    render; windowed RMS ends well below where it starts."""
    dry = ART / "15_autoramp_dry.wav"
    wet = ART / "15_autoramp_wet.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Ar"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}},
        {"command": "load_builtin", "args": {"trackId": "${T}", "type": "4bandEq"}, "capture": {"I": "index"}},
        # Raise the low-shelf corner so 220 Hz is inside the shelf band.
        {"command": "set_plugin_param", "args": {"trackId": "${T}", "index": "${I}", "paramIndex": 0, "value": 0.6}},
        {"command": "export_audio", "args": {"file": str(dry)}},
        # Low-shelf GAIN (param 1, 0.5 = neutral) ramps to full cut across the tone.
        {"command": "write_automation_curve", "args": {"trackId": "${T}", "pluginIndex": "${I}",
                                                       "paramIndex": 1, "apply": "replace",
                                                       "points": [{"t": 0.0, "v": 0.5}, {"t": 2.0, "v": 0.0}]}},
        {"command": "export_audio", "args": {"file": str(wet)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-automation-ramp")
    fails = failed_commands(results)
    if fails or not (dry.exists() and wet.exists()):
        return row("Automation ramp renders", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})
    d_ab = diff_rms(dry, wet)
    w, sr, _ = load_wav(wet)
    wm = mono(w)
    win = sr // 2
    rms = [float(np.sqrt(np.mean(wm[i * win: (i + 1) * win] ** 2))) for i in range(4)]
    falls = rms[-1] < 0.5 * rms[0]
    trend = all(rms[i + 1] <= rms[i] + 0.01 for i in range(3))
    ok = d_ab > 0.005 and falls and trend
    return row("Automation ramp renders", ok,
               {"diff_vs_dry": round(d_ab, 5), "windowed_rms": [round(v, 4) for v in rms],
                "ends_below_half": falls, "monotone_trend": trend})


def check_send_return(ctx):
    """The send/return wet path is REAL audio (invariant 59's audible half): a hot
    reverb on the bus return makes the render differ from dry; pulling the send to
    -100 dB collapses it back to ~the dry render."""
    dry = ART / "16_send_dry.wav"
    wet = ART / "16_send_wet.wav"
    off = ART / "16_send_off.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Sr"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}},
        {"command": "export_audio", "args": {"file": str(dry)}},
        {"command": "create_bus", "args": {"name": "Verb"}, "capture": {"B": "busNumber", "RT": "trackId"}},
        {"command": "load_builtin", "args": {"trackId": "${RT}", "type": "reverb"}, "capture": {"RV": "index"}},
        {"command": "set_plugin_param", "args": {"trackId": "${RT}", "index": "${RV}", "paramIndex": 0, "value": 0.95}},
        {"command": "set_plugin_param", "args": {"trackId": "${RT}", "index": "${RV}", "paramIndex": 2, "value": 1.0}},
        {"command": "add_send", "args": {"trackId": "${T}", "bus": "${B}", "db": 0.0}},
        {"command": "export_audio", "args": {"file": str(wet)}},
        {"command": "set_send_level", "args": {"trackId": "${T}", "bus": "${B}", "db": -100.0}},
        {"command": "export_audio", "args": {"file": str(off)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-send-return")
    fails = failed_commands(results)
    if fails or not all(p.exists() for p in (dry, wet, off)):
        return row("Send/return wet path", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})
    d_wet = diff_rms(dry, wet)
    d_off = diff_rms(dry, off)
    ok = d_wet > 0.01 and d_off < max(0.002, d_wet * 0.1)
    return row("Send/return wet path", ok,
               {"diff_dry_vs_wet": round(d_wet, 5), "diff_dry_vs_sendoff": round(d_off, 5)})


def check_master_chain(ctx):
    """The master bus is IN the render path: master −6 dB halves the rendered level
    (RMS ratio ≈ 0.501 ± 2%), GOLDEN-pinned — pure gain math on a deterministic tone,
    so any master-chain routing/summing change reds the checksum with a feature diff."""
    dry = ART / "12_master_dry.wav"
    out = ART / "12_master_gain.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "Mg"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 2.0, "freq": 220.0}},
        # The UNTOUCHED master defaults to -3 dB (Tracktion headroom, honestly reported
        # as snapshot.master.volumeDb=-3.0 — measured by this check's first run), so the
        # unity baseline must be set EXPLICITLY.
        {"command": "set_master_volume", "args": {"db": 0.0}},
        {"command": "export_audio", "args": {"file": str(dry)}},
        {"command": "set_master_volume", "args": {"db": -6.0}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-master-chain")
    fails = failed_commands(results)
    if fails or not (dry.exists() and out.exists()):
        return row("Master chain renders", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})
    r_dry, r_out = stats(dry)["rms"], stats(out)["rms"]
    ratio = r_out / r_dry if r_dry else 0.0
    ok = abs(ratio - 0.501) < 0.02 and r_out > 0.01
    return row("Master chain renders", ok,
               {"rms_dry": r_dry, "rms_minus6": r_out, "ratio": round(ratio, 4)})


OFFLINE_CHECKS = [check_makes_sound, check_drums, check_transform, check_compile_render,
                  check_compile_corrective, check_midi_render,
                  check_midi_reimagine_beneath, check_reactive_rerender,
                  check_freeze_stops_rerender, check_full_loop,
                  check_relative_ref_export, check_export_range_tail, check_bypass_layer,
                  check_render_artifact_portability, check_crash_recovery, check_stem_export,
                  check_clip_fades, check_clip_reverse, check_warp_stretch,
                  check_automation_ramp, check_send_return, check_master_chain]


# ── main ────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Mosh offline render-to-WAV verification")
    ap.add_argument("--bin", help="path to the Mosh binary (default: newest local build)")
    ap.add_argument("--sa3", action="store_true", help="also run the SA3 generative-transform check (needs the service)")
    ap.add_argument("--rave", action="store_true", help="also run the real RAVE transform-path check (needs the transform venv — setup-transform.sh)")
    ap.add_argument("--lora", action="store_true", help="also run the LoRA-rack real-merge check (needs the SA3 service + a lab adapter — see lora_check.py)")
    ap.add_argument("--rave-insert", action="store_true", help="also run the real-time RAVE insert offline-render check (needs an anira build + the transform venv)")
    ap.add_argument("--gate", action="store_true", help="also enforce the golden-audio checksum baselines (pre-merge gate)")
    ap.add_argument("--update-golden", action="store_true", help="regenerate the golden baselines from this run (intentional DSP/adapter change)")
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

    if args.lora:
        from lora_check import check_lora_rack   # noqa: lazy import, optional
        r = check_lora_rack(ctx, ART, run_script, stats, diff_rms, failed_commands)
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

    # Golden-audio gate: compare each deterministic render to its committed checksum (or
    # rewrite the baselines with --update-golden). Runs after the offline checks have
    # produced their WAVs. --update-golden implies the gate so the run also reports.
    if args.gate or args.update_golden:
        for r in run_golden_gate(update=args.update_golden):
            rows.append(r)
            print(f"  [{'PASS' if r['pass'] else 'FAIL'}] {r['check']}")
            print(f"         {json.dumps(r['detail'])}")
        if args.update_golden:
            print(f"\n  golden baselines written → {GOLDEN_MANIFEST}")

    report = ART / "report.json"
    report.write_text(json.dumps(rows, indent=2) + "\n")
    npass = sum(1 for r in rows if r["pass"])
    print(f"\n{npass}/{len(rows)} checks passed — report: {report}")
    return 0 if npass == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
