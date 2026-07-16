"""FakeAdapter (05 §2) — deterministic placeholder generative model.

Returns a recognizably-altered copy of the input audio (a seeded gain + one-pole
low-pass + a touch of saturation), so the full orchestration — job submit,
progress, cache, RenderLayer states, accept/reject, A/B vs source, the taste log —
is exercised with NO real model and no external deps (stdlib `wave` only). The
StableAudio3Adapter swaps in later behind the same job protocol.
"""
from __future__ import annotations

import math
import os
import struct
import sys
import wave

# Share the judge-reasoning helper with the real Audiobox path (service/quality_readout.py)
# so the stub's manifest surfaces the same "reasoning" field the drawer renders (AL-006).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
import quality_readout  # noqa: E402
from audio_io import write_wav  # noqa: E402
import coverage  # noqa: E402  (whole-clip tile/stitch orchestration)


def render(input_wav: str, output_wav: str, params: dict) -> dict:
    """Whole-clip aware entry: the fake has no length cap, so it renders the full input in one
    window for the default/stitch path and tiles one cycle for the loop path."""
    return coverage.render(_render_window, input_wav, output_wav, params, coverage.WINDOW_UNCAPPED)


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


def _render_window(input_wav: str, output_wav: str, params: dict) -> dict:
    """Read input_wav, apply the deterministic transform, write output_wav (ONE window).
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

    write_wav(output_wav, out, n_channels, framerate)

    # A QA readout (judge-panel stand-in, 05 §7): the stub reports a plausible
    # production-quality score vs the source so the UI can show degradation.
    pq = round(0.82 - drive * 0.1, 3)
    flags = ["heavy_drive"] if drive > 0.7 else []
    # AL-006: synthesize the judge's reasoning the same way the real path does, so the
    # default (FakeAdapter) green path also surfaces it. The stub's pq is a 0–1 score, so
    # scale to the judge's 0–10 axis for the shared reasoning helper.
    reasoning = quality_readout.judge_reasoning(axes={"PQ": pq * 10.0}, flags=flags)
    manifest = {
        "ok": True,
        "adapter": "fake",
        "pq": pq,
        "pq_base": 0.85,
        "flags": flags,
        "reasoning": reasoning,
        "duration_s": round(n_frames / float(framerate), 3),
        "sample_rate": framerate,
        "channels": n_channels,
    }
    # LoRA rack honesty: the fake never applies adapters, but it must echo what
    # was asked so the loop (params → job → manifest) is provable hermetically.
    if params.get("loras"):
        manifest["loras"] = [{"name": str(l.get("name", "")),
                              "strength": float(l.get("value", 0)) / 100.0}
                             for l in params["loras"]]
        manifest["loras_applied"] = False
    return manifest
