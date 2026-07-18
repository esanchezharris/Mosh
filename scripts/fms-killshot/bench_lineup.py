#!/usr/bin/env python3
"""Waveform LINEUP report — the owner's sentence as an instrument.

"There shouldn't be silence where there's a sustained, vice versa." For a render vs the
FINISHED take this reports, span by span:

  missing   — the take sustains, the render is silent
  spurious  — the take rests, the render sings

Each span is CLASSIFIED against the authored score: did the score COMMAND that silence
(`in_rest` — an authoring bug, fix the score) or did the model disobey a commanded note
(`in_note` — under-fill, fix the model side)? That attribution is what picks the lever;
without it "27% silent" blames nobody.

Also measured: the GLOBAL lag (envelope cross-correlation) and what the report would read
after removing it — how much a single safe global shift buys (per-word snapping stays
banned per V3; a uniform shift is not per-word snapping).

Pure cores (`voicing_mask`, `mismatch_spans`, `best_shift`, `lineup_from_envs`) are
golden-tested; audio I/O is the thin `lineup()` wrapper. House thresholds throughout:
take-active = perform's GATE_FRAC gate, render-singing = perform's voicing threshold.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "service"))

from skeleton.core import energy_envelope  # noqa: E402
from soulx.perform import (HOP_S, _gate_threshold, _voicing_threshold,  # noqa: E402
                           note_spans, resample_hq)

MIN_SPAN_S = 0.08          # ignore sub-80ms flutter — threshold jitter, not a finding
MAX_SHIFT_S = 0.25         # global-lag search range (the snap clamp, same number)


# ── pure cores ──────────────────────────────────────────────────────────────────────────
def voicing_mask(env, th):
    """Frame mask: is there sound above `th`?"""
    return [e >= th for e in env]


def best_shift(env_a, env_b, hop_s=HOP_S, max_shift_s=MAX_SHIFT_S):
    """Integer-hop shift (seconds) maximizing correlation of env_b against env_a.
    POSITIVE = b (the render) runs LATE by that much. Plain Pearson over the overlap."""
    n = min(len(env_a), len(env_b))
    if n < 4:
        return 0.0
    max_k = min(n - 2, int(max_shift_s / hop_s))

    def corr(k):
        # b LATE by k frames means b[i] == a[i-k]; test that by pairing a[i] with b[i+k]
        if k >= 0:
            xs = list(zip(env_a[:n - k], env_b[k:n]))
        else:
            xs = list(zip(env_a[-k:n], env_b[:n + k]))
        if len(xs) < 2:
            return -2.0
        ma = sum(a for a, _ in xs) / len(xs)
        mb = sum(b for _, b in xs) / len(xs)
        cov = sum((a - ma) * (b - mb) for a, b in xs)
        va = sum((a - ma) ** 2 for a, _ in xs)
        vb = sum((b - mb) ** 2 for _, b in xs)
        return cov / (va * vb) ** 0.5 if va > 0 and vb > 0 else -2.0

    best_k, best_c = 0, corr(0)
    for k in range(-max_k, max_k + 1):
        c = corr(k)
        if c > best_c + 1e-12:
            best_k, best_c = k, c
    return round(best_k * hop_s, 4)


def _spans_from_mask(flags, hop_s, min_s):
    out, start = [], None
    for i, f in enumerate(flags + [False]):
        if f and start is None:
            start = i
        elif not f and start is not None:
            dur = (i - start) * hop_s
            if dur >= min_s:
                out.append((round(start * hop_s, 3), round(i * hop_s, 3)))
            start = None
    return out


def mismatch_spans(mask_take, mask_render, hop_s=HOP_S, min_s=MIN_SPAN_S):
    """Contiguous [{'kind','start','end','dur_s'}] where the two masks disagree.
    kind 'missing'  = take voiced, render silent (silence where there's a sustained)
    kind 'spurious' = take silent, render voiced (the vice versa)"""
    n = min(len(mask_take), len(mask_render))
    miss = [mask_take[i] and not mask_render[i] for i in range(n)]
    spur = [not mask_take[i] and mask_render[i] for i in range(n)]
    out = []
    for kind, flags in (("missing", miss), ("spurious", spur)):
        for a, b in _spans_from_mask(flags, hop_s, min_s):
            out.append({"kind": kind, "start": a, "end": b, "dur_s": round(b - a, 3)})
    return sorted(out, key=lambda s: s["start"])


def classify_spans(spans, sung_spans):
    """Attach `commanded`: what the SCORE said over each span — 'note' (the model was told
    to sing and didn't / was told to sing and the take rests), 'rest' (the score itself
    commanded it), or 'mixed'. Overlap fractions decide (>=0.7 either way)."""
    for s in spans:
        dur = max(s["end"] - s["start"], 1e-9)
        ov = 0.0
        for a, b in sung_spans:
            ov += max(0.0, min(s["end"], b) - max(s["start"], a))
        f = ov / dur
        s["commanded"] = "note" if f >= 0.7 else ("rest" if f <= 0.3 else "mixed")
        s["note_overlap"] = round(f, 2)
    return spans


def attribute_words(spans, words):
    """Attach the overlapping (else nearest) word from the take's aligned word list."""
    for s in spans:
        best, best_d = None, None
        for w in words or []:
            a, b = float(w.get("start", 0)), float(w.get("end", 0))
            if a < s["end"] and b > s["start"]:
                best, best_d = w.get("word"), 0.0
                break
            d = min(abs(a - s["end"]), abs(s["start"] - b))
            if best_d is None or d < best_d:
                best, best_d = w.get("word"), d
        s["word"] = best
    return spans


def _fracs(mask_take, mask_render):
    n = min(len(mask_take), len(mask_render))
    voiced = sum(1 for i in range(n) if mask_take[i])
    silent = n - voiced
    miss = sum(1 for i in range(n) if mask_take[i] and not mask_render[i])
    spur = sum(1 for i in range(n) if not mask_take[i] and mask_render[i])
    return {"missing_frac": round(miss / voiced, 3) if voiced else 0.0,
            "spurious_frac": round(spur / silent, 3) if silent else 0.0}


def _shift_mask(mask, k):
    """Render mask moved EARLIER by k frames (k>0 = it was late). Pure."""
    if k > 0:
        return mask[k:] + [False] * k
    if k < 0:
        return [False] * (-k) + mask[:len(mask) + k]
    return list(mask)


def lineup_from_envs(env_take, env_render, hop_s=HOP_S, *, words=None, sung_spans=None,
                     min_s=MIN_SPAN_S):
    """The full report from two energy envelopes. Pure — this is what the golden pins."""
    th_t = _gate_threshold(env_take)
    th_r = _voicing_threshold(env_render)
    mt = voicing_mask(env_take, th_t)
    mr = voicing_mask(env_render, th_r)
    lag_s = best_shift(env_take, env_render, hop_s)

    spans = mismatch_spans(mt, mr, hop_s, min_s)
    if sung_spans is not None:
        spans = classify_spans(spans, sung_spans)
    if words is not None:
        spans = attribute_words(spans, words)

    raw = _fracs(mt, mr)
    shifted = _fracs(mt, _shift_mask(mr, int(round(lag_s / hop_s))))
    by = {}
    for s in spans:
        key = f"{s['kind']}@{s.get('commanded', '?')}"
        by[key] = round(by.get(key, 0.0) + s["dur_s"], 3)
    return {"lag_ms": round(lag_s * 1000.0, 1), "raw": raw, "after_global_shift": shifted,
            "span_s_by_class": by, "spans": spans,
            "take_voiced_frac": round(sum(mt) / len(mt), 3) if mt else 0.0,
            "render_voiced_frac": round(sum(mr) / len(mr), 3) if mr else 0.0}


# ── audio wrapper ───────────────────────────────────────────────────────────────────────
def _read(path):
    import soundfile as sf
    y, sr = sf.read(path)
    if getattr(y, "ndim", 1) > 1:
        y = y.mean(axis=1)
    return [float(v) for v in y], sr


def lineup(take_wav, render_wav, *, clip=None, words=None):
    take, sr_t = _read(take_wav)
    render, sr_r = _read(render_wav)
    if sr_r != sr_t:
        render = resample_hq(render, sr_r, sr_t)
    env_t = energy_envelope(take, sr_t, hop_ms=HOP_S * 1000.0)
    env_r = energy_envelope(render, sr_t, hop_ms=HOP_S * 1000.0)
    sung = note_spans(clip, len(render) / sr_t) if clip else None
    return lineup_from_envs(env_t, env_r, HOP_S, words=words, sung_spans=sung)


def print_report(song, rep):
    print(f"\n== {song} ==  lag {rep['lag_ms']:+.0f} ms   "
          f"take voiced {rep['take_voiced_frac']:.0%} / render {rep['render_voiced_frac']:.0%}")
    print(f"  missing (silent where you sustain): {rep['raw']['missing_frac']:.1%}"
          f"  -> after global shift {rep['after_global_shift']['missing_frac']:.1%}")
    print(f"  spurious (sings where you rest)   : {rep['raw']['spurious_frac']:.1%}"
          f"  -> after global shift {rep['after_global_shift']['spurious_frac']:.1%}")
    if rep.get("span_s_by_class"):
        print("  seconds by class: " + ", ".join(f"{k}={v:.2f}s"
              for k, v in sorted(rep["span_s_by_class"].items())))
    for s in rep["spans"][:14]:
        w = f" '{s.get('word')}'" if s.get("word") else ""
        c = f" [{s.get('commanded')}]" if s.get("commanded") else ""
        print(f"    {s['kind']:8s} {s['start']:6.2f}-{s['end']:6.2f} ({s['dur_s']:.2f}s){c}{w}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="own_run.json of a round")
    ap.add_argument("--arm", default="pipeline+snap")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    rows = json.load(open(a.run))
    base = os.path.dirname(os.path.abspath(a.run))
    out = {}
    for r in rows:
        song = r["item"].replace("own-", "")
        arms = r.get("arms", {})
        if a.arm not in arms or "reference" not in arms:
            continue
        clip = None
        for f in os.listdir(base):
            if f.startswith(song) and f.endswith("_pipeline_score.json"):
                sc = json.load(open(os.path.join(base, f)))
                clip = sc[0] if isinstance(sc, list) else sc
        words = r.get("take_words")
        rep = lineup(arms["reference"]["wav"], arms[a.arm]["wav"], clip=clip, words=words)
        out[song] = rep
        print_report(song, rep)
    if a.out:
        json.dump(out, open(a.out, "w"), indent=1)
        print(f"\nwrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
