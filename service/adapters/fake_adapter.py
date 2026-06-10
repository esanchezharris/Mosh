"""FakeAdapter (05 §2) — deterministic placeholder generative model.

Returns a recognizably-altered copy of the input audio (a seeded gain + one-pole
low-pass + a touch of saturation), so the full orchestration — job submit,
progress, cache, RenderLayer states, accept/reject, A/B vs source, the taste log —
is exercised with NO real model and no external deps (stdlib `wave` only). The
StableAudio3Adapter swaps in later behind the same job protocol.
"""
from __future__ import annotations

import math
import struct
import wave


def _transform_samples(samples, n_channels, seed, nl, drive):
    # Deterministic params from seed/nl (no randomness needed for a stub).
    gain = 0.6 + (seed % 97) / 240.0          # 0.6..~1.0
    lp = max(0.0, min(0.95, 0.15 + nl * 0.6)) # low-pass amount from init_noise_level
    sat = 1.0 + drive * 2.0

    out = []
    prev = [0.0] * max(1, n_channels)
    for i in range(0, len(samples), n_channels):
        for c in range(n_channels):
            x = samples[i + c] if i + c < len(samples) else 0.0
            y = lp * prev[c] + (1.0 - lp) * (x * gain)
            y = math.tanh(y * sat) / math.tanh(sat) if sat > 1.0 else y
            prev[c] = y
            out.append(max(-1.0, min(1.0, y)))
    return out


def render(input_wav: str, output_wav: str, params: dict) -> dict:
    """Read input_wav, apply the deterministic transform, write output_wav.
    Returns an output manifest dict (production-quality readout etc.)."""
    seed = int(params.get("seed", 0))
    nl = float(params.get("nl", 0.4))
    drive = 0.0
    for col in params.get("colors", []) or []:
        # Colors are 0–100 ASTD UI values; treat 'grit'/'aggression' as drive.
        if col.get("name") in ("grit", "aggression", "distortion"):
            drive = max(drive, float(col.get("value", 0)) / 100.0)

    with wave.open(input_wav, "rb") as w:
        n_channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        framerate = w.getframerate()
        n_frames = w.getnframes()
        raw = w.readframes(n_frames)

    # Decode to floats (16/24-bit PCM).
    if sampwidth == 2:
        count = len(raw) // 2
        ints = struct.unpack("<%dh" % count, raw)
        samples = [v / 32768.0 for v in ints]
    elif sampwidth == 3:
        samples = []
        for k in range(0, len(raw) - 2, 3):
            v = raw[k] | (raw[k + 1] << 8) | (raw[k + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            samples.append(v / 8388608.0)
    else:  # fall back: treat as 16-bit
        count = len(raw) // 2
        ints = struct.unpack("<%dh" % count, raw)
        samples = [v / 32768.0 for v in ints]

    out = _transform_samples(samples, n_channels, seed, nl, drive)

    # Encode back to 16-bit PCM and write.
    clamped = [int(max(-32768, min(32767, round(s * 32767.0)))) for s in out]
    body = struct.pack("<%dh" % len(clamped), *clamped)
    with wave.open(output_wav, "wb") as w:
        w.setnchannels(n_channels)
        w.setsampwidth(2)
        w.setframerate(framerate)
        w.writeframes(body)

    # A QA readout (judge-panel stand-in, 05 §7): the stub reports a plausible
    # production-quality score vs the source so the UI can show degradation.
    return {
        "ok": True,
        "adapter": "fake",
        "pq": round(0.82 - drive * 0.1, 3),
        "pq_base": 0.85,
        "flags": (["heavy_drive"] if drive > 0.7 else []),
        "duration_s": round(n_frames / float(framerate), 3),
        "sample_rate": framerate,
        "channels": n_channels,
    }


def generate(output_wav: str, params: dict) -> dict:
    """text_to_audio for the stub (latent.generate, phase0 §3.3): synthesize a
    short seeded tone cluster — a pure function of (prompt, seed, seconds), so
    identical params yield BYTE-IDENTICAL output on every machine. That is the
    property the replay-determinism conformance test (phase0 §4 req 1) pins for
    seeded latent ops; the real model honors the same contract via seed +
    model_version + sampler config.
    """
    import hashlib

    seed = int(params["seed"])              # REQUIRED — the service never defaults a seed
    prompt = str(params.get("prompt", ""))
    seconds = max(0.1, min(60.0, float(params.get("seconds", 4.0))))
    framerate, channels = 44100, 2

    # Three partials + decay envelope, all derived from md5(prompt|seed).
    digest = hashlib.md5(f"{prompt}|{seed}".encode("utf-8")).digest()
    base = 55.0 * (2.0 ** ((digest[0] % 24) / 12.0))            # 55–220 Hz
    ratios = [1.0, 1.5 + (digest[1] % 100) / 200.0, 2.0 + (digest[2] % 100) / 100.0]
    amps = [0.5, 0.3 * (digest[3] / 255.0), 0.2 * (digest[4] / 255.0)]
    decay = 1.5 + (digest[5] % 100) / 50.0

    n = int(seconds * framerate)
    frames = []
    for i in range(n):
        t = i / framerate
        env = math.exp(-decay * t / seconds)
        s = sum(a * math.sin(2.0 * math.pi * base * r * t) for r, a in zip(ratios, amps)) * env
        v = int(max(-32768, min(32767, round(s * 32767.0))))
        frames.append(v)   # left
        frames.append(v)   # right (stereo dual-mono)

    body = struct.pack("<%dh" % len(frames), *frames)
    with wave.open(output_wav, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(framerate)
        w.writeframes(body)

    return {
        "ok": True,
        "adapter": "fake",
        "mode": "text_to_audio",
        "pq": 0.8,
        "pq_base": 0.85,
        "flags": [],
        "duration_s": round(seconds, 3),
        "sample_rate": framerate,
        "channels": channels,
        "seed": seed,
        "prompt": prompt,
    }
