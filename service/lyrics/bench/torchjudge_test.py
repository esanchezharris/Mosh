#!/usr/bin/env python3
"""Golden tests for the torch-backed judges: embedding sim + MLM pseudo-perplexity
(FMS lyrics-bench I2).

Hermetic by construction: the heavy work lives in a SUBPROCESS behind
`torchjudge.run_backend`, which the tests replace with a scripted stub. What
must hold:
  - absent torch degrades to `unavailable` — never a fabricated 0.0 score that
    would silently enter calibration as data;
  - the interpreter/model actually used is RECORDED (reproducibility: a score
    means nothing without knowing which weights produced it);
  - scores are cached by content, so re-scoring is free and replayable;
  - the pure aggregation math is exact.

Run:  python3 service/lyrics/bench/torchjudge_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import llm_cache, torchjudge  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


ITEM = {
    "itemId": "v1:span:t:s0:l1", "granularity": "span",
    "context": {"before": ["a prior bar to set the scene"],
                "maskedLine": "I was ____ ____ the rent, no debate",
                "after": ["a following bar"]},
    "target": {"text": "counting up", "tokenSpan": [2, 4], "tokenIndex": None},
    "constraints": {"syllables": 3, "syllableTol": 1, "rhymeWith": None,
                    "rhymeStrictness": "slant", "lineSyllableTarget": None},
    "granularityOk": True,
}

# ---- interpreter resolution ----
with tempfile.TemporaryDirectory() as td:
    fake_py = os.path.join(td, "python")
    with open(fake_py, "w") as f:
        f.write("#!/bin/sh\nexit 0\n")
    os.chmod(fake_py, 0o755)
    os.environ["LYRICS_BENCH_TORCH_PY"] = fake_py
    try:
        check("resolver: honors LYRICS_BENCH_TORCH_PY when executable",
              torchjudge.resolve_python() == fake_py)
    finally:
        del os.environ["LYRICS_BENCH_TORCH_PY"]
    os.environ["LYRICS_BENCH_TORCH_PY"] = os.path.join(td, "nope")
    try:
        check("resolver: a bogus override does not silently win",
              torchjudge.resolve_python() != os.path.join(td, "nope"))
    finally:
        del os.environ["LYRICS_BENCH_TORCH_PY"]

# ---- unavailable degrades honestly ----
with tempfile.TemporaryDirectory() as td:
    out = torchjudge.score_pairs([(ITEM, "stacking all")], kind="emb",
                                 cache=llm_cache.Cache(td),
                                 run_backend=lambda *a, **k: {
                                     "ok": False, "error": "torch not installed"})
    check("absent backend → status unavailable, score None (never 0.0)",
          out["status"] == "unavailable" and out["scores"] == [None], str(out))
    check("unavailable carries the reason for the manifest",
          "torch" in (out.get("error") or ""), str(out.get("error")))

# ---- available path records provenance + caches ----
CALLS = {"n": 0}


def scripted(python, script, payload):
    CALLS["n"] += 1
    return {"ok": True, "backend": {"python": python, "model": "stub-model-v1"},
            "scores": [0.75 for _ in payload["pairs"]]}


with tempfile.TemporaryDirectory() as td:
    cache = llm_cache.Cache(td)
    pairs = [(ITEM, "stacking all"), (ITEM, "counting up")]
    out = torchjudge.score_pairs(pairs, kind="emb", cache=cache,
                                 run_backend=scripted)
    check("available: one score per pair", out["scores"] == [0.75, 0.75], str(out))
    check("available: backend provenance recorded (interpreter + model)",
          out["backend"]["model"] == "stub-model-v1" and out["backend"]["python"],
          str(out.get("backend")))
    first = CALLS["n"]
    out2 = torchjudge.score_pairs(pairs, kind="emb", cache=cache,
                                  run_backend=scripted)
    check("cache: identical pairs re-score with no new backend call",
          CALLS["n"] == first and out2["scores"] == out["scores"],
          f"{CALLS['n']} vs {first}")
    out3 = torchjudge.score_pairs([(ITEM, "different fill entirely")], kind="emb",
                                  cache=cache, run_backend=scripted)
    check("cache: a new fill DOES reach the backend", CALLS["n"] == first + 1)
    check("cache: kind is part of the key (emb vs ppl never collide)",
          torchjudge._pair_key(ITEM, "x", "emb") !=
          torchjudge._pair_key(ITEM, "x", "ppl"))

# ---- what the backend is asked to score: completed LINES, not bare fills ----
SEEN = {}


def capture(python, script, payload):
    SEEN.update(payload)
    return {"ok": True, "backend": {"python": python, "model": "m"},
            "scores": [0.5] * len(payload["pairs"])}


with tempfile.TemporaryDirectory() as td:
    torchjudge.score_pairs([(ITEM, "stacking all")], kind="emb",
                           cache=llm_cache.Cache(td), run_backend=capture)
    pair = SEEN["pairs"][0]
    check("backend receives the truth-filled and candidate-filled LINES",
          pair["truth"] == "I was counting up the rent, no debate"
          and pair["candidate"] == "I was stacking all the rent, no debate",
          str(pair))
    check("backend payload names the kind", SEEN.get("kind") == "emb")

# ---- ppl kind flows through the same seam ----
with tempfile.TemporaryDirectory() as td:
    out = torchjudge.score_pairs([(ITEM, "stacking all")], kind="ppl",
                                 cache=llm_cache.Cache(td),
                                 run_backend=lambda p, s, pay: {
                                     "ok": True, "backend": {"python": p, "model": "m"},
                                     "scores": [-1.25]})
    check("ppl: negative NLL delta flows through unchanged",
          out["scores"] == [-1.25] and out["status"] == "ok", str(out))

# ---- determinism ----
with tempfile.TemporaryDirectory() as td:
    runs = [torchjudge.score_pairs([(ITEM, "stacking all")], kind="emb",
                                   cache=llm_cache.Cache(td), run_backend=scripted)
            for _ in range(3)]
    check("determinism: 3x identical", runs[0] == runs[1] == runs[2])

# ---- BONUS layer: the real weights, opt-in (LYRICS_BENCH_TORCH_SMOKE=1).
# Kept out of the default gate because it needs torch + a model download; the
# same real-model gating posture SA3/whisper use. Asserts ORDERING, not values:
# a judge whose scores don't separate identical / plausible / nonsense is not a
# judge, whatever its absolute numbers are.
if os.environ.get("LYRICS_BENCH_TORCH_SMOKE") == "1":
    real_item = {
        "itemId": "smoke", "granularity": "line",
        "context": {"before": ["kept the pen on the paper through the winter"],
                    "maskedLine": None,
                    "after": ["now the story that I'm selling got a wide sole"]},
        "target": {"text": "turned the words in my notebook to a chain of gold"},
        "constraints": {},
    }
    trio = [(real_item, real_item["target"]["text"]),
            (real_item, "flipped the pages of the notebook to a bankroll"),
            (real_item, "the refrigerator hums a beige municipal form")]
    with tempfile.TemporaryDirectory() as td:
        e = torchjudge.score_pairs(trio, kind="emb", cache=llm_cache.Cache(td))
        check("REAL emb: identical > plausible > nonsense",
              e["status"] == "ok" and e["scores"][0] > e["scores"][1] > e["scores"][2],
              str(e["scores"]))
    with tempfile.TemporaryDirectory() as td:
        p = torchjudge.score_pairs(trio, kind="ppl", cache=llm_cache.Cache(td))
        check("REAL ppl: identical ~0 and nonsense clearly worse than plausible",
              p["status"] == "ok" and abs(p["scores"][0]) < 1e-6
              and p["scores"][2] > p["scores"][1],
              str(p["scores"]))
else:
    print("[note] real-weights smoke skipped "
          "(LYRICS_BENCH_TORCH_SMOKE=1 to run it)")

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
