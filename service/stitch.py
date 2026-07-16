"""Deterministic whole-clip coverage DSP (stdlib `wave`/`struct` only — callable from any
adapter, incl. the stdlib-only fake path).

Two ways to cover a clip longer than a model's single-render window:
  - tile_to_length: render ONE cycle, repeat it to fill the target (loops/beats — in time).
  - stitch_windows: render consecutive windows, overlap-add crossfade them (through-composed).

All math is integer-PCM (16-bit) with a fixed equal-power crossfade, so the same inputs +
params produce byte-identical output → stable golden checksums. No numpy, no randomness.
"""
from __future__ import annotations

import math
import struct
import wave


def _read(path):
    """Decode a WAV to interleaved native-depth signed ints. Handles 16- and 24-bit PCM
    (MIDI/drum bounces are bitDepth=24) the same way the per-window adapters do. The
    sample width rides back out so `_write` can preserve it (round-trip fidelity)."""
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        samples = list(struct.unpack("<%dh" % (len(raw) // 2), raw))   # interleaved int16
    elif sw == 3:
        samples = []                                                   # 3-byte LE signed int24
        for k in range(0, len(raw) - 2, 3):
            v = raw[k] | (raw[k + 1] << 8) | (raw[k + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            samples.append(v)
    else:   # the adapters emit 16/24-bit; anything else, fail loud
        raise ValueError(f"stitch expects 16- or 24-bit PCM, got sampwidth={sw}")
    return samples, ch, sr, sw


def _write(path, samples, ch, sr, sw=2):
    with wave.open(path, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(sw); w.setframerate(sr)
        if sw == 3:
            body = bytearray()
            for s in samples:
                v = max(-0x800000, min(0x7FFFFF, int(s))) & 0xFFFFFF   # clamp to int24, 3-byte LE
                body += bytes((v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF))
            w.writeframes(bytes(body))
        else:
            body = struct.pack("<%dh" % len(samples),
                               *[max(-32768, min(32767, int(s))) for s in samples])
            w.writeframes(body)


def wav_duration(path) -> float:
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def slice_wav(in_path, out_path, start_s, len_s):
    """Write [start_s, start_s+len_s) of in_path to out_path (clamped to the source)."""
    samples, ch, sr, sw = _read(in_path)
    total = len(samples) // ch
    a = max(0, min(total, int(round(start_s * sr))))
    b = max(a, min(total, int(round((start_s + len_s) * sr))))
    _write(out_path, samples[a * ch: b * ch], ch, sr, sw)


def _equal_power(i, n):
    """Constant-power crossfade gain pair at step i of n (fade-out, fade-in)."""
    x = (i + 0.5) / n
    return math.cos(x * math.pi / 2.0), math.sin(x * math.pi / 2.0)


def _xfade_join(a, b, ch, xfade_frames):
    """Concatenate interleaved int16 buffers a then b, equal-power crossfading the last
    xfade_frames of a with the first xfade_frames of b. Returns the joined buffer."""
    na, nb = len(a) // ch, len(b) // ch
    x = max(0, min(xfade_frames, na, nb))
    if x == 0:
        return a + b
    out = a[: (na - x) * ch]                       # a up to the fade region
    for i in range(x):
        go, gi = _equal_power(i, x)
        for c in range(ch):
            av = a[(na - x + i) * ch + c]
            bv = b[i * ch + c]
            out.append(int(av * go + bv * gi))
    out.extend(b[x * ch:])                          # remainder of b
    return out


def tile_to_length(in_path, out_path, target_s, xfade_ms=1.0):
    """Repeat in_path (one cycle) to fill target_s, crossfading each loop seam so it doesn't
    click. The result is exactly target_s long (trimmed)."""
    samples, ch, sr, sw = _read(in_path)
    cyc = len(samples) // ch
    if cyc <= 0:
        _write(out_path, samples, ch, sr, sw); return
    target_frames = int(round(target_s * sr))
    xf = min(int(round(xfade_ms / 1000.0 * sr)), cyc // 2)
    buf = list(samples)
    # Append crossfaded copies until we cover target_frames (+ headroom for the trim).
    while len(buf) // ch < target_frames:
        buf = _xfade_join(buf, list(samples), ch, xf)
    _write(out_path, buf[: target_frames * ch], ch, sr, sw)


def stitch_windows(window_paths, out_path, target_s, xfade_ms=1.0):
    """Overlap-add crossfade consecutive window renders into one continuous file of target_s."""
    if not window_paths:
        raise ValueError("stitch_windows: no windows")
    first, ch, sr, sw = _read(window_paths[0])
    buf = list(first)
    xf = int(round(xfade_ms / 1000.0 * sr))
    for p in window_paths[1:]:
        seg, c2, s2, w2 = _read(p)
        buf = _xfade_join(buf, list(seg), ch, xf)
    target_frames = int(round(target_s * sr))
    if len(buf) // ch < target_frames:              # pad with silence if short
        buf.extend([0] * ((target_frames - len(buf) // ch) * ch))
    _write(out_path, buf[: target_frames * ch], ch, sr, sw)
