#!/usr/bin/env python3
"""Golden tests for the stereo A/B mixer — the by-ear judging tool.

To tell whether a written verse sits on the mumble, the owner needs to hear them
TOGETHER: the raw mumble in one ear, the words-on-your-melody guide in the other, on the
same timeline. `ab_mix.stereo_ab` reads two mono WAVs, resamples to a common rate, and
interleaves them L/R. Pure stdlib + audio_io.write_wav; deterministic.

Run:  python3 service/soulx/ab_mix_test.py     (exit 0 = all pass)
"""
import math
import os
import struct
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from soulx import ab_mix  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def write_mono(path, freq, dur, sr, amp=0.4):
    n = int(dur * sr)
    frames = [int(amp * 32767 * math.sin(2 * math.pi * freq * i / sr)) for i in range(n)]
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(struct.pack("<%dh" % n, *frames))


def read_wav(path):
    with wave.open(path, "rb") as w:
        ch, sr, n = w.getnchannels(), w.getframerate(), w.getnframes()
        data = list(struct.unpack("<%dh" % (n * ch), w.readframes(n)))
    return ch, sr, data


def corr(x, y):
    n = min(len(x), len(y))
    x, y = x[:n], y[:n]
    sx = math.sqrt(sum(a * a for a in x)) or 1.0
    sy = math.sqrt(sum(b * b for b in y)) or 1.0
    return sum(a * b for a, b in zip(x, y)) / (sx * sy)


tmp = tempfile.mkdtemp(prefix="abmix_")
A, B, OUT = os.path.join(tmp, "a.wav"), os.path.join(tmp, "b.wav"), os.path.join(tmp, "ab.wav")

# ── same sample rate: the two tones land verbatim in their channels ───────────────────
write_mono(A, 220.0, 0.5, 44100)   # "mumble" (low tone) -> LEFT
write_mono(B, 880.0, 0.5, 44100)   # "guide"  (high tone) -> RIGHT
ab_mix.stereo_ab(A, B, OUT, sr=44100)
ch, sr, data = read_wav(OUT)
L, R = data[0::2], data[1::2]
_, _, adata = read_wav(A)
_, _, bdata = read_wav(B)

check("output is stereo", ch == 2, f"channels={ch}")
check("output sample rate is the target", sr == 44100, f"sr={sr}")
check("both channels are non-silent", max(map(abs, L)) > 1000 and max(map(abs, R)) > 1000)
check("channels are distinct (not duplicated)", L != R)
check("LEFT carries the mumble (correlates with A, not B)",
      corr(L, adata) > 0.9 and corr(L, adata) > corr(L, bdata), f"{corr(L, adata):.2f} vs {corr(L, bdata):.2f}")
check("RIGHT carries the guide (correlates with B, not A)",
      corr(R, bdata) > 0.9 and corr(R, bdata) > corr(R, adata), f"{corr(R, bdata):.2f} vs {corr(R, adata):.2f}")

# ── unequal length: output runs to the LONGER input; shorter is zero-padded ───────────
write_mono(B, 880.0, 0.25, 44100)  # guide is half as long as the mumble
_, _, bshort = read_wav(B)
ab_mix.stereo_ab(A, B, OUT, sr=44100)
_, _, data2 = read_wav(OUT)
L2, R2 = data2[0::2], data2[1::2]
check("length runs to the longer input", len(L2) == len(adata) and len(R2) == len(adata))
check("shorter channel is silent past its end (padded)", max(map(abs, R2[len(bshort) + 5:])) == 0)

# ── different sample rates: both resampled to the common target, aligned in time ──────
write_mono(A, 220.0, 0.5, 22050)   # mumble at half rate
write_mono(B, 880.0, 0.5, 44100)
ab_mix.stereo_ab(A, B, OUT, sr=44100)
ch3, sr3, data3 = read_wav(OUT)
L3 = data3[0::2]
check("mismatched rates resampled to target (len ~= 0.5s @ 44100)", ch3 == 2 and sr3 == 44100 and abs(len(L3) - 22050) <= 3, f"len={len(L3)}")
check("resampled left still non-silent", max(map(abs, L3)) > 1000)

# ── gains: right channel can be attenuated so the guide sits under the take ───────────
write_mono(A, 220.0, 0.3, 44100)
write_mono(B, 880.0, 0.3, 44100)
ab_mix.stereo_ab(A, B, OUT, sr=44100, right_gain=0.5)
_, _, data4 = read_wav(OUT)
L4, R4 = data4[0::2], data4[1::2]
check("right_gain attenuates the guide channel (~half energy)",
      0.4 < (max(map(abs, R4)) / max(1, max(map(abs, L4)))) < 0.6, f"ratio={max(map(abs, R4)) / max(1, max(map(abs, L4))):.2f}")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
