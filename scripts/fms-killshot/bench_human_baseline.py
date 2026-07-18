#!/usr/bin/env python3
"""FMS-Bench human-baseline calibration — what do the metrics read when BOTH sides are a
real human singing the same song?

Every FMS score so far has been relative (better/worse than some other render). Nobody had
measured what a HUMAN scores, so "good" had no absolute scale — the oracle (a clean vocal
against itself) is a trivial 1.0 and teaches nothing. The owner's real (mumble → finished)
pairs answer it.

Per song, two arms scored against the FINISHED take as reference:
  mumble    — the real draft. Simultaneously (a) the FLOOR the pipeline must beat, and
              (b) the human-to-human distance: how far apart two genuine performances sit.
  finished  — identity. Pins the ceiling and proves the harness is wired correctly.

Also reports the singing-capable forced-align word ruler on both arms (Whisper cannot read
sung content) and pq on the raw human vocal — the test of whether our naturalness axis
tracks human-ness at all, or merely production polish.

Registered prediction: docs/superpowers/specs/2026-07-18-fms-bench-human-baseline-prediction.md
Artifacts land outside git.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

ARMS = ("mumble", "finished")


def energy_corr(ref_wav, other_wav):
    """Envelope correlation via the canonical `soulx.perform.env_corr` (Pearson over
    reference-ACTIVE frames) — the same convention every prior FMS audit reported.

    NOTE: `overlap.analyze`'s `energy` block is silence LEAKAGE (percentages), not a
    correlation; there is no envelope-correlation key to read off it."""
    sys.path.insert(0, os.path.join(REPO, "service"))
    from skeleton.core import read_pcm_mono
    from soulx.perform import env_corr
    a, sr_a = read_pcm_mono(ref_wav)
    b, sr_b = read_pcm_mono(other_wav)
    if sr_a != sr_b:
        return None
    return round(float(env_corr(list(a), list(b), sr_a)), 4)


def run_item(item, out_dir, *, deps=None):
    import bench_align
    import bench_naturalness
    import bench_score

    os.makedirs(out_dir, exist_ok=True)
    ref = item["clean_vocal"]                      # the FINISHED take = ground truth
    true_words = [w["word"] for w in item["words"] if str(w.get("word", "")).strip()]
    arms = {"mumble": item["mumble_vocal"], "finished": ref}

    row = {"item": item["id"], "n_true_words": len(true_words), "arms": {}}
    for name, wav in arms.items():
        stats = bench_score.score_vocal(ref, wav, true_words=true_words, deps=deps)
        row["arms"][name] = {
            "stats": stats,
            "word_align": bench_align.word_align_score(wav, true_words),
            "pq": bench_naturalness.pq_score(wav),
            "energy_corr": energy_corr(ref, wav),
            "onset_f1": (stats.get("correctness", {}).get("onsets") or {}).get("f1"),
            "wav": wav,
        }
    return row


def calibration(rows):
    """Rows -> the calibration table: the human band per metric, plus the arm means."""
    import bench_metrics as bm
    out = {"n_songs": len(rows), "band": {}, "arms": {}}
    for metric in ("energy_corr", "onset_f1", "pq"):
        out["band"][metric] = bm.human_band([r["arms"]["mumble"].get(metric) for r in rows])
    out["band"]["word_align"] = bm.human_band(
        [(r["arms"]["mumble"].get("word_align") or {}).get("mean_score") for r in rows])
    for arm in ARMS:
        out["arms"][arm] = {
            "energy_corr": bm.human_band([r["arms"][arm].get("energy_corr") for r in rows]),
            "onset_f1": bm.human_band([r["arms"][arm].get("onset_f1") for r in rows]),
            "pq": bm.human_band([r["arms"][arm].get("pq") for r in rows]),
            "word_align": bm.human_band(
                [(r["arms"][arm].get("word_align") or {}).get("mean_score") for r in rows]),
            "word_align_hit": bm.human_band(
                [(r["arms"][arm].get("word_align") or {}).get("hit_frac") for r in rows]),
        }
    return out


def _fmt(v, w=6, p=3):
    return f"{v:{w}.{p}f}" if isinstance(v, (int, float)) else f"{'·':>{w}}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--songs", help="comma list; default all")
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/human-baseline"))
    a = ap.parse_args()

    import bench_own_pairs as op
    items = op.own_pairs_items(songs=a.songs.split(",") if a.songs else None)
    os.makedirs(a.out, exist_ok=True)

    rows = []
    for it in items:
        print(f"  {it['id']} …", flush=True)
        rows.append(run_item(it, a.out))
    cal = calibration(rows)
    json.dump({"rows": rows, "calibration": cal},
              open(os.path.join(a.out, "human_baseline.json"), "w"), indent=1, sort_keys=True)

    print("\n=== per song (arm scored against the FINISHED take) ===")
    print(f"  {'song':16} {'arm':9} {'energyCorr':>10} {'onsetF1':>8} {'wordAlign':>10} {'hit':>6} {'pq':>7}")
    for r in rows:
        for arm in ARMS:
            d = r["arms"][arm]
            wa = d.get("word_align") or {}
            print(f"  {r['item']:16} {arm:9} {_fmt(d.get('energy_corr'),10)} {_fmt(d.get('onset_f1'),8)} "
                  f"{_fmt(wa.get('mean_score'),10)} {_fmt(wa.get('hit_frac'),6,2)} {_fmt(d.get('pq'),7,2)}")
    print("\n=== THE HUMAN BAND (mumble → finished: the floor, and how far two human takes sit apart) ===")
    for k, b in cal["band"].items():
        print(f"  {k:12} lo={_fmt(b['lo'])} hi={_fmt(b['hi'])} mean={_fmt(b['mean'])} spread={_fmt(b['spread'])}")
    print(f"\nwrote {os.path.join(a.out, 'human_baseline.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
