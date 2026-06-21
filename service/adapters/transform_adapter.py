"""TransformAdapter (Route B) — deterministic FAKE timbre/style transform.

The transform tier's stub: given input audio + a `target` (an instrument name or a
free-text prompt) + a `strength` (0–100), it returns a recognizably re-coloured copy
of the input — a per-target spectral tilt + saturation, wet-mixed by strength — so the
whole orchestration (job submit, progress, cache, RenderLayer `mode:"transform"`,
accept/reject, A/B vs source, the QA readout) is exercised with NO real model and no
external deps (stdlib `wave` only).

The REAL backend (RAVE / MelodyFlow, an isolated venv, env-gated like SA3) swaps in
behind this same `render(input_wav, output_wav, params) -> manifest` contract and the
same `target`+`strength` surface — see docs/superpowers/specs/2026-06-21-route-b-*.
Until then `available()` is False and `server._adapter_for("transform")` falls back to
this deterministic fake (mirrors how `stable_audio3` degrades to `fake_adapter`).
"""
from __future__ import annotations

import math
import os
import struct
import wave


def available() -> bool:
    """True once a real transform backend (RAVE/MelodyFlow) is installed. Stub: False."""
    return False


def backend_name() -> str:
    return "fake-transform"


def _stable_int(text: str) -> int:
    """Deterministic across processes (Python's built-in hash is salted by
    PYTHONHASHSEED, so a render's character must NOT depend on it — the cache key
    would change run-to-run). A small FNV-ish rolling fold over the target string."""
    h = 2166136261
    for ch in text.encode("utf-8"):
        h = ((h ^ ch) * 16777619) & 0xFFFFFFFF
    return h


def _read_wav_floats(path: str):
    with wave.open(path, "rb") as w:
        n_channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        framerate = w.getframerate()
        n_frames = w.getnframes()
        raw = w.readframes(n_frames)
    if sampwidth == 3:
        samples = []
        for k in range(0, len(raw) - 2, 3):
            v = raw[k] | (raw[k + 1] << 8) | (raw[k + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            samples.append(v / 8388608.0)
    else:  # 16-bit (or fall back to it)
        count = len(raw) // 2
        ints = struct.unpack("<%dh" % count, raw) if count else ()
        samples = [v / 32768.0 for v in ints]
    return samples, n_channels, framerate, n_frames


def _write_wav_16(path: str, out, n_channels: int, framerate: int) -> None:
    clamped = [int(max(-32768, min(32767, round(s * 32767.0)))) for s in out]
    body = struct.pack("<%dh" % len(clamped), *clamped) if clamped else b""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(n_channels)
        w.setsampwidth(2)
        w.setframerate(framerate)
        w.writeframes(body)


def _transform_samples(samples, n_channels, target: str, strength: float, seed: int):
    """Per-target deterministic re-colour, wet-mixed by `strength` (0..1).
    A one-pole tilt (dark/bright by target parity) + saturation. Silence in → silence
    out (x==0 → 0), so the delay/null + accept/cache behaviour stays honest."""
    h = _stable_int(target) ^ (int(seed) & 0xFFFFFFFF)
    a = 0.05 + (h % 80) / 100.0            # one-pole coefficient 0.05..0.85
    bright = (h & 1) == 1                   # odd target → high-pass-ish (bright)
    drive = 1.0 + (h % 5) * 0.8            # 1.0..4.2 saturation
    wet = max(0.0, min(1.0, strength))

    out = []
    lp = [0.0] * max(1, n_channels)
    for i in range(0, len(samples), n_channels):
        for c in range(n_channels):
            x = samples[i + c] if i + c < len(samples) else 0.0
            lp[c] = a * lp[c] + (1.0 - a) * x
            shaped = (x - lp[c]) if bright else lp[c]      # tilt
            shaped = math.tanh(shaped * drive) / math.tanh(drive)
            y = (1.0 - wet) * x + wet * shaped
            out.append(max(-1.0, min(1.0, y)))
    return out


def render(input_wav: str, output_wav: str, params: dict) -> dict:
    """Read input_wav, apply the deterministic transform keyed on target+strength+seed,
    write output_wav, return an output manifest."""
    target = str(params.get("target", "") or "")
    strength = float(params.get("strength", 65.0)) / 100.0
    seed = int(params.get("seed", 0))

    samples, n_channels, framerate, n_frames = _read_wav_floats(input_wav)
    out = _transform_samples(samples, n_channels, target, strength, seed)
    _write_wav_16(output_wav, out, n_channels, framerate)

    # QA readout (judge-panel stand-in): the stub reports a plausible production-quality
    # score that dips with heavier strength so the UI can show degradation.
    pq = round(0.83 - strength * 0.12, 3)
    return {
        "ok": True,
        "adapter": "transform",
        "backend": backend_name(),
        "mode": "transform",
        "target": target,
        "strength": round(strength, 3),
        "pq": pq,
        "pq_base": 0.85,
        "flags": (["heavy_transform"] if strength > 0.85 else []),
        "duration_s": round(n_frames / float(framerate), 3) if framerate else 0.0,
        "sample_rate": framerate,
        "channels": n_channels,
    }
