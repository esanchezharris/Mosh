#!/usr/bin/env python3
"""How close is a render to the FINISHED take — note by note, word by word?

The owner: "it should be pretty easy to tell when your generation is not lined up
rhythmically with my finished take, or if the notes being sung are different." He is right —
we have ground truth, and this report uses it directly. Three tables, no scalar collapse:

  notes   — per sung note: what the TAKE sang over that span vs what the RENDER sang
            (pyin medians), plus the commanded pitch. "note 7 ('piñata'): take E4,
            render D4 (−2.0 st)".
  rhythm  — per word: onset lag render-vs-take (the same word list force-aligned to both).
  words   — the articulation drop list (bench_articulation.word_drops).

Pure cores (`events_with_text`, `note_deltas`, `word_lags`, `summarize`) are golden-tested;
audio/venv bridges are injected. Everything is on the WINDOW clock (0-based): the reference
is the finished-take slice, the render is the snapped output, and the clip's events are
authored t0-relative — all three agree by construction.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "service"))

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_name(m):
    if m is None:
        return "·"
    m = int(round(m))
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def _med(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else None


def _st_median(f0, a, b):
    """Median pitch in MIDI semitones over [a,b) of voiced frames. f0 = [{"t","hz"}...]."""
    hz = [p["hz"] for p in f0 or [] if a <= p["t"] < b and p.get("hz", 0) > 0]
    if not hz:
        return None
    return 69.0 + 12.0 * math.log2(_med(hz) / 440.0)


# ── pure cores ──────────────────────────────────────────────────────────────────────────
def events_with_text(clip):
    """Score chain -> [{start, dur, pitch, type, text}] sung events (types 2/3), with the
    word text carried along so the tables read as words, not indices."""
    durs = [float(d) for d in clip["duration"].split()]
    pitches = [int(p) for p in clip["note_pitch"].split()]
    types = [int(t) for t in clip["note_type"].split()]
    texts = clip["text"].split()
    out, t = [], 0.0
    for d, p, nt, tx in zip(durs, pitches, types, texts):
        if nt in (2, 3) and p > 0 and d > 0:
            out.append({"start": round(t, 4), "dur": round(d, 4), "pitch": p,
                        "type": nt, "text": tx})
        t += d
    return out


def note_deltas(events, take_f0, render_f0):
    """Per sung event: the take's median pitch vs the render's over the SAME span.

    `d_st` = render − take (the number the owner asked for: are the notes different?);
    `d_cmd_st` = render − commanded (did the model obey the score?). Events where either
    side is unvoiced are reported with None deltas rather than dropped — silence where the
    take sings is itself a finding."""
    out = []
    for e in events:
        a, b = e["start"], e["start"] + e["dur"]
        ts = _st_median(take_f0, a, b)
        rs = _st_median(render_f0, a, b)
        out.append({**e,
                    "take_st": round(ts, 2) if ts is not None else None,
                    "render_st": round(rs, 2) if rs is not None else None,
                    "take_note": midi_name(ts), "render_note": midi_name(rs),
                    "d_st": round(rs - ts, 2) if ts is not None and rs is not None else None,
                    "d_cmd_st": round(rs - e["pitch"], 2) if rs is not None else None})
    return out


def word_lags(take_words, render_words, *, min_score=0.1):
    """Per word: onset lag render − take (ms), for words alignable on BOTH sides. The two
    lists are the SAME word list force-aligned to each wav, so they match by index."""
    out = []
    for tw, rw in zip(take_words or [], render_words or []):
        if tw.get("word") != rw.get("word"):
            continue                      # defensive: the lists must be parallel
        if float(tw.get("score", 0)) < min_score or float(rw.get("score", 0)) < min_score:
            out.append({"word": tw["word"], "lag_ms": None})
            continue
        out.append({"word": tw["word"],
                    "lag_ms": round((float(rw["start"]) - float(tw["start"])) * 1000.0, 1)})
    return out


def summarize(notes, lags, drops):
    """Fold to headline numbers WITHOUT losing the tables (they ride along)."""
    ds = sorted(abs(n["d_st"]) for n in notes if n["d_st"] is not None)
    unvoiced = sum(1 for n in notes if n["render_st"] is None and n["take_st"] is not None)
    ls = sorted(abs(l["lag_ms"]) for l in lags if l["lag_ms"] is not None)
    return {
        "notes": {"n": len(notes), "measured": len(ds),
                  "render_silent_where_take_sings": unvoiced,
                  "abs_median_st": round(ds[len(ds) // 2], 2) if ds else None,
                  "within_1_st": round(sum(1 for d in ds if d <= 1.0) / len(ds), 3) if ds else None},
        "rhythm": {"n": len(lags), "measured": len(ls),
                   "abs_median_ms": round(ls[len(ls) // 2], 1) if ls else None,
                   "p90_ms": round(ls[int(0.9 * (len(ls) - 1))], 1) if ls else None},
        "words": {"drop_frac": drops.get("drop_frac"), "dropped": drops.get("dropped", [])},
    }


# ── audio bridges (impure; injectable) ──────────────────────────────────────────────────
def _pyin_f0(wav):
    import mumble_probe as mp
    mono, sr = mp._read_mono(wav)
    return [{"t": p["t"], "hz": p["hz"]} for p in mp._pyin(mono, sr) if p["v"] and p["hz"] > 0]


def conformance(render_wav, ref_wav, clip, words, *, deps=None):
    """The full report: render vs the finished-take slice, given the authored clip and the
    word list it was told to sing."""
    import bench_align
    import bench_articulation
    d = deps or {"f0": _pyin_f0, "align": bench_align.align_words}
    take_f0 = d["f0"](ref_wav)
    render_f0 = d["f0"](render_wav)
    events = events_with_text(clip)
    notes = note_deltas(events, take_f0, render_f0)
    tw = d["align"](ref_wav, words)
    rw = d["align"](render_wav, words)
    lags = word_lags(tw, rw)
    drops = bench_articulation.word_drops(d["align"](render_wav, words) if rw is None else rw)
    return {"summary": summarize(notes, lags, drops),
            "notes": notes, "rhythm": lags, "words": drops}


def print_report(song, rep):
    s = rep["summary"]
    print(f"\n=== {song} ===")
    print(f"  notes : median |Δ| {s['notes']['abs_median_st']} st, within 1 st "
          f"{s['notes']['within_1_st']}, render-silent-where-take-sings "
          f"{s['notes']['render_silent_where_take_sings']}/{s['notes']['n']}")
    print(f"  rhythm: median |lag| {s['rhythm']['abs_median_ms']} ms, p90 {s['rhythm']['p90_ms']} ms")
    print(f"  words : drop {s['words']['drop_frac']}, dropped: {', '.join(s['words']['dropped']) or '—'}")
    off = [n for n in rep["notes"] if n["d_st"] is not None and abs(n["d_st"]) > 1.0]
    if off:
        print("  off-notes:")
        for n in off[:10]:
            print(f"    {n['start']:6.2f}s {n['text']:>12}  take {n['take_note']:>4} → "
                  f"render {n['render_note']:>4}  ({n['d_st']:+.1f} st)")
    late = [l for l in rep["rhythm"] if l["lag_ms"] is not None and abs(l["lag_ms"]) > 100]
    if late:
        print("  off-rhythm (>100ms):")
        for l in late[:10]:
            print(f"    {l['word']:>12}  {l['lag_ms']:+.0f} ms")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="own_run.json from bench_own_run")
    ap.add_argument("--arm", default="pipeline+snap")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    rows = json.load(open(a.run))
    report = {}
    for r in rows:
        song = r["item"].replace("own-", "")
        arms = r["arms"]
        if a.arm not in arms or "reference" not in arms:
            continue
        base = os.path.basename(arms["reference"]["wav"]).replace("_reference.wav", "")
        sj = os.path.join(os.path.dirname(arms["reference"]["wav"]), base + "_pipeline_score.json")
        if not os.path.isfile(sj):
            continue
        clip = json.load(open(sj))
        clip = clip[0] if isinstance(clip, list) else clip
        words = [w for w in clip["text"].split()
                 if w not in ("<SP>", "-")]
        # dedupe consecutive repeats (continuation notes repeat the word token)
        dedup, prev = [], None
        types = [int(x) for x in clip["note_type"].split()]
        for tx, nt in zip(clip["text"].split(), types):
            if nt == 2 and tx not in ("<SP>",):
                dedup.append(tx)
        rep = conformance(arms[a.arm]["wav"], arms["reference"]["wav"], clip, dedup)
        report[song] = rep
        print_report(song, rep)
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        json.dump(report, open(a.out, "w"), indent=1, sort_keys=True)
        print(f"\nwrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
