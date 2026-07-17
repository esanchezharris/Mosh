#!/usr/bin/env python3
"""Golden tests for score_vocal (injected lab deps → no audio/venvs).

Run:  python3 scripts/fms-killshot/bench_score_test.py   (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_score as bs  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# fake lab: read returns (mono,sr); f0 returns []; analyze returns a canned correctness bundle
CORR = {"global_lag_ms": 12.0, "onsets": {"f1": 0.8}, "energy": {"render_in_take_silence_pct": 6.0},
        "f0": {"abs_median_st": 0.4, "octave_error_rate": 0.0}}
deps = {
    "read": lambda p: ([0.0, 0.1], 44100),
    "f0": lambda mono, sr: [],
    "analyze": lambda ref, sr_r, gen, sr_g, f0r, f0g, clip: dict(CORR),
    "naturalness": lambda wav: {"pq": 6.1, "singmos": 4.0},
    "asr": lambda wav: ["hold", "the", "flame"],
}
st = bs.score_vocal("clean.wav", "gen.wav", true_words=["hold", "the", "flame"], deps=deps)
check("has correctness axis", "onsets" in st["correctness"], str(list(st["correctness"].keys())))
check("has naturalness axis", st["naturalness"] == {"pq": 6.1, "singmos": 4.0}, str(st["naturalness"]))
check("word-match vs TRUE words", st["correctness"]["words"]["bag_coverage"] == 1.0,
      str(st["correctness"].get("words")))
check("meta names files",
      st["meta"]["reference"] == "clean.wav" and st["meta"]["generated"] == "gen.wav", str(st["meta"]))
check("meta records sample rates", st["meta"]["sr"] == {"reference": 44100, "generated": 44100})

# no true_words → no word-match row (score-only path stays clean)
st2 = bs.score_vocal("clean.wav", "gen.wav", deps=deps)
check("no true_words -> no words row", "words" not in st2["correctness"])

# ASR unavailable (returns None) → no words row, no crash
deps_noasr = dict(deps); deps_noasr["asr"] = lambda wav: None
st3 = bs.score_vocal("clean.wav", "gen.wav", true_words=["hold"], deps=deps_noasr)
check("asr None -> no words row (graceful)", "words" not in st3["correctness"])

# the output shape is exactly what bench_metrics.ranks/aggregate consume
import bench_metrics as bm  # noqa: E402
check("shape feeds bench_metrics.aggregate", bm.aggregate([st])["n"] == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
