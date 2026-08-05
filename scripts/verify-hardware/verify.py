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
from harness_session import reset_owned_harness_session

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


def _harness_session(session):
    return session if session.startswith("_harness/") else f"_harness/{session}"


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
        "MOSH_SELFTEST_SESSION": _harness_session(session),
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
def _load_wav_float(path):
    """Minimal RIFF walker for the float WAVs stdlib `wave` refuses.

    A 32-bit WAV out of JUCE is WAVE_FORMAT_IEEE_FLOAT (tag 3), not int32 — so until
    now nothing in this harness could read Mosh's own 32-bit export at all. `wave`
    raises Error('unknown format: 3') on those, and on WAVE_FORMAT_EXTENSIBLE (0xFFFE)
    wrapping the same. Returns (float64 samples, samplerate, channels)."""
    raw = Path(path).read_bytes()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError(f"not a RIFF/WAVE file: {path}")
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = int.from_bytes(raw[pos + 4:pos + 8], "little")
        body = raw[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt = body
        elif cid == b"data":
            data = body
        pos += 8 + size + (size & 1)          # chunks are word-aligned
    if fmt is None or data is None:
        raise ValueError(f"WAV missing fmt/data chunk: {path}")

    tag = int.from_bytes(fmt[0:2], "little")
    ch = int.from_bytes(fmt[2:4], "little")
    sr = int.from_bytes(fmt[4:8], "little")
    bits = int.from_bytes(fmt[14:16], "little")
    if tag == 0xFFFE and len(fmt) >= 26:      # EXTENSIBLE — the real tag is the SubFormat GUID
        tag = int.from_bytes(fmt[24:26], "little")
    if tag != 3:
        raise ValueError(f"unsupported WAV format tag {tag} in {path}")
    dt = {32: "<f4", 64: "<f8"}.get(bits)
    if dt is None:
        raise ValueError(f"unsupported float width {bits} bits in {path}")

    samples = np.frombuffer(data[:(len(data) // (bits // 8)) * (bits // 8)], dtype=dt).astype(np.float64)
    if ch > 1:
        samples = samples[:(samples.size // ch) * ch].reshape(-1, ch)
    return samples, sr, ch


def load_wav(path):
    """Return (samples[ndarray, shape=(frames,) or (frames,ch)], samplerate, channels)."""
    try:
        with wave.open(str(path), "rb") as w:
            nframes, ch, sr, sw = w.getnframes(), w.getnchannels(), w.getframerate(), w.getsampwidth()
            raw = w.readframes(nframes)
    except wave.Error:
        return _load_wav_float(path)          # float WAV — the integer path below can't help
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


def onsets_seconds(path, rel_thresh=0.18, min_gap_s=0.02):
    """Attack times (seconds) in a percussive render, by peak-picking the rectified first
    difference of a short-time peak envelope.

    Deliberately simple and dependency-free: the renders this runs on are single-voice
    drum hits with hard transients, so an amplitude-flux detector resolves every onset to
    within a hop (~1.5 ms at 44.1 kHz) and has no library behaviour to drift on. It exists
    because timing is the one thing a note-position assertion CANNOT prove — a quantize can
    write the right beat numbers and still render the wrong groove."""
    data, sr, _ = load_wav(path)
    m = np.abs(mono(data))
    hop = 64
    n = (m.size // hop) * hop
    if n == 0 or not sr:
        return []
    env = m[:n].reshape(-1, hop).max(axis=1)
    flux = np.diff(env, prepend=0.0)
    flux[flux < 0.0] = 0.0
    top = float(flux.max())
    if top <= 0.0:
        return []
    flux = flux / top
    gap = max(1, int(round(min_gap_s * sr / hop)))
    out, last = [], -(10 ** 9)
    for i in range(flux.size):
        if flux[i] < rel_thresh or i - last < gap:
            continue
        if flux[i] < float(flux[i:i + gap].max()):
            continue        # still on the rising edge — the peak frame is the onset
        out.append(i * hop / sr)
        last = i
    return out


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


# ── spectral analysis (CAP-EXP-001) ─────────────────────────────────────────────
# Reusable, deliberately generic: every check above this line can only see LEVEL
# (peak/rms/diff) or one summary number (centroid). None of them can see WHERE the
# energy sits, so none of them can tell signal-correlated distortion from noise —
# which is the entire question dither answers. These four helpers are the missing
# instrument, and the colour/QA lane wants the same thing (a colour that adds grit
# vs one that adds hum is a floor-shape question, not a level question).
#
# Everything is a POWER SPECTRAL DENSITY in dB with an arbitrary but CONSISTENT
# reference, so only DIFFERENCES between two spectra computed by these helpers are
# meaningful — which is all any caller here needs.
def welch_psd_db(x, sr, seg=8192, floor_db=-400.0):
    """Welch PSD (Hann, 50% overlap) in dB. Returns (freqs, psd_db).

    Averaged rather than one long FFT on purpose: a single periodogram's bins are
    exponentially distributed (~5.6 dB std), so `max over a band` sits ~8 dB above
    `median of the band` for pure noise and a harmonic-vs-floor test can't use a tight
    threshold. ~46 averages over a 4 s take drops that spread to ~2 dB."""
    x = np.asarray(x, dtype=np.float64)
    if x.size < seg or not sr:
        seg = max(64, min(int(x.size), seg))
    if x.size < seg or seg < 8:
        return np.zeros(0), np.zeros(0)
    win = np.hanning(seg)
    hop = seg // 2
    starts = range(0, x.size - seg + 1, hop)
    acc = None
    n = 0
    for s in starts:
        spec = np.fft.rfft(x[s:s + seg] * win)
        p = (spec.real ** 2 + spec.imag ** 2)
        acc = p if acc is None else acc + p
        n += 1
    if not n:
        return np.zeros(0), np.zeros(0)
    psd = acc / n
    freqs = np.fft.rfftfreq(seg, d=1.0 / sr)
    return freqs, np.maximum(10.0 * np.log10(np.maximum(psd, 1e-300)), floor_db)


def band_peak_db(freqs, psd_db, f_hz, halfwidth_hz=12.0):
    """Peak PSD (dB) in [f-hw, f+hw]. -inf when the band falls off the axis."""
    if freqs.size == 0:
        return float("-inf")
    sel = (freqs >= f_hz - halfwidth_hz) & (freqs <= f_hz + halfwidth_hz)
    return float(psd_db[sel].max()) if sel.any() else float("-inf")


def noise_floor_db(freqs, psd_db, lo_hz, hi_hz, exclude_hz=(), exclude_halfwidth_hz=60.0):
    """MEDIAN PSD (dB) over [lo,hi] with the named tonal neighbourhoods notched out.

    Median, not mean: it is the level the *majority* of bins sit at, so a few surviving
    partials cannot drag it up and disguise themselves as floor."""
    if freqs.size == 0:
        return float("-inf")
    sel = (freqs >= lo_hz) & (freqs <= hi_hz)
    for f in exclude_hz:
        sel &= ~((freqs >= f - exclude_halfwidth_hz) & (freqs <= f + exclude_halfwidth_hz))
    return float(np.median(psd_db[sel])) if sel.any() else float("-inf")


def harmonic_excess_db(x, sr, f0, harmonics=(2, 3, 4, 5), seg=8192,
                       band_lo_hz=200.0, band_hi_hz=15000.0):
    """How far f0's harmonic partials stand ABOVE this signal's own broadband floor.

    THE dither discriminator. Requantising without dither is a signal-correlated
    (deterministic) error, so it piles into a line spectrum at k*f0 — a large excess.
    TPDF dither decorrelates the error from the signal, which converts exactly that
    energy into a flat, uncorrelated floor — excess collapses to ~0. Note this is
    self-referential (each signal against its OWN floor), so it is immune to the two
    signals sitting at different absolute levels.

    Returns {floor_db, fundamental_db, harmonics_db{k}, excess_db} — excess_db is the
    MEAN over the requested harmonics, so one lucky partial can't carry the verdict."""
    freqs, psd = welch_psd_db(x, sr, seg=seg)
    if freqs.size == 0:
        return {"floor_db": None, "fundamental_db": None, "harmonics_db": {}, "excess_db": None}
    tonal = [f0 * k for k in (1,) + tuple(harmonics)]
    floor = noise_floor_db(freqs, psd, band_lo_hz, band_hi_hz, exclude_hz=tonal)
    hs = {}
    for k in harmonics:
        fk = f0 * k
        if fk < band_hi_hz and fk < sr / 2.0:
            hs[k] = band_peak_db(freqs, psd, fk)
    excess = (sum(v - floor for v in hs.values()) / len(hs)) if hs else None
    return {
        "floor_db": round(floor, 2),
        "fundamental_db": round(band_peak_db(freqs, psd, f0), 2),
        "harmonics_db": {str(k): round(v, 2) for k, v in hs.items()},
        "excess_db": round(excess, 2) if excess is not None else None,
    }


def dominant_freq_hz(x, sr, lo_hz=100.0, hi_hz=10000.0, seg=8192):
    """Frequency of the strongest partial in [lo,hi] — used to LOCATE the rendered tone
    rather than assume it, so a resample/pitch change fails loudly instead of quietly
    pointing the harmonic probes at empty spectrum.

    Quadratically interpolated across the peak's neighbours, because bare bin resolution
    is not good enough for what the caller does next: at a ~6 Hz bin, a 1-bin error in f0
    becomes a 5-bin error at the 5th harmonic and the probe drifts off the partial it is
    supposed to be measuring."""
    freqs, psd = welch_psd_db(x, sr, seg=seg)
    if freqs.size == 0:
        return 0.0
    sel = (freqs >= lo_hz) & (freqs <= hi_hz)
    if not sel.any():
        return 0.0
    idx = int(np.argmax(np.where(sel, psd, -np.inf)))
    if 0 < idx < psd.size - 1:
        a, b, c = psd[idx - 1], psd[idx], psd[idx + 1]
        denom = a - 2.0 * b + c
        if denom != 0:
            delta = float(np.clip(0.5 * (a - c) / denom, -0.5, 0.5))
            return float(freqs[idx] + delta * (freqs[1] - freqs[0]))
    return float(freqs[idx])


def write_wav24(path, x, sr):
    """Write a mono 24-bit WAV. Used to inject an EXACT test signal — a tone Mosh
    generates itself would couple the measurement to the thing being measured."""
    q = np.clip(np.rint(np.asarray(x, dtype=np.float64) * 8388608.0), -8388608, 8388607).astype(np.int32)
    b = np.empty((q.size, 3), dtype=np.uint8)
    b[:, 0] = (q & 0xFF).astype(np.uint8)
    b[:, 1] = ((q >> 8) & 0xFF).astype(np.uint8)
    b[:, 2] = ((q >> 16) & 0xFF).astype(np.uint8)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(3)
        w.setframerate(int(sr))
        w.writeframes(b.tobytes())


def truncate_to_16bit(x):
    """Model of the UNDITHERED 16-bit path — ground truth for what Mosh used to emit.

    Not a guess: it is JUCE's arithmetic. AudioFormatWriter::convertFloatsToInts does
    roundToInt(INT_MAX * sample), and AudioData::Int16::setAsInt32LE then does
    `(uint16)(v >> 16)` — an arithmetic shift, i.e. FLOOR, not round. So the pre-dither
    export truncated downward and carried a half-LSB DC offset on top of the harmonic
    distortion."""
    i32 = np.rint(np.asarray(x, dtype=np.float64) * 2147483647.0).astype(np.int64)
    i16 = np.clip(np.floor_divide(i32, 65536), -32768, 32767)
    return i16.astype(np.float64) / 32768.0


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


def _session_dir(session):
    return _mosh_session_base() / _harness_session(session)


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
    outputs = sorted(glob.glob(str(_session_dir(SESSION) / "renders" / "*" / "output.wav")))
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
    outputs = sorted(glob.glob(str(_session_dir(SESSION) / "renders" / "*" / "output.wav")))
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
    outputs = glob.glob(str(_session_dir(SESSION) / "renders" / "*" / "output.wav"))
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
    tone = _session_dir(SESSION) / "audio" / "tone.wav"   # add_test_tone_clip writes here
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
    pool_renders = _session_dir(SESSION) / "renders"
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
    pool_abs = str(_session_dir(SESSION))
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
    outputs = sorted(glob.glob(str(_session_dir(SESSION) / "renders" / "*" / "output.wav")))
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
    audio_dir = _session_dir(SESSION) / "audio"
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
    audio_dir = _session_dir(SESSION) / "audio"

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


def _crash_recovery_once(ctx):
    """One full crash→relaunch→replay round trip. Returns the observed outcome dict."""
    SESSION = "verify-recovery"
    base = _session_dir(SESSION)
    reset_owned_harness_session(base)
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

    return {"before_tracks": before, "recoveryAvailable": available, "after_tracks": after,
            "recovered_cmds": recovered, "beta_clips": beta_clips,
            "stderr": proc.stderr[-300:]}


def check_crash_recovery(ctx):
    """A3: full JSONL-replay crash recovery. Run 1 saves a track (Alpha), then makes UNSAVED
    edits (track Beta + a clip on Beta) and __crash-es. Run 2 (same kept session) detects the
    unclean exit, replays the recovery-journal tail with id-rebinding (Beta gets a fresh
    engine id; the clip's reference to the old id must rebind), and the lost work comes back.
    Asserts: before-recover the saved state has 1 track; after-recover it has 2, and the
    recovered Beta carries its clip (proves the value-based id-rebinding worked).

    FS-T2: the round trip runs x3 and every run must produce an IDENTICAL outcome. SPEC §4 T2
    asks for a deterministic x3 crash-recovery gate; gate.sh runs verify.py --gate exactly
    once (only --selftest is looped x3), so the repetition has to live here. A replay that
    recovers 2 commands on one run and 1 on the next is a real defect this catches and a
    single run cannot."""
    runs = [_crash_recovery_once(ctx) for _ in range(3)]
    first = runs[0]
    # Compare everything except stderr (timing/log noise is not part of the contract).
    keys = ("before_tracks", "recoveryAvailable", "after_tracks", "recovered_cmds", "beta_clips")
    deterministic = all(tuple(r[k] for k in keys) == tuple(first[k] for k in keys) for r in runs)
    ok = (deterministic and first["before_tracks"] == 1 and first["recoveryAvailable"]
          and first["after_tracks"] == 2 and first["beta_clips"] == 1 and first["recovered_cmds"] >= 2)
    return row("Crash recovery (JSONL replay, deterministic x3)", ok,
               {**{k: first[k] for k in keys}, "deterministic_x3": deterministic,
                "runs": [tuple(r[k] for k in keys) for r in runs],
                "stderr": first["stderr"] if not ok else ""})


def check_crash_recovery_safe_mode(ctx):
    """FS-T2: recovery after a crash a THIRD-PARTY PLUGIN caused.

    This is the crash autosave cannot help with. A plugin that dies while the project is
    LOADING re-crashes on every relaunch, and it dies BEFORE the session.running sentinel is
    written — so it leaves no unclean-exit flag and the producer never reaches a window.

    Simulated faithfully and hermetically, without needing a real crashing plugin (which
    could not be deterministic, and installing one is not reproducible in CI):
      1. Build + save a normal project, then inject a <PLUGIN type="vst"> node into the saved
         .tracktionedit. That is EXACTLY the on-disk shape Tracktion writes for a hosted
         VST/VST3/AU (ExternalPlugin::create), so the scrub is exercised against the real
         format, not a mock.
      2. Plant the plugin-loading breadcrumb — the actual artifact a load-time crash strands.
      3. Relaunch. The engine must auto-degrade: come up in safe mode, skip the plugin node,
         report it as a suspect, and REFUSE to save (the guard that stops the 30s auto-save
         from overwriting the producer's plugin chain with the stripped version).

    Asserts the whole contract, including that the arrangement survived the scrub."""
    SESSION = "verify-safemode"
    # _session_dir, NOT _mosh_session_base()/SESSION: run_script passes the session through
    # _harness_session(), which prefixes "_harness/" (SLF-CONC-001 — an explicit
    # MOSH_SELFTEST_SESSION is only honoured under _harness/, so a bare name silently lands
    # in a DIFFERENT directory from the one the app actually wrote). Every other on-disk
    # check already goes through this helper; this was the one site that did not.
    base = _session_dir(SESSION)
    if base.exists():
        shutil.rmtree(base, ignore_errors=True)
    keep = {"MOSH_RUNSCRIPT_KEEP_SESSION": "1"}

    # (1) A real project, saved.
    run1 = [
        {"command": "create_track", "args": {"name": "Keeper"}, "capture": {"K": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${K}", "seconds": 1.0, "freq": 330.0}},
        {"command": "save", "args": {}},
    ]
    run_script(ctx.bin, run1, SESSION, extra_env=keep, timeout=120)

    # Resolve the saved project by EXTENSION, never by a hardcoded name. Projects are
    # ".mosh" as of CAP-PRJ .mosh naming; ".tracktionedit" is still accepted on open and
    # still re-saved in place for a legacy file, so both are valid things to find here.
    # The name is not fixed either — a fresh project is named "untitled - <word>".
    edit_file = next(iter(sorted(base.glob("*.mosh")) + sorted(base.glob("*.tracktionedit"))), None)
    if edit_file is None:
        return row("Crash recovery: plugin safe mode", False,
                   {"error": f"no .mosh/.tracktionedit project in {base}",
                    "found": sorted(p.name for p in base.glob("*")) if base.exists() else "(no session dir)"})

    # (2) Inject a third-party plugin node into the FIRST track, exactly as Tracktion persists
    # one, then strand the breadcrumb that a crash mid-load would leave.
    import xml.etree.ElementTree as ET
    tree = ET.parse(edit_file)
    root = tree.getroot()
    track = root.find(".//TRACK")
    if track is None:
        return row("Crash recovery: plugin safe mode", False, {"error": "no TRACK node in saved edit"})
    ET.SubElement(track, "PLUGIN", {
        "type": "vst", "name": "HarnessCrasher", "manufacturer": "Mosh Harness",
        "filename": "/nonexistent/HarnessCrasher.vst3", "uid": "deadbeef",
    })
    tree.write(edit_file, encoding="UTF-8", xml_declaration=True)
    injected = edit_file.read_text().count('type="vst"')

    (base / "plugin-loading.json").write_text(json.dumps({"plugins": [
        {"name": "HarnessCrasher", "manufacturer": "Mosh Harness",
         "filename": "/nonexistent/HarnessCrasher.vst3", "uid": "deadbeef"},
    ]}))

    # (3) Relaunch: must auto-degrade into safe mode.
    run2 = [
        {"command": "__snapshot", "args": {"label": "safe"}},
        {"command": "save", "args": {}},          # must be REFUSED / must not strip the file
    ]
    results, proc = run_script(ctx.bin, run2, SESSION, extra_env=keep, timeout=120)

    safe_active = suspects = tracks = clips = plugins_on_track = None
    save_refused = None
    for r in results:
        if r.get("command") == "__snapshot" and r.get("label") == "safe":
            sess = r.get("data", {}).get("session", {})
            safe_active = bool(sess.get("safeModeActive"))
            suspects = sess.get("pluginCrashSuspects") or []
            tlist = r.get("data", {}).get("tracks", [])
            tracks = len(tlist)
            keeper = next((t for t in tlist if t.get("name") == "Keeper"), None)
            clips = len(keeper.get("clips", [])) if keeper else 0
            # The scrub actually happened: no third-party plugin in the loaded rack.
            plugins_on_track = [p.get("name") for t in tlist for p in (t.get("plugins") or [])]
        if r.get("command") == "save":
            # Safe mode is READ-ONLY: the save must be REFUSED, not silently succeed.
            save_refused = not r.get("ok", False)

    # The on-disk project must STILL carry the plugin node: safe mode is read-only precisely
    # so the producer's plugin chain survives. This is the assertion that would have caught
    # an auto-save silently stripping it.
    still_on_disk = edit_file.read_text().count('type="vst"')

    ok = (injected == 1 and safe_active is True and suspects == ["HarnessCrasher"]
          and tracks == 1 and clips == 1 and plugins_on_track == []
          and save_refused is True and still_on_disk == 1)
    return row("Crash recovery: plugin safe mode (auto-degrade + read-only)", ok,
               {"injected_vst_nodes": injected, "safeModeActive": safe_active, "suspects": suspects,
                "tracks": tracks, "keeper_clips": clips, "plugins_in_loaded_rack": plugins_on_track,
                "save_refused": save_refused, "plugin_still_in_file": still_on_disk,
                "stderr": proc.stderr[-300:] if not ok else ""})


def _replay_txn_golden(ctx, name, session):
    """Replay a committed FS-B2a run-script golden against the REAL engine and index its
    result lines. The goldens (tests/golden/txn/) are rendered from the SAME
    planSkillTransaction() expansion the browser harness uses, and pinned by
    ui/src/agent/txnGoldens.test.ts — so this leg cannot drift into proving an expansion
    nobody sends."""
    golden = REPO / "tests" / "golden" / "txn" / name
    if not golden.exists():
        return None, None, f"missing golden {name}"
    commands = [json.loads(l) for l in golden.read_text().splitlines() if l.strip()]
    base = _session_dir(session)
    reset_owned_harness_session(base)
    results, proc = run_script(ctx.bin, commands, session, timeout=120)
    statuses = [r.get("data", {}) for r in results if r.get("command") == "batch_status"]
    return results, statuses, proc.stderr[-300:]


def check_skill_transaction_real_engine(ctx):
    """FS-B2a — the lane's real gate: a first REAL-ENGINE skill run proving exact commit AND
    exact rollback, plus a lost response resolving through batch_status without
    double-applying (docs/first-stranger-program/lanes/fs-b2.md items 3–5).

    Every assertion reads the ENGINE's own fingerprints out of batch_status, so there is no
    second implementation here to disagree with MoshOps. The anti-vacuity leg is explicit:
    the mid-transaction fingerprint must DIFFER from preFingerprint, or "restored the
    pre-state" would be true of a transaction that changed nothing."""
    detail = {}

    # ── 1. EXACT COMMIT ──
    results, statuses, err = _replay_txn_golden(ctx, "set_track_level-commit.jsonl", "verify-txn-commit")
    if results is None:
        return row("FS-B2a skill transaction (real engine)", False, {"error": statuses or err})
    commit_ok = (len(statuses) >= 3
                 and statuses[0].get("status") == "open"
                 and statuses[0].get("fingerprint") == statuses[0].get("preFingerprint")
                 and statuses[-2].get("fingerprint") != statuses[-2].get("preFingerprint")   # it MOVED
                 and statuses[-1].get("status") == "committed"
                 and statuses[-1].get("applied") == statuses[-1].get("manifestCount"))
    detail["commit"] = {"final": statuses[-1].get("status") if statuses else None,
                        "applied": statuses[-1].get("applied") if statuses else None,
                        "moved": statuses[-2].get("fingerprint") != statuses[-2].get("preFingerprint")
                                 if len(statuses) >= 2 else None}

    # ── 2. EXACT ROLLBACK ──
    results, statuses, err = _replay_txn_golden(ctx, "set_track_level-rollback.jsonl", "verify-txn-rollback")
    pre = statuses[0].get("preFingerprint") if statuses else None
    mid = statuses[-2].get("fingerprint") if len(statuses or []) >= 2 else None
    final = statuses[-1] if statuses else {}
    rollback_ok = (len(statuses or []) >= 3
                   and pre and mid and mid != pre                      # a step really applied
                   and statuses[-2].get("status") == "failed"           # …and one really failed
                   and statuses[-2].get("applied") == 1
                   and final.get("status") == "rolled_back"
                   and final.get("fingerprint") == pre)                 # …restored EXACTLY
    detail["rollback"] = {"pre": (pre or "")[:8], "mid": (mid or "")[:8],
                          "final_status": final.get("status"),
                          "final_fp": (final.get("fingerprint") or "")[:8],
                          "restored_exactly": final.get("fingerprint") == pre}

    # ── 3. LOST RESPONSE → REPLAY, NEVER DOUBLE-APPLY ──
    results, statuses, err = _replay_txn_golden(ctx, "set_track_level-replay.jsonl", "verify-txn-replay")
    replayed = [r for r in (results or []) if r.get("replayed") is True]
    dupes = [r for r in (results or [])
             if r.get("command") == "set_track_volume" and not r.get("ok")]
    replay_ok = (len(statuses or []) >= 3
                 and len(replayed) == 1                                  # exactly one replay
                 and not dupes                                           # the retry was not an error
                 and statuses[-1].get("status") == "committed"
                 # The manifest was 2 commands and the script sent 3 — a double-apply would
                 # show as applied > manifestCount, or as a third recorded entry.
                 and statuses[-1].get("applied") == statuses[-1].get("manifestCount")
                 and len(statuses[-1].get("entries", [])) == statuses[-1].get("manifestCount"))
    detail["replay"] = {"replayed_results": len(replayed),
                        "applied": statuses[-1].get("applied") if statuses else None,
                        "manifestCount": statuses[-1].get("manifestCount") if statuses else None}

    # ── 4. THE MULTI-STEP SHAPE, committed AND rolled back ──
    # add_vocal_with_lyrics rather than host_plugin: host_plugin's first step is load_plugin,
    # which needs a scanned third-party VST3 and is therefore not portable to a headless run
    # or a clean CI machine. (The 3-command PLUGIN shape is proven against the real engine in
    # --selftest's TXN-3CMD section, which can use load_builtin.)
    results, statuses, err = _replay_txn_golden(ctx, "add_vocal_with_lyrics-commit.jsonl", "verify-txn-multi")
    multi_commit = (len(statuses or []) >= 3
                    and statuses[-1].get("status") == "committed"
                    and statuses[-1].get("manifestCount") >= 3
                    and statuses[-1].get("applied") == statuses[-1].get("manifestCount"))
    results, statuses2, err = _replay_txn_golden(ctx, "add_vocal_with_lyrics-rollback.jsonl", "verify-txn-multi-rb")
    pre2 = statuses2[0].get("preFingerprint") if statuses2 else None
    mid2 = statuses2[-2].get("fingerprint") if len(statuses2 or []) >= 2 else None
    fin2 = statuses2[-1] if statuses2 else {}
    multi_rollback = (pre2 and mid2 and mid2 != pre2                 # earlier steps really applied
                      and (statuses2[-2].get("applied") or 0) >= 2   # …more than one of them
                      and fin2.get("status") == "rolled_back"
                      and fin2.get("fingerprint") == pre2)           # …all reverted by ONE rollback
    three_ok = multi_commit and multi_rollback
    detail["multi_step"] = {"commit": statuses[-1].get("status") if statuses else None,
                            "commit_applied": statuses[-1].get("applied") if statuses else None,
                            "rollback_applied_before": statuses2[-2].get("applied") if len(statuses2 or []) >= 2 else None,
                            "rollback_status": fin2.get("status"),
                            "restored_exactly": fin2.get("fingerprint") == pre2}

    # ── 5. RESTART BLOCK: an unresolved transaction survives the process ──
    # This is the only leg that NEEDS two processes, which is why it lives here and not in
    # --selftest: run 1 opens a transaction, applies a step, and exits without resolving it
    # (the crash shape). Run 2 must refuse to start any skill until T2's recovery resolves it.
    SESSION = "verify-txn-restart"
    base = _session_dir(SESSION)
    reset_owned_harness_session(base)
    keep = {"MOSH_RUNSCRIPT_KEEP_SESSION": "1"}
    orphan = "verify-orphan-txn"
    run1 = [
        {"command": "create_track", "args": {"name": "Orphan Fixture"}, "capture": {"T": "trackId"}},
        {"command": "batch_begin", "args": {"transactionId": orphan, "name": "set_track_level",
                                            "commands": [{"index": 0, "requestId": "rq-a",
                                                          "command": "set_track_volume"}]}},
        {"command": "set_track_volume", "args": {"trackId": "${T}", "db": -5.0},
         "transaction": {"transactionId": orphan, "requestId": "rq-a", "index": 0}},
        # …and the process ends here, with the transaction still open.
    ]
    run_script(ctx.bin, run1, SESSION, extra_env=keep, timeout=120)

    run2 = [
        {"command": "batch_status", "args": {"transactionId": orphan}},
        {"command": "batch_begin", "args": {"transactionId": "a-brand-new-txn", "name": "set_track_level",
                                            "commands": [{"index": 0, "requestId": "rq-z",
                                                          "command": "set_track_volume"}]}},
        {"command": "discard_recovery", "args": {}},          # T2's human gate: pre-state stands
        {"command": "batch_begin", "args": {"transactionId": "a-brand-new-txn", "name": "set_track_level",
                                            "commands": [{"index": 0, "requestId": "rq-z",
                                                          "command": "set_track_volume"}]}},
        {"command": "batch_rollback", "args": {"transactionId": "a-brand-new-txn"}},
    ]
    results2, proc2 = run_script(ctx.bin, run2, SESSION, extra_env=keep, timeout=120)
    orphan_status = next((r.get("data", {}) for r in results2 if r.get("command") == "batch_status"), {})
    begins = [r for r in results2 if r.get("command") == "batch_begin"]
    restart_ok = (orphan_status.get("status") == "needs_recovery"
                  and len(begins) == 2
                  and begins[0].get("ok") is False                       # BLOCKED before recovery
                  and "unresolved_after_restart" in (begins[0].get("error") or "")
                  and begins[1].get("ok") is True)                       # unblocked after it
    detail["restart_block"] = {"orphan_status": orphan_status.get("status"),
                               "blocked_before_recovery": begins[0].get("ok") is False if begins else None,
                               "allowed_after_recovery": begins[1].get("ok") if len(begins) > 1 else None,
                               "stderr": proc2.stderr[-200:] if not restart_ok else ""}

    ok = commit_ok and rollback_ok and replay_ok and three_ok and restart_ok
    return row("FS-B2a skill transaction (real engine): exact commit + exact rollback", ok, detail)


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


def check_mute_automation(ctx):
    """CAP-AUT-006's AUDIBLE half: a curve on the per-track mute gate makes the render
    actually silent across the muted span and leaves the rest alone.

    `--selftest` proves the parameter exists, takes a curve and survives save/reload, and
    that is ALL it can prove — a headless run has no audio device. This is precisely the
    freeze_layer class: that command shipped inert for weeks WITH a passing selftest
    check asserting its label was written. So the assertion here is on the PCM: windowed
    RMS inside [1.0, 2.0) must be floor-level silence while the windows either side stay
    at the dry level, and the dry render must be loud in all three (i.e. the silence came
    from the curve, not from an empty clip)."""
    dry = ART / "17_mute_dry.wav"
    wet = ART / "17_mute_wet.wav"
    cmds = [
        # muteGateIndex is the gate's real pluginList index — it is hidden from the
        # snapshot's `plugins` rack (it rides `mixerPlugins`), and --run-script cannot
        # read a snapshot, so create_track hands it back directly. Capturing it beats
        # assuming an index: a wrong assumption would write the curve onto some other
        # plugin and fail here as "not silent", which reads like a broken gate.
        {"command": "create_track", "args": {"name": "Mu"},
         "capture": {"T": "trackId", "G": "muteGateIndex"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 3.0, "freq": 220.0}},
        {"command": "export_audio", "args": {"file": str(dry)}},
        # The mute parameter is DISCRETE (2 states): the engine snaps every applied value
        # at 0.5, so a 0->1 segment flips at its temporal midpoint. Pairs 20 ms apart put
        # each edge within 10 ms of where it is drawn instead of halfway across a second.
        {"command": "write_automation_curve",
         "args": {"trackId": "${T}", "pluginIndex": "${G}", "paramIndex": 0, "apply": "replace",
                  "points": [{"t": 0.0, "v": 0.0}, {"t": 0.99, "v": 0.0},
                             {"t": 1.01, "v": 1.0}, {"t": 1.99, "v": 1.0},
                             {"t": 2.01, "v": 0.0}, {"t": 3.0, "v": 0.0}]}},
        {"command": "export_audio", "args": {"file": str(wet)}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-mute-automation")
    fails = failed_commands(results)
    if fails or not (dry.exists() and wet.exists()):
        return row("Mute automation silences", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})

    def window_rms(path, t0, t1):
        d, sr, _ = load_wav(path)
        m = mono(d)
        a, b = int(t0 * sr), min(int(t1 * sr), m.size)
        if b <= a:
            return 0.0
        return float(np.sqrt(np.mean(m[a:b] ** 2)))

    # 0.2 s of margin either side of each edge, so a ramped gate edge (5 ms) and the
    # snap midpoint never land inside a measurement window.
    spans = [(0.2, 0.8), (1.2, 1.8), (2.2, 2.8)]
    wet_rms = [window_rms(wet, a, b) for a, b in spans]
    dry_rms = [window_rms(dry, a, b) for a, b in spans]

    dry_loud = all(r > 0.01 for r in dry_rms)                       # the tone is there to mute
    muted_silent = wet_rms[1] < 1e-4                                # < -80 dBFS: silence, not "quieter"
    edges_intact = wet_rms[0] > 0.01 and wet_rms[2] > 0.01
    # Outside the muted span the gate is a multiply by exactly 1.0, so the un-muted
    # windows must match the dry render, not merely be loud.
    unchanged = all(abs(wet_rms[i] - dry_rms[i]) < 1e-6 for i in (0, 2))
    ok = dry_loud and muted_silent and edges_intact and unchanged
    return row("Mute automation silences", ok,
               {"dry_rms": [round(v, 5) for v in dry_rms], "wet_rms": [round(v, 6) for v in wet_rms],
                "dry_loud": dry_loud, "muted_span_silent": muted_silent,
                "unmuted_spans_intact": edges_intact, "unmuted_bit_identical_to_dry": unchanged})


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


# ── CAP-EXP-001: reduced-bit-depth export dither ───────────────────────────────
# Tone parameters shared by the instrument self-test and the real render check.
DITHER_TONE_HZ = 997.0          # classic "not a submultiple of anything" probe tone
DITHER_TONE_DBFS = -87.0        # ≈1.4 × the 16-bit LSB — right down where truncation is brutal
DITHER_TONE_SR = 48000
DITHER_TONE_SECONDS = 4.0


def _dither_test_tone(seconds=DITHER_TONE_SECONDS, sr=DITHER_TONE_SR,
                      f0=DITHER_TONE_HZ, dbfs=DITHER_TONE_DBFS, seed=20260803):
    """A −87 dBFS sine, itself TPDF-dithered at 24 bits so the SOURCE carries no
    harmonics of its own. Without that the source's own truncation products would be
    indistinguishable from the ones this check exists to find in Mosh's output."""
    n = int(round(seconds * sr))
    t = np.arange(n, dtype=np.float64) / sr
    rng = np.random.default_rng(seed)
    lsb24 = 1.0 / 8388608.0
    tpdf = (rng.random(n) - rng.random(n)) * lsb24
    return (10.0 ** (dbfs / 20.0)) * np.sin(2.0 * np.pi * f0 * t) + tpdf


def _tpdf_quantise_16(x, seed=7):
    """Reference TPDF requantiser, in numpy. What the shipped C++ must be equivalent to."""
    rng = np.random.default_rng(seed)
    lsb = 1.0 / 32768.0
    d = (rng.random(x.size) - rng.random(x.size)) * lsb
    return np.clip(np.rint((x + d) / lsb), -32768, 32767) * lsb


def check_spectral_helpers(ctx):
    """The INSTRUMENT's own RED/GREEN — no binary, pure numpy, ~1s.

    A measurement nobody has watched fail is not evidence. This drives the spectral
    helpers with two signals whose answer is known by construction — the same −87 dBFS
    tone truncated to 16 bits, and TPDF-dithered to 16 bits — and asserts they come out
    on opposite sides of the discriminator. If someone breaks welch_psd_db /
    harmonic_excess_db, THIS fails first and the export check below cannot quietly
    degrade into a check that passes on anything."""
    sr, f0 = DITHER_TONE_SR, DITHER_TONE_HZ
    tone = _dither_test_tone()
    trunc = truncate_to_16bit(tone)
    dith = _tpdf_quantise_16(tone)

    a_src = harmonic_excess_db(tone, sr, f0)
    a_trunc = harmonic_excess_db(trunc, sr, f0)
    a_dith = harmonic_excess_db(dith, sr, f0)

    # The three laws the instrument must obey on known inputs.
    sees_truncation = a_trunc["excess_db"] >= 12.0            # distortion is visible
    sees_dither_clean = a_dith["excess_db"] <= 5.0            # …and its absence is too
    sees_floor_rise = (a_dith["floor_db"] - a_src["floor_db"]) >= 20.0
    ok = bool(sees_truncation and sees_dither_clean and sees_floor_rise)
    return row("Spectral helpers separate truncation from dither (self-test)", ok, {
        "source_24bit": a_src, "truncated_16bit": a_trunc, "tpdf_dithered_16bit": a_dith,
        "sees_truncation": sees_truncation, "sees_dither_clean": sees_dither_clean,
        "sees_floor_rise": sees_floor_rise,
        "floor_rise_db": round(a_dith["floor_db"] - a_src["floor_db"], 2),
    })


def check_export_dither(ctx):
    """CAP-EXP-001 — a 16-bit export must DITHER, not truncate.

    Renders one very quiet tone (−87 dBFS, ~1.4 × the 16-bit LSB) three ways from the
    same session and measures the SHAPE of what came back:

      • 24-bit render = ground truth. Its LSB is 48 dB below the tone, so what it holds
        is the tone, full stop. Every harmonic seen in the 16-bit render is therefore
        made BY the 16-bit requantisation — not inherited from the source or the graph.
      • The undithered baseline is computed FROM that ground truth in numpy
        (truncate_to_16bit models JUCE's float→int32→`>>16` floor exactly), so the
        comparison never depends on Mosh's own output being right about anything.
      • 32-bit render proves the untouched path stayed untouched: no dither noise.

    The assertion is not "the file changed". It is the pair the physics demands:
    the energy at 2f/3f/4f/5f DROPPED, and the broadband floor ROSE."""
    src = ART / "20_dither_src.wav"
    ref24 = ART / "20_dither_24bit.wav"
    out16 = ART / "20_dither_16bit.wav"
    out32 = ART / "20_dither_32bit.wav"
    sr = DITHER_TONE_SR
    write_wav24(src, _dither_test_tone(), sr)

    cmds = [
        {"command": "create_track", "args": {"name": "Dither"}, "capture": {"T": "trackId"}},
        {"command": "import_clip", "args": {"trackId": "${T}", "file": str(src), "name": "quiet-tone"}},
        # The untouched master sits at −3 dB (see check_master_chain); pin unity so the
        # rendered tone lands where this check expects it relative to the 16-bit LSB.
        {"command": "set_master_volume", "args": {"db": 0.0}},
        {"command": "export_audio", "args": {"file": str(ref24), "bitDepth": 24, "sampleRate": sr}},
        {"command": "export_audio", "args": {"file": str(out16), "bitDepth": 16, "sampleRate": sr}},
        {"command": "export_audio", "args": {"file": str(out32), "bitDepth": 32, "sampleRate": sr}},
    ]
    results, proc = run_script(ctx.bin, cmds, "verify-export-dither")
    fails = failed_commands(results)
    if fails or not all(p.exists() for p in (ref24, out16, out32)):
        return row("16-bit export dithers (CAP-EXP-001)", False,
                   {"failed_commands": fails, "stderr": proc.stderr[-400:]})

    def ch0(path):
        """Left channel of the steady middle of the render — skips any edge ramp/tail."""
        data, s, _ = load_wav(path)
        x = data[:, 0] if data.ndim > 1 else data
        return x[int(0.5 * s):int(3.5 * s)], s

    x24, sr24 = ch0(ref24)
    x16, _ = ch0(out16)
    x32, _ = ch0(out32)
    if min(x24.size, x16.size, x32.size) < DITHER_TONE_SR:
        return row("16-bit export dithers (CAP-EXP-001)", False,
                   {"error": "renders too short to analyse",
                    "frames": [int(x24.size), int(x16.size), int(x32.size)]})

    # Locate the tone in the render rather than assuming it survived at 997 Hz, and
    # sanity-gate its level: this check is only meaningful while the tone sits within a
    # couple of LSBs of the 16-bit floor. A routing/gain change that moves it fails HERE,
    # loudly, instead of silently turning the harmonic probes into a coin flip.
    f0 = dominant_freq_hz(x24, sr24)
    tone_dbfs = float(20.0 * np.log10(max(float(np.sqrt(np.mean(x24 ** 2))) * np.sqrt(2.0), 1e-30)))
    tone_in_window = bool(abs(f0 - DITHER_TONE_HZ) <= 8.0 and -100.0 <= tone_dbfs <= -76.0)

    baseline16 = truncate_to_16bit(x24)          # what main emits today, from ground truth
    a_ref = harmonic_excess_db(x24, sr24, f0)
    a_base = harmonic_excess_db(baseline16, sr24, f0)
    a_dut = harmonic_excess_db(x16, sr24, f0)
    a_32 = harmonic_excess_db(x32, sr24, f0)

    # WITNESS — the undithered baseline must show the distortion this check hunts. It is
    # computed in numpy from ground truth, so it exercises the discriminator on EVERY run:
    # the check cannot pass by measuring nothing.
    witness = bool(a_base["excess_db"] >= 12.0)
    harmonics_gone = bool(a_dut["excess_db"] <= 5.0)
    harmonics_dropped = bool((a_base["excess_db"] - a_dut["excess_db"]) >= 8.0)
    # …AND the floor rose. Twice over, because the two comparisons say different things:
    # against the 24-bit reference it says "there is real added noise at the 16-bit LSB",
    # and against the truncated baseline it says "that noise is where the harmonics USED
    # to be" — truncation error is a line spectrum, so its INTER-harmonic floor sits well
    # below a dithered one. The second is the discriminating half: an undithered render
    # passes the first (its harmonics raise the median too) and fails the second flat.
    floor_rose_vs_reference = bool((a_dut["floor_db"] - a_ref["floor_db"]) >= 20.0)
    floor_rose_vs_truncation = bool((a_dut["floor_db"] - a_base["floor_db"]) >= 6.0)
    float_path_untouched = bool(a_32["floor_db"] <= a_dut["floor_db"] - 30.0)

    ok = bool(tone_in_window and witness and harmonics_gone and harmonics_dropped
              and floor_rose_vs_reference and floor_rose_vs_truncation
              and float_path_untouched)
    return row("16-bit export dithers (CAP-EXP-001)", ok, {
        "tone_hz": round(f0, 2), "tone_dbfs": round(tone_dbfs, 2), "tone_in_window": tone_in_window,
        "ref_24bit": a_ref, "undithered_baseline_16bit": a_base,
        "mosh_16bit": a_dut, "mosh_32bit": a_32,
        "witness_baseline_shows_distortion": witness,
        "harmonics_gone": harmonics_gone,
        "harmonic_drop_db": round(a_base["excess_db"] - a_dut["excess_db"], 2),
        "floor_rose_vs_reference": floor_rose_vs_reference,
        "floor_rise_vs_24bit_db": round(a_dut["floor_db"] - a_ref["floor_db"], 2),
        "floor_rose_vs_truncation": floor_rose_vs_truncation,
        "floor_rise_vs_truncation_db": round(a_dut["floor_db"] - a_base["floor_db"], 2),
        "float_path_untouched": float_path_untouched,
    })


def _span_rms(path, spans):
    """RMS of the rendered mono signal over each [a, b) second span (clamped to the
    file). Spans are given with a margin inside each region so a clip boundary landing a
    frame either side cannot decide the verdict."""
    m, sr, _ = load_wav(path)
    m = mono(m)
    out = []
    for a, b in spans:
        i0, i1 = int(round(a * sr)), min(m.size, int(round(b * sr)))
        seg = m[i0:i1] if i1 > i0 else m[:0]
        out.append(round(float(np.sqrt(np.mean(seg ** 2))) if seg.size else 0.0, 5))
    return out


def check_insert_time(ctx):
    """CAP-CLP-017: insert_time must move the AUDIO, not just the ValueTree.

    `--selftest` proves the STRUCTURE — every downstream clip start moved by exactly the
    inserted duration and undo restored it. It cannot prove the samples followed: the
    whole freeze_layer class of bug is a command whose bookkeeping is perfect and whose
    rendered output is unchanged. So: render the same edit three times through the real
    offline renderer and read where the energy actually is.

    Fixture — one track, a 4s tone at 0 (it STRADDLES the insertion point) and a 1s tone
    at 6, i.e. a 7s edit that sounds  [0,4) tone · [4,6) silence · [6,7) tone.
    Insert 2s at t=2. The edit must then sound
        [0,2) tone · [2,4) NEW SILENCE · [4,6) tone (the split half, delayed 2s) ·
        [6,8) silence · [8,9) tone (delayed 2s)
    — a hole in the audio exactly where the space was opened, and every later sound
    exactly 2s later. Then undo and render again: byte-for-byte the original.

    Loud/quiet is judged RELATIVELY (a quiet window must be < 5% of the loud windows'
    level) rather than against a hardcoded amplitude, so a change to the test tone's gain
    cannot silently turn this into a tautology."""
    SESSION = "verify-insert-time"
    before_out = ART / "13_insert_before.wav"
    after_out = ART / "13_insert_after.wav"
    undo_out = ART / "13_insert_undone.wav"

    cmds = [
        # A FRESH project first. Harness sessions persist between verify.py runs, and this
        # check reads absolute window positions in the rendered file — a leftover track
        # from a previous run would move the energy and turn a real regression into noise
        # (or hide one). The `before` duration assertion below is the belt to this braces.
        {"command": "new_project", "args": {"name": "insert-time-verify"}},
        {"command": "create_track", "args": {"name": "InsertTime"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 4.0, "freq": 220.0}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 1.0, "freq": 660.0},
         "capture": {"C2": "clipId"}},
        {"command": "move_clip", "args": {"clipId": "${C2}", "start": 6.0}},
        {"command": "export_audio", "args": {"file": str(before_out)}},
        {"command": "insert_time", "args": {"start": 2.0, "duration": 2.0}},
        {"command": "export_audio", "args": {"file": str(after_out)}},
        {"command": "undo"},
        {"command": "export_audio", "args": {"file": str(undo_out)}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION)
    fails = failed_commands(results)
    outs = (before_out, after_out, undo_out)
    if fails or not all(p.exists() for p in outs):
        return row("insert_time moves the audio (CAP-CLP-017)", False,
                   {"failed_commands": fails,
                    "exists": {p.name: p.exists() for p in outs},
                    "stderr": proc.stderr[-500:]})

    st_before, st_after, st_undo = (stats(p) for p in outs)

    # BEFORE: tone · silence · tone across a 7s edit.
    b_tone1, b_gap, b_tone2 = _span_rms(before_out, [(0.2, 3.8), (4.2, 5.8), (6.1, 6.9)])
    # AFTER: the SAME material with a 2s hole punched at t=2 and everything after it late.
    a_head, a_hole, a_tail, a_gap, a_late = _span_rms(
        after_out, [(0.2, 1.8), (2.2, 3.8), (4.2, 5.8), (6.2, 7.8), (8.1, 8.9)])

    loud = min(b_tone1, b_tone2, a_head, a_tail, a_late)
    quiet = max(b_gap, a_hole, a_gap)
    pattern_ok = loud > 0.01 and quiet < loud * 0.05

    # The fixture really is the 7s edit this check reasons about (a dirty session or a
    # changed add_test_tone_clip default must fail loudly, not skew the windows quietly).
    fixture_ok = abs(st_before["duration_s"] - 7.0) < 0.05

    # The edit got exactly 2s longer, and the renderer produced exactly that.
    grew_ok = abs(st_after["duration_s"] - (st_before["duration_s"] + 2.0)) < 0.02

    # …and one undo puts the samples back, not just the bookkeeping.
    undo_ok = (st_undo["frames"] == st_before["frames"]
               and diff_rms(before_out, undo_out) < 1e-6)

    ok = fixture_ok and pattern_ok and grew_ok and undo_ok
    return row("insert_time moves the audio (CAP-CLP-017)", ok,
               {"before": st_before, "after": st_after, "undone": st_undo,
                "before_rms": {"tone1": b_tone1, "gap": b_gap, "tone2": b_tone2},
                "after_rms": {"head": a_head, "new_hole": a_hole, "delayed_tail": a_tail,
                              "gap": a_gap, "delayed_tone2": a_late},
                "loud_floor": loud, "quiet_ceiling": quiet,
                "fixture_is_7s": fixture_ok, "pattern_ok": pattern_ok, "grew_by_2s": grew_ok,
                "undo_restores_samples": undo_ok,
                "undo_diff_rms": diff_rms(before_out, undo_out)})


def check_quantize_swing(ctx):
    """CAP-MID-004: `quantize_notes` swing DELAYS every second subdivision of the grid and
    leaves the on-beat subdivisions exactly where they are.

    Proven in RENDERED AUDIO, because that is the only lane that can see a groove. A
    note-position assertion in `--selftest` is precisely the shape of test that passes while
    the result is inaudible — so this renders the SAME clip twice in one process: once
    quantized straight (the control, and the RED reference) and once re-quantized with
    swing. The control must give UNIFORM inter-onset intervals; the swung render must
    ALTERNATE long-short-long-short, with the even (on-beat) onsets unmoved.

    On an engine with no swing term the second quantize is a no-op, both renders are the
    same uniform 16ths, the ratio is ~1.0 and this check FAILS. That is the RED."""
    SESSION = "verify-quantize-swing"
    straight = ART / "13_quantize_straight.wav"
    swung = ART / "13_quantize_swung.wav"
    DIV, SWING, BPM = 0.25, 60.0, 120.0            # 1/16 grid, MPC-65 feel, 8 hits over 2 beats
    # Deterministic jitter so the straight pass is a REAL quantize and not a no-op; every
    # nudge is well under half a division, so each note's target grid slot is unambiguous.
    JITTER = [0.03, -0.04, 0.05, -0.03, 0.04, -0.05, 0.02, -0.02]
    notes = [{"pitch": 42, "start": round(i * DIV + JITTER[i], 4), "length": 0.05, "velocity": 120}
             for i in range(8)]
    cmds = [
        {"command": "set_tempo", "args": {"bpm": BPM}},
        {"command": "create_track", "args": {"name": "Swing", "type": "drum"}, "capture": {"T": "trackId"}},
        {"command": "add_midi_clip", "args": {"trackId": "${T}", "start": 0, "length": 2, "notes": notes},
         "capture": {"C": "clipId"}},
        # Control — `swing` OMITTED, i.e. the untouched default path.
        {"command": "quantize_notes", "args": {"clipId": "${C}", "division": DIV, "strength": 1.0}},
        {"command": "export_audio", "args": {"file": str(straight)}},
        # The same, now dead-on-grid clip, re-quantized WITH swing.
        {"command": "quantize_notes", "args": {"clipId": "${C}", "division": DIV, "strength": 1.0, "swing": SWING}},
        {"command": "export_audio", "args": {"file": str(swung)}},
    ]
    results, proc = run_script(ctx.bin, cmds, SESSION)
    fails = failed_commands(results)
    if fails or not (straight.exists() and swung.exists()):
        return row("Quantize swing (rendered groove)", False,
                   {"failed_commands": fails, "straight": straight.exists(), "swung": swung.exists(),
                    "stderr": proc.stderr[-500:]})

    moved = [r.get("data", {}).get("moved") for r in results if r.get("command") == "quantize_notes"]
    so, sw = onsets_seconds(straight), onsets_seconds(swung)
    detail = {"onsets_straight": [round(t, 4) for t in so], "onsets_swung": [round(t, 4) for t in sw],
              "moved": moved, "division_beats": DIV, "swing": SWING, "bpm": BPM}
    if len(so) != 8 or len(sw) != 8:
        detail["error"] = "onset detection did not resolve 8 hits in both renders"
        return row("Quantize swing (rendered groove)", False, detail)

    si, wi = np.diff(so), np.diff(sw)
    uniform = float(si.max() / si.min()) if si.min() > 0 else 0.0
    # 8 onsets → 7 gaps, so the long run is one longer than the short run; pair them off.
    longs, shorts = wi[0::2], wi[1::2]                       # odd subdivisions were delayed
    n = min(longs.size, shorts.size)
    longs, shorts = longs[:n], shorts[:n]
    ratio = float(longs.mean() / shorts.mean()) if n and shorts.mean() > 0 else 0.0
    # The on-beat subdivisions (even k) must not have moved at all — this is what separates
    # "swing" from "shift the whole pattern late".
    onbeat_drift = max(abs(sw[i] - so[i]) for i in range(0, 8, 2))
    detail.update({"straight_uniformity": round(uniform, 4), "swing_long_short_ratio": round(ratio, 4),
                   "onbeat_drift_s": round(onbeat_drift, 5),
                   "moved_by_swing": moved[1] if len(moved) > 1 else None})
    ok = (uniform < 1.15                                     # control really is straight
          and ratio > 1.4                                    # theory at swing=60 is 0.325/0.175 = 1.857
          and bool((longs > shorts).all())                   # long-short-long-short, every pair
          and onbeat_drift < 0.008                           # the on-beats stayed put (~2 hops)
          and moved[1:] == [4])                              # exactly the 4 odd subdivisions moved
    return row("Quantize swing (rendered groove)", ok, detail)


OFFLINE_CHECKS = [check_spectral_helpers, check_export_dither,
                  check_makes_sound, check_drums, check_transform, check_compile_render,
                  check_compile_corrective, check_midi_render,
                  check_midi_reimagine_beneath, check_reactive_rerender,
                  check_freeze_stops_rerender, check_full_loop,
                  check_relative_ref_export, check_export_range_tail, check_bypass_layer,
                  check_render_artifact_portability, check_crash_recovery,
                  check_skill_transaction_real_engine, check_crash_recovery_safe_mode, check_stem_export,
                  check_clip_fades, check_clip_reverse, check_warp_stretch,
                  check_automation_ramp, check_mute_automation, check_send_return,
                  check_master_chain, check_insert_time, check_quantize_swing]


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
