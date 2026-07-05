#!/usr/bin/env python3
"""Output-side alignment lever (the owner's auto-tune idea, time half): snap a sung
render onto the original take using the KNOWN correspondence — per-phrase time shifts
measured by envelope cross-correlation, applied at rest boundaries with short
crossfades. Pitch needs no snapping (calibration: the model's contour residual is
0.20 st median once register transposition is folded out).

  align_render.py --take take.wav --render sung.wav --score target_score.json
                  --out aligned.wav [--max-shift-ms 200]

Selftest: synthetic phrases shifted by known amounts are corrected within 10 ms.
"""
from __future__ import annotations

import argparse
import hashlib
import math
import os
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import overlap as ov                 # noqa: E402
from skeleton import core as skcore  # noqa: E402

XFADE_S = 0.010


def phrase_shifts(env_take, env_render, windows, hop_s=ov.HOP_S, max_shift_s=0.2):
    """Per-phrase lag of the render vs the take (positive = render late), measured
    inside each score phrase window PADDED by the max shift (an unpadded window clips
    a late phrase's tail and biases the correlation low); clamped to +/- max_shift_s."""
    out = []
    for (a, b, _n) in windows:
        lag = ov.window_lag(env_take, env_render, max(0.0, a - max_shift_s),
                            b + max_shift_s, hop_s, max_lag_s=max_shift_s)
        out.append(max(-max_shift_s, min(max_shift_s, lag)))
    return out


def apply_shifts(render, sr, windows, shifts, total_s=None):
    """Rebuild the render on the take's timeline: each phrase's audio is copied from
    its (lag-shifted) source span to the score-true span, crossfaded at the seams.
    Gaps between phrases stay silent (rests are rests)."""
    n_total = int((total_s if total_s is not None else (len(render) / sr)) * sr) + int(0.25 * sr)
    out = [0.0] * n_total
    xf = max(1, int(XFADE_S * sr))
    for (a, b, _n), lag in zip(windows, shifts):
        dst0, dst1 = int(a * sr), min(int(b * sr), n_total)
        src0 = int((a + lag) * sr)
        for i in range(dst0, dst1):
            j = src0 + (i - dst0)
            v = render[j] if 0 <= j < len(render) else 0.0
            # crossfade envelope at the phrase seams (fade-in/out within the window)
            e = min(1.0, (i - dst0 + 1) / xf, (dst1 - i) / xf)
            out[i] += v * e
    return out


def align(take_path, render_path, score_path, out_path, max_shift_ms=200):
    rt = skcore.read_pcm_mono(take_path)
    rr = skcore.read_pcm_mono(render_path)
    if not rt or not rr:
        raise SystemExit("inputs must be stdlib-readable PCM")
    take, sr_t = rt
    rend, sr_r = rr
    rend44 = ov.resample_linear(rend, sr_r, sr_t)
    env_t = skcore.energy_envelope(take, sr_t)
    env_r = skcore.energy_envelope(rend44, sr_t)
    import json
    doc = json.load(open(score_path))
    clip = doc[0] if isinstance(doc, list) else doc
    windows = ov.phrase_windows_from_score(clip)
    shifts = phrase_shifts(env_t, env_r, windows, max_shift_s=max_shift_ms / 1000.0)
    out = apply_shifts(rend44, sr_t, windows, shifts, total_s=len(take) / sr_t)
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr_t)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767))))
                               for v in out))
    return {"phrases": len(windows),
            "shifts_ms": [round(s * 1000, 1) for s in shifts]}


# ── selftest ───────────────────────────────────────────────────────────────────────────

def _selftest_once() -> str:
    import json
    sr = 8000

    def tone(hz, dur_s, amp=0.5):
        n = int(dur_s * sr)
        fade = max(1, int(0.008 * sr))
        return [amp * min(1.0, i / fade, (n - i) / fade) * math.sin(2 * math.pi * hz * i / sr)
                for i in range(n)]

    # take: two phrases at 0.2 and 1.2; render: same phrases but late by 80 and 140 ms
    take = [0.0] * int(0.2 * sr) + tone(220, 0.5) + [0.0] * int(0.5 * sr) + tone(330, 0.5) + [0.0] * int(0.3 * sr)
    rend = [0.0] * int(0.28 * sr) + tone(220, 0.5) + [0.0] * int(0.56 * sr) + tone(330, 0.5) + [0.0] * int(0.16 * sr)
    clip = {"duration": "0.20 0.5000 0.50 0.5000 0.30", "note_pitch": "0 57 0 64 0",
            "note_type": "1 2 1 2 1", "text": "<SP> la <SP> la <SP>"}
    env_t = skcore.energy_envelope(take, sr)
    env_r = skcore.energy_envelope(rend, sr)
    wins = ov.phrase_windows_from_score(clip)
    shifts = phrase_shifts(env_t, env_r, wins)
    assert len(shifts) == 2, shifts
    assert abs(shifts[0] - 0.08) <= 0.02 and abs(shifts[1] - 0.14) <= 0.02, shifts

    out = apply_shifts(rend, sr, wins, shifts, total_s=len(take) / sr)
    env_o = skcore.energy_envelope(out, sr)
    resid = phrase_shifts(env_t, env_o, wins)
    assert all(abs(s) <= 0.01 for s in resid), resid   # corrected within 10 ms
    return json.dumps({"shifts": shifts, "resid": resid}, sort_keys=True)


def main() -> int:
    if "--selftest" in sys.argv:
        digs = {hashlib.sha256(_selftest_once().encode()).hexdigest() for _ in range(3)}
        assert len(digs) == 1, "align selftest not deterministic"
        print("align selftest PASS (3x deterministic)")
        return 0
    ap = argparse.ArgumentParser()
    ap.add_argument("--take", required=True)
    ap.add_argument("--render", required=True)
    ap.add_argument("--score", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-shift-ms", type=float, default=200)
    args = ap.parse_args()
    import json
    print(json.dumps(align(args.take, args.render, args.score, args.out, args.max_shift_ms)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
