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
def gen_oracle(mumbled_wav, clean_wav, out_wav):
    shutil.copyfile(clean_wav, out_wav)


def gen_passthrough(mumbled_wav, clean_wav, out_wav):
    shutil.copyfile(mumbled_wav, out_wav)


def gen_pipeline(mumbled_wav, clean_wav, out_wav):
    raise RuntimeError("the real FMS sing pipeline generator is owner/GPU-gated (SoulX) — "
                       "arm it via the local MLX / PC lane, then wire it here")


GENERATORS = {"oracle": gen_oracle, "passthrough": gen_passthrough, "pipeline": gen_pipeline}


# ── per-item run (impure; deps injectable) ──────────────────────────────────────────────
def _real_deps():
    import bench_mumble
    import bench_score
    return {"mumble": bench_mumble.mumble_wav, "score": bench_score.score_vocal}


def run_item(item, ratio, generator, out_dir, *, seed=0, deps=None):
    d = deps or _real_deps()
    os.makedirs(out_dir, exist_ok=True)
    base = f"{item['id']}_r{int(round(ratio * 100)):02d}"
    mumbled = os.path.join(out_dir, base + "_mumble.wav")
    d["mumble"](item["clean_vocal"], item["words"], ratio, mumbled, seed=seed)
    gen_wav = os.path.join(out_dir, f"{base}_{generator}.wav")
    GENERATORS[generator](mumbled, item["clean_vocal"], gen_wav)
    true_words = [w["word"] for w in item["words"] if w["word"].isalpha()]
    stats = d["score"](item["clean_vocal"], gen_wav, true_words=true_words)
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
        for r in ratios:
            for g in gens:
                print(f"  run {it['id']} ρ={r} {g} …", flush=True)
                runs.append(run_item(it, r, g, a.out, seed=a.seed))
    board = build_scoreboard(runs)
    json.dump({"runs": [{k: v for k, v in r.items() if k != "stats"} | {"stats": r["stats"]}
                        for r in runs], "scoreboard": board},
              open(os.path.join(a.out, "scoreboard.json"), "w"), indent=1, sort_keys=True)
    print("\nscoreboard:", json.dumps(board, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
