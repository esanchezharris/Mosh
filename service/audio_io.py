"""Shared stdlib WAV output for the service's adapters and venv CLIs.

One writer instead of a hand-rolled copy per adapter: clamp interleaved float
samples ([-1, 1]) to 16-bit PCM in a single bulk struct.pack, and create the
destination directory so a render into a not-yet-created path is a clean
success rather than a FileNotFoundError surfaced to the native client as a
cryptic job error. Pure stdlib — safe to import from the isolated venv CLIs
(e.g. service/transform/transform_cli.py) as well as the service interpreter.
"""
from __future__ import annotations

import os
import struct
import wave


def write_wav(path: str, samples, channels: int, samplerate: int) -> None:
    """Write interleaved float samples as 16-bit PCM at `path`."""
    clamped = [int(max(-32768, min(32767, round(s * 32767.0)))) for s in samples]
    body = struct.pack("<%dh" % len(clamped), *clamped) if clamped else b""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(samplerate)
        w.writeframes(body)
