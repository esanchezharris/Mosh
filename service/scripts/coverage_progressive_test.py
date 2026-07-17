#!/usr/bin/env python3
"""Golden: streaming lookahead — progressive windowed coverage (service/coverage.py).

The streaming contract: a long-clip re-render no longer goes dark until the
whole render finishes. In progressive mode the stitch windows render in
PLAYHEAD-AHEAD order (the window after the one under the playhead first,
wrapping), and after each window the coverage layer writes a full-length
artifact — fresh audio where rendered, the ORIGINAL input audio elsewhere,
crossfaded at the seams — as `output.progressive.<seq>.wav` (atomic rename).
The native side lands each at a musical boundary; the final output.wav +
manifest stay byte-for-byte what non-progressive mode produces.

Hermetic: the FAKE adapter with MOSH_FAKE_WINDOW_S=1 forces multi-window
stitch coverage with no model. 3× deterministic.
"""
import glob
import hashlib
import json
import os
import shutil
import struct
import sys
import tempfile
import wave

SERVICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVICE)

import coverage  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── window_order: playhead-ahead, wrapping ────────────────────────────────────
check("order: playhead mid window 0 → next window first",
      coverage.window_order(4, 1.2, 2.0) == [1, 2, 3, 0],
      str(coverage.window_order(4, 1.2, 2.0)))
check("order: playhead in window 1 → [2,3,0,1]",
      coverage.window_order(4, 3.9, 2.0) == [2, 3, 0, 1])
check("order: playhead in the LAST window wraps to [0..]",
      coverage.window_order(4, 7.9, 2.0) == [0, 1, 2, 3])
check("order: no playhead → natural order",
      coverage.window_order(4, None, 2.0) == [0, 1, 2, 3])
check("order: negative playhead → natural order",
      coverage.window_order(4, -1.0, 2.0) == [0, 1, 2, 3])
check("order: single window → [0]",
      coverage.window_order(1, 5.0, 2.0) == [0])


# ── end-to-end with the fake adapter (window-capped) ──────────────────────────
def write_tone(path, seconds, sr=44100, freq=220.0):
    import math
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(int(seconds * sr)):
            v = int(12000 * math.sin(2 * math.pi * freq * i / sr))
            frames += struct.pack("<hh", v, v)
        w.writeframes(bytes(frames))


def read_pcm(path):
    with wave.open(path, "rb") as w:
        return w.readframes(w.getnframes()), w.getframerate(), w.getnchannels()


def run_once(tmp, playhead):
    os.environ["MOSH_FAKE_WINDOW_S"] = "1.0"
    try:
        from adapters import fake_adapter
        inp = os.path.join(tmp, "input.wav")
        out = os.path.join(tmp, "output.wav")
        write_tone(inp, 4.0)
        params = {"seed": 3, "nl": 0.4, "coverage": "stitch", "duration_s": 4.0,
                  "xfade_ms": 8.0, "progressive": True, "playhead_s": playhead}
        m = fake_adapter.render(inp, out, params)
        return m, sorted(glob.glob(out + ".progressive.*.wav"),
                         key=lambda p: int(p.rsplit(".", 2)[-2]))
    finally:
        os.environ.pop("MOSH_FAKE_WINDOW_S", None)


tmp = tempfile.mkdtemp(prefix="cov-prog-")
try:
    m, progs = run_once(tmp, playhead=1.5)   # playhead in window 1 → order [2,3,0,1]
    check("manifest ok + stitch coverage", m.get("ok") is True and m.get("coverage") == "stitch")
    check("4 progressive artifacts written", len(progs) == 4, str([os.path.basename(p) for p in progs]))
    check("manifest reports progressive count", m.get("progressive") == 4, str(m.get("progressive")))

    final_pcm, sr, ch = read_pcm(os.path.join(tmp, "output.wav"))
    in_pcm, _, _ = read_pcm(os.path.join(tmp, "input.wav"))
    check("final output is full length", len(final_pcm) == len(in_pcm),
          f"{len(final_pcm)} vs {len(in_pcm)}")

    p1, _, _ = read_pcm(progs[0])
    check("progressive artifacts are full length", len(p1) == len(in_pcm))

    # Progressive #1 rendered window 2 ([2s,3s)) first: its INTERIOR differs from
    # the input there, while a window far from any seam (window 0 interior) is
    # still the ORIGINAL audio byte-for-byte.
    bpf = 2 * ch                     # bytes per frame
    def region(pcm, a_s, b_s):
        return pcm[int(a_s * sr) * bpf: int(b_s * sr) * bpf]
    check("p1: rendered window (2..3s interior) is FRESH audio",
          region(p1, 2.2, 2.8) != region(in_pcm, 2.2, 2.8))
    check("p1: untouched window (0..1s interior) is ORIGINAL audio",
          region(p1, 0.2, 0.8) == region(in_pcm, 0.2, 0.8))

    # The LAST progressive artifact has EVERY window rendered, at ABSOLUTE clip
    # positions (progressive artifacts stay beat-aligned to the source; the final
    # stitched output compacts each seam by the crossfade — a pre-existing stitch
    # property — so compare against p1's identical window render, not the stitch).
    plast, _, _ = read_pcm(progs[-1])
    check("last progressive: window-2 interior consistent with p1's render",
          region(plast, 2.2, 2.8) == region(p1, 2.2, 2.8))
    for a_s, b_s in ((0.2, 0.8), (1.2, 1.8), (2.2, 2.8), (3.2, 3.8)):
        if region(plast, a_s, b_s) == region(in_pcm, a_s, b_s):
            check(f"last progressive window {int(a_s)} is fresh", False)
            break
    else:
        check("last progressive: ALL window interiors are fresh audio", True)

    # ── determinism: 3× identical progressive + final checksums ──────────────────
    def digest(run_tmp):
        m2, pr = run_once(run_tmp, playhead=1.5)
        h = hashlib.sha256()
        for p in pr + [os.path.join(run_tmp, "output.wav")]:
            h.update(read_pcm(p)[0])
        return h.hexdigest()

    d1 = digest(tempfile.mkdtemp(prefix="cov-prog-a"))
    d2 = digest(tempfile.mkdtemp(prefix="cov-prog-b"))
    d3 = digest(tempfile.mkdtemp(prefix="cov-prog-c"))
    check("3× deterministic (progressive + final)", d1 == d2 == d3)

    # ── non-progressive path byte-identical to before (no flag → no artifacts) ───
    tmp2 = tempfile.mkdtemp(prefix="cov-plain-")
    os.environ["MOSH_FAKE_WINDOW_S"] = "1.0"
    from adapters import fake_adapter
    inp2 = os.path.join(tmp2, "input.wav")
    out2 = os.path.join(tmp2, "output.wav")
    write_tone(inp2, 4.0)
    m3 = fake_adapter.render(inp2, out2, {"seed": 3, "nl": 0.4, "coverage": "stitch",
                                          "duration_s": 4.0, "xfade_ms": 8.0})
    os.environ.pop("MOSH_FAKE_WINDOW_S", None)
    check("no progressive flag → no progressive artifacts",
          glob.glob(out2 + ".progressive.*.wav") == [])
    check("plain stitched output matches progressive final (same windows)",
          read_pcm(out2)[0] == final_pcm)
    check("plain manifest has no progressive field", "progressive" not in m3)

finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(fails)} failures")
sys.exit(1 if fails else 0)
