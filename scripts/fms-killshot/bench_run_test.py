#!/usr/bin/env python3
"""Golden tests for the faithful-run harness: pure scoreboard pivot + run_item wiring.

Run:  python3 scripts/fms-killshot/bench_run_test.py   (exit 0 = all pass)
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_run as br  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _raises(fn):
    try:
        fn()
        return False
    except Exception:
        return True


# ── build_scoreboard: group by generator × ratio, pivot into ratio-ordered curves ──
def st(f1, pq):
    return {"correctness": {"onsets": {"f1": f1}}, "naturalness": {"pq": pq}}


runs = [
    {"generator": "oracle", "ratio": 0.2, "stats": st(0.9, 6.0)},
    {"generator": "oracle", "ratio": 0.2, "stats": st(0.8, 6.4)},   # 2 items at ρ0.2
    {"generator": "oracle", "ratio": 0.6, "stats": st(0.7, 6.2)},
    {"generator": "passthrough", "ratio": 0.2, "stats": st(0.3, 4.0)},
    {"generator": "passthrough", "ratio": 0.6, "stats": st(0.1, 3.5)},
]
board = br.build_scoreboard(runs)
check("both generators present", set(board) == {"oracle", "passthrough"})
check("oracle ratios ordered", board["oracle"]["ratios"] == [0.2, 0.6])
check("oracle n per ratio", board["oracle"]["n"] == [2, 1])
check("oracle f1 curve averages the ρ0.2 cell", board["oracle"]["correctness"]["f1"] == [0.85, 0.7],
      str(board["oracle"]["correctness"]))
check("oracle pq curve", board["oracle"]["naturalness"]["pq"] == [6.2, 6.2], str(board["oracle"]["naturalness"]))
check("passthrough scores below oracle (bracket)",
      board["passthrough"]["correctness"]["f1"][0] < board["oracle"]["correctness"]["f1"][0])

# ── run_item wiring (injected deps → no audio) ──
item = {"id": "nus-ADIZ-01", "clean_vocal": "/x/clean.wav",
        "words": [{"word": "edelweiss", "start": 0.0, "end": 1.0}, {"word": "morning", "start": 1.0, "end": 2.0}]}
captured = {}


def fake_mumble(clean, words, ratio, out, seed=0):
    captured["mumble"] = (clean, ratio, seed, len(words))
    open(out, "w").write("")     # produce the file the generator copies


def fake_score(clean, gen, true_words=None):
    captured["score"] = {"clean": clean, "gen": gen, "true_words": true_words}
    return st(0.5, 5.0)


with tempfile.TemporaryDirectory() as td:
    # a real clean file so gen_oracle's copy works
    clean = os.path.join(td, "clean.wav"); open(clean, "w").write("CLEAN")
    it2 = dict(item, clean_vocal=clean)
    r = br.run_item(it2, 0.4, "oracle", td, seed=7, deps={"mumble": fake_mumble, "score": fake_score})
    check("run_item returns item/ratio/generator", r["item"] == "nus-ADIZ-01" and r["ratio"] == 0.4 and r["generator"] == "oracle")
    check("mumble got the words + seed", captured["mumble"] == (clean, 0.4, 7, 2), str(captured["mumble"]))
    check("oracle generated == clean copy", open(r["generated"]).read() == "CLEAN")
    check("score got only alpha true_words", captured["score"]["true_words"] == ["edelweiss", "morning"])
    check("run_item carries stats", r["stats"]["correctness"]["onsets"]["f1"] == 0.5)

check("gen_pipeline is gated (raises)",
      _raises(lambda: br.gen_pipeline("m", "c", "o")))

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
