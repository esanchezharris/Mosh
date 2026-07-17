#!/usr/bin/env python3
"""Golden tests for the mumble synthesizer's PURE word-selection core (stdlib, no audio).

The DSP `degrade()` is validated separately by a real mumble_probe smoke (recorded in the
increment-2 verdict), not here — this pins the deterministic, function-word-biased selection.

Run:  python3 scripts/fms-killshot/bench_mumble_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_mumble as bm  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def w(word, t):
    return {"word": word, "start": float(t), "end": float(t) + 0.4}


# a line mixing function words (the/and/a/of) with content words
WORDS = [w("Time", 0.0), w("flips", 0.5), w("the", 1.0), w("summer", 1.5), w("of", 2.0),
         w("roads", 2.5), w("and", 3.0), w("memories", 3.5), w("a", 4.0), w("everywhere", 4.5)]

# ── ratio + bounds ──
check("ratio 0 → no words", bm.select_mumble_words(WORDS, 0.0) == [])
check("ratio 1 → all words", bm.select_mumble_words(WORDS, 1.0) == list(range(10)))
sel4 = bm.select_mumble_words(WORDS, 0.4)
check("ratio 0.4 of 10 → ceil = 4 words", len(sel4) == 4, str(sel4))
check("selection is time-sorted", sel4 == sorted(sel4))

# ── function-word bias: at ρ=0.4 the mumbled set is dominated by function words ──
func_idx = {i for i, x in enumerate(WORDS) if bm._norm(x["word"]) in bm.FUNCTION_WORDS}
picked_func = sum(1 for i in sel4 if i in func_idx)
check("low-ρ selection prefers function words", picked_func >= 3,
      f"{picked_func}/4 are function words (func idx {sorted(func_idx)}, picked {sel4})")
check("content word 'memories' not mumbled at ρ=0.4", 7 not in sel4, str(sel4))

# ── determinism (3x) + seed sensitivity ──
det = {hashlib.sha256(json.dumps(bm.select_mumble_words(WORDS, 0.5, seed=42)).encode()).hexdigest()
       for _ in range(3)}
check("selection deterministic (3x, seed 42)", len(det) == 1)
check("selection count is seed-invariant",
      len(bm.select_mumble_words(WORDS, 0.5, seed=1)) == len(bm.select_mumble_words(WORDS, 0.5, seed=2)))

# among EQUAL-priority words a different seed can reorder the tiebreak (count identical)
many = [w(f"word{i}", i * 0.5) for i in range(20)]      # all same priority (content, len>3)
s1 = bm.select_mumble_words(many, 0.5, seed=1)
s2 = bm.select_mumble_words(many, 0.5, seed=2)
check("seed changes tiebreak among equal-priority words", s1 != s2 and len(s1) == len(s2), f"{s1} vs {s2}")

# ── spans_for maps indices → (start,end) ──
sp = bm.spans_for(WORDS, [0, 2])
check("spans_for maps to (start,end)", sp == [(0.0, 0.4), (1.0, 1.4)], str(sp))

# ── priority ordering sanity ──
check("function word out-ranks content word", bm.mumble_priority("the") > bm.mumble_priority("memories"))
check("short word out-ranks long content word", bm.mumble_priority("cat") > bm.mumble_priority("elephant"))

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
