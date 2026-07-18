#!/usr/bin/env python3
"""Is our SYNTHETIC mumble a fair stand-in for a REAL one?

Every scaled bench lane (NUS) manufactures its mumble by degrading a clean vocal. The
owner's real (mumble → finished) pairs let us check that substitution for the first time:
degrade his FINISHED take with `bench_mumble` and compare the result's signature against
his ACTUAL mumble of the same song, on the same three axes `mumble_probe` measures —
ASR confidence (is it as unintelligible?), F0 (does it keep the melody?), and energy
(does it keep the performance?).

Both arms are measured against the same reference (the finished take) with the same probe,
so the comparison is like-for-like. The synthetic arm runs at ratio 1.0 because a real
mumble mumbles the whole take — nothing in it was deliberately kept intelligible.

Run:  bench_mumble_realism.py [--ratio 1.0] [--phase 1.0]
Artifacts land outside git.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _synth_mumble(clean_wav, words, ratio, out_wav, *, seed=0):
    """Shell out to bench_mumble so librosa/numba never import into this process
    (the documented flaky-import-order isolation)."""
    fd, wf = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        json.dump(words, open(wf, "w"))
        r = subprocess.run([sys.executable, os.path.join(HERE, "bench_mumble.py"),
                            "--clean", clean_wav, "--words", wf, "--ratio", str(ratio),
                            "--seed", str(seed), "--out", out_wav],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"bench_mumble failed: {r.stderr[-400:]}")
        return json.loads(r.stdout)
    finally:
        os.remove(wf)


def run_item(item, out_dir, *, ratio=1.0, seed=0):
    import mumble_probe as mp

    os.makedirs(out_dir, exist_ok=True)
    ref = item["clean_vocal"]                       # the finished take
    words = item["words"]                           # Whisper words WITH confidence
    spans = [(float(w["start"]), float(w["end"])) for w in words]

    synth = os.path.join(out_dir, f"{item['song']}.synth_r{int(ratio * 100)}.wav")
    sel = _synth_mumble(ref, words, ratio, synth, seed=seed)

    return {
        "item": item["id"],
        "n_words": len(words),
        "selected": sel.get("n_selected") if isinstance(sel, dict) else None,
        # REAL: his own draft. Spans = every word — a real mumble keeps nothing clean.
        "real": mp.measure(ref, item["mumble_vocal"], spans, words),
        # SYNTHETIC: the same finished take, degraded by us.
        "synth": mp.measure(ref, synth, spans, words),
        "synth_wav": synth,
    }


def _fmt(v, w=7, p=3):
    return f"{v:{w}.{p}f}" if isinstance(v, (int, float)) else f"{'·':>{w}}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratio", type=float, default=1.0)
    ap.add_argument("--songs")
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/mumble-realism"))
    a = ap.parse_args()

    import bench_own_pairs as op
    items = op.own_pairs_items(songs=a.songs.split(",") if a.songs else None)
    os.makedirs(a.out, exist_ok=True)

    rows = []
    for it in items:
        print(f"  {it['id']} …", flush=True)
        rows.append(run_item(it, a.out, ratio=a.ratio))
    json.dump(rows, open(os.path.join(a.out, "mumble_realism.json"), "w"), indent=1, sort_keys=True)

    print(f"\n=== real vs synthetic mumble signature (ratio {a.ratio}) ===")
    print(f"  {'song':16} {'arm':6} {'degConf':>8} {'confDrop':>9} {'f0_dSemi':>9} "
          f"{'f0_within½':>11} {'voicedKept':>11} {'energyCorr':>11}")
    for r in rows:
        for arm in ("real", "synth"):
            m = r[arm]
            print(f"  {r['item']:16} {arm:6} {_fmt(m['asr']['degraded_conf'],8)} "
                  f"{_fmt(m['asr']['conf_drop'],9)} {_fmt(m['f0']['median_dsemi'],9,2)} "
                  f"{_fmt(m['f0']['within_half'],11)} {_fmt(m['f0']['voiced_kept'],11)} "
                  f"{_fmt(m['energy']['corr'],11)}")

    def mean(arm, path):
        v = [r[arm][path[0]][path[1]] for r in rows if r[arm][path[0]][path[1]] is not None]
        return sum(v) / len(v) if v else None
    print("\n=== means ===")
    for lab, path in (("degraded_conf", ("asr", "degraded_conf")),
                      ("f0 median_dsemi", ("f0", "median_dsemi")),
                      ("energy corr", ("energy", "corr"))):
        print(f"  {lab:18} real={_fmt(mean('real', path))}   synth={_fmt(mean('synth', path))}")
    print(f"\nwrote {os.path.join(a.out, 'mumble_realism.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
