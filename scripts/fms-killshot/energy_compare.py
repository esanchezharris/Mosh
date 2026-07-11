#!/usr/bin/env python3
"""Per-window energy conformance: render vs take (the owner's QA rule).

"Compare the audio levels at each second to the take — if there's a long sustained note
where there's none in the original, there's probably a problem." This is a far more robust
signal than onset-F1/ASR on a low-register take (those are measurement artifacts here).

Each clip's per-window RMS is normalised to its OWN peak (so absolute level/gain differences
don't matter — we compare the ENVELOPE SHAPE). A window is flagged:
  RENDER_IN_TAKE_SILENCE  render is loud where the take is quiet  (over-hold / phantom note)
  TAKE_IN_RENDER_SILENCE  take is loud where the render is quiet  (dropped/missing content)

Pure stdlib + `wave`. Deterministic. Embedded `--selftest` (3x identical).

Usage:  energy_compare.py --take take.wav --render sung.wav [--win 1.0]
        energy_compare.py --selftest
"""
from __future__ import annotations

import argparse
import array
import math
import sys
import wave


def read_pcm_mono(path: str):
    with wave.open(path, "rb") as w:
        sr, ch = w.getframerate(), w.getnchannels()
        a = array.array("h")
        a.frombytes(w.readframes(w.getnframes()))
    if ch == 2:
        a = a[0::2]
    return list(a), sr


def envelope(samples, sr: int, win_s: float = 1.0):
    """Per-window RMS energy (window = win_s seconds)."""
    n = max(1, int(sr * win_s))
    out = []
    for s in range(0, len(samples), n):
        seg = samples[s:s + n]
        if not seg:
            break
        out.append(math.sqrt(sum(x * x for x in seg) / len(seg)))
    return out


def _normalize(env):
    peak = max(env) if env else 0.0
    return [x / peak for x in env] if peak > 0 else [0.0 for _ in env]


def compare(take_env, render_env, voiced: float = 0.15, loud: float = 0.25):
    """Take/render per-window RMS → normalised envelope comparison + flagged windows.

    voiced = normalised level below which a clip is 'silent'; loud = level above which the
    OTHER clip's energy in that silence is a real mismatch (not noise)."""
    tn, rn = _normalize(take_env), _normalize(render_env)
    m = max(len(tn), len(rn))
    windows, mism_rs, mism_tr = [], 0, 0
    for i in range(m):
        t = tn[i] if i < len(tn) else 0.0
        r = rn[i] if i < len(rn) else 0.0
        flag = None
        if r > loud and t < voiced:
            flag = "RENDER_IN_TAKE_SILENCE"
            mism_rs += 1
        elif t > loud and r < voiced:
            flag = "TAKE_IN_RENDER_SILENCE"
            mism_tr += 1
        windows.append({"sec": i, "take": round(t, 3), "render": round(r, 3), "flag": flag})
    # envelope correlation (shape agreement) over the overlapping region
    k = min(len(tn), len(rn))
    corr = _pearson(tn[:k], rn[:k]) if k >= 2 else 0.0
    return {
        "windows": windows,
        "render_in_take_silence": mism_rs,
        "take_in_render_silence": mism_tr,
        "flagged_pct": round(100.0 * (mism_rs + mism_tr) / m, 1) if m else 0.0,
        "envelope_corr": round(corr, 3),
        "n_windows": m,
    }


def _pearson(a, b):
    n = len(a)
    if n == 0:
        return 0.0
    ma, mb = sum(a) / n, sum(b) / n
    da = [x - ma for x in a]
    db = [x - mb for x in b]
    num = sum(x * y for x, y in zip(da, db))
    den = math.sqrt(sum(x * x for x in da) * sum(y * y for y in db))
    return num / den if den else 0.0


def selftest() -> int:
    fails = []

    def check(name, ok, detail=""):
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    # render sustains where the take is silent (the over-hold bug)
    r = compare([100, 100, 0, 0], [100, 100, 100, 100])
    check("render-in-take-silence flagged (2 windows)", r["render_in_take_silence"] == 2, str(r))
    check("those windows carry the RENDER_IN_TAKE_SILENCE flag",
          [w["flag"] for w in r["windows"][2:]] == ["RENDER_IN_TAKE_SILENCE"] * 2)
    # identical envelope shape → no flags, corr ~1
    r2 = compare([50, 100, 20, 80], [500, 1000, 200, 800])  # same shape, different gain
    check("gain-invariant: identical shapes → no mismatches", r2["render_in_take_silence"] == 0
          and r2["take_in_render_silence"] == 0, str(r2))
    check("identical shapes → envelope_corr ~1.0", r2["envelope_corr"] > 0.99, str(r2["envelope_corr"]))
    # take present where render dropped out
    r3 = compare([100, 100, 100, 100], [100, 100, 0, 0])
    check("take-in-render-silence flagged (2 windows)", r3["take_in_render_silence"] == 2, str(r3))
    # determinism
    check("deterministic", compare([100, 100, 0, 0], [100, 100, 100, 100]) == r)

    print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
    return len(fails)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--take")
    ap.add_argument("--render")
    ap.add_argument("--win", type=float, default=1.0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not (args.take and args.render):
        ap.error("need --take and --render (or --selftest)")

    ts, tsr = read_pcm_mono(args.take)
    rs, rsr = read_pcm_mono(args.render)
    te = envelope(ts, tsr, args.win)
    re = envelope(rs, rsr, args.win)
    res = compare(te, re)
    print(f"per-{args.win:g}s energy — take vs render (normalised to each peak)")
    print(f"{'win':>4} | {'take':>5} {'':20} | {'render':>6} {'':20} | flag")
    tn, rn = _normalize(te), _normalize(re)
    for w in res["windows"]:
        t, r = w["take"], w["render"]
        bt, br = "#" * int(t * 20), "#" * int(r * 20)
        f = f"  <-- {w['flag']}" if w["flag"] else ""
        print(f"{w['sec']:>4} | {t:.2f} {bt:20} | {r:.2f} {br:20} |{f}")
    print(f"\nenvelope_corr={res['envelope_corr']}  "
          f"render_in_take_silence={res['render_in_take_silence']}  "
          f"take_in_render_silence={res['take_in_render_silence']}  flagged={res['flagged_pct']}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
