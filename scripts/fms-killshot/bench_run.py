#!/usr/bin/env python3
"""FMS-Bench faithful audio-in runner: mumble a dataset item, generate, score vs the clean
vocal, and pivot into a mumble-ratio scoreboard.

Per item × ρ: `bench_mumble.mumble_wav` degrades a fraction ρ of the words → a pluggable
GENERATOR turns the mumble into a "finished" vocal → `bench_score.score_vocal` scores it
against the CLEAN human vocal (the ground truth). Generators:
  oracle       — generated = the clean vocal (upper bound; correctness ≈ perfect).
  passthrough  — generated = the mumbled input (lower bound; the degraded audio itself).
  pipeline     — the real FMS sing pipeline (skeleton→lyrics→SoulX→snap→NSF); owner/GPU-gated.

The oracle/passthrough brackets prove the scoreboard responds correctly and establish the
metric RANGE on real audio; the `pipeline` generator produces the real numbers once armed.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


# ── generators (pluggable) ──────────────────────────────────────────────────────────────
def gen_oracle(mumbled_wav, clean_wav, out_wav, item=None):
    shutil.copyfile(clean_wav, out_wav)


def gen_passthrough(mumbled_wav, clean_wav, out_wav, item=None):
    shutil.copyfile(mumbled_wav, out_wav)


def gen_pipeline(mumbled_wav, clean_wav, out_wav, item=None):
    """The REAL FMS sing pipeline: author_score(true words + F0) → local SoulX render.
    Renders the first 12 s window (the SoulX chunk unit); for the windowed 3-way scoreboard
    (oracle/passthrough/pipeline scored on the same window with the forced-align ruler) use
    bench_third_curve.py, which scores like-for-like. Needs the item (words + clean vocal)."""
    if item is None:
        raise RuntimeError("gen_pipeline needs the dataset item (true words + clean vocal)")
    import bench_pipeline_render as pr
    pr.pipeline_generate(item, out_wav, t0=0.0, t1=12.0)


GENERATORS = {"oracle": gen_oracle, "passthrough": gen_passthrough, "pipeline": gen_pipeline}


# ── per-item run (impure; deps injectable) ──────────────────────────────────────────────
def _subproc_mumble(clean, words, ratio, out, *, seed=0):
    """Run bench_mumble in a fresh subprocess so librosa/numba never load in THIS process
    (the flaky-import-order isolation — keeps the long-lived run loop clean)."""
    import subprocess
    import tempfile
    fd, wf = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        with open(wf, "w") as f:
            json.dump(words, f)
        r = subprocess.run([sys.executable, os.path.join(HERE, "bench_mumble.py"),
                            "--clean", clean, "--words", wf, "--ratio", str(ratio),
                            "--seed", str(seed), "--out", out],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"bench_mumble failed: {r.stderr[-400:]}")
        return json.loads(r.stdout)
    finally:
        os.remove(wf)


def _real_deps():
    import bench_score
    return {"mumble": _subproc_mumble, "score": bench_score.score_vocal}


def whisper_true_words(clean_wav):
    """Ground-truth words for word_match = Whisper on the CLEAN vocal (real intelligible
    words), NOT the reverse-CMUdict reconstruction (whose phone-labels/homophones Whisper
    would never reproduce). NUS spans still drive the mumble; this only feeds word_match."""
    import bench_score
    aw = bench_score._real_deps()["asr"](clean_wav)
    return [w for w in (aw or []) if w and w.strip().isalpha()]


def run_item(item, ratio, generator, out_dir, *, seed=0, true_words=None, deps=None):
    d = deps or _real_deps()
    os.makedirs(out_dir, exist_ok=True)
    base = f"{item['id']}_r{int(round(ratio * 100)):02d}"
    mumbled = os.path.join(out_dir, base + "_mumble.wav")
    d["mumble"](item["clean_vocal"], item["words"], ratio, mumbled, seed=seed)
    gen_wav = os.path.join(out_dir, f"{base}_{generator}.wav")
    GENERATORS[generator](mumbled, item["clean_vocal"], gen_wav, item)
    # true_words defaults to the NUS reconstruction (fallback); the CLI passes Whisper-on-clean.
    tw = true_words if true_words is not None else [w["word"] for w in item["words"] if w["word"].isalpha()]
    stats = d["score"](item["clean_vocal"], gen_wav, true_words=tw)
    return {"item": item["id"], "ratio": ratio, "generator": generator,
            "stats": stats, "mumbled": mumbled, "generated": gen_wav}


# ── scoreboard (pure) ───────────────────────────────────────────────────────────────────
def _pivot(agg_by_ratio, ratios, axis):
    keys = sorted({k for r in ratios for k in agg_by_ratio[r].get(axis, {})})
    return {k: [agg_by_ratio[r].get(axis, {}).get(k) for r in ratios] for k in keys}


def build_scoreboard(runs):
    """Group runs by generator × ratio, aggregate each cell, pivot into ratio-ordered curves."""
    import bench_metrics as bm
    by = {}
    for r in runs:
        by.setdefault(r["generator"], {}).setdefault(r["ratio"], []).append(r["stats"])
    out = {}
    for gen, cells in by.items():
        ratios = sorted(cells)
        agg = {r: bm.aggregate(cells[r]) for r in ratios}
        out[gen] = {"ratios": ratios,
                    "n": [agg[r]["n"] for r in ratios],
                    "correctness": _pivot(agg, ratios, "correctness"),
                    "naturalness": _pivot(agg, ratios, "naturalness")}
    return out


# ── CLI ─────────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="nus-48e")
    ap.add_argument("--limit", type=int, default=3)
    ap.add_argument("--singers", help="comma list, e.g. ADIZ,JLEE")
    ap.add_argument("--ratios", default="0.2,0.4,0.6")
    ap.add_argument("--generators", default="oracle,passthrough")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/run"))
    a = ap.parse_args()

    import bench_dataset as bd
    singers = a.singers.split(",") if a.singers else None
    items = bd.nus_items(singers=singers, limit=a.limit)
    ratios = [float(x) for x in a.ratios.split(",")]
    gens = a.generators.split(",")
    os.makedirs(a.out, exist_ok=True)

    runs = []
    for it in items:
        tw = whisper_true_words(it["clean_vocal"])          # once per item (Whisper on clean)
        print(f"  {it['id']}: {len(tw)} true words from clean vocal", flush=True)
        for r in ratios:
            for g in gens:
                print(f"  run {it['id']} ρ={r} {g} …", flush=True)
                runs.append(run_item(it, r, g, a.out, seed=a.seed, true_words=tw))
    board = build_scoreboard(runs)
    json.dump({"runs": [{k: v for k, v in r.items() if k != "stats"} | {"stats": r["stats"]}
                        for r in runs], "scoreboard": board},
              open(os.path.join(a.out, "scoreboard.json"), "w"), indent=1, sort_keys=True)
    print("\nscoreboard:", json.dumps(board, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
