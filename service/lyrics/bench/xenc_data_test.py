#!/usr/bin/env python3
"""Guards for the M6 training-pair miner. Every fixture carries its failure.

Run:  python3 service/lyrics/bench/xenc_data_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import arms, xenc_data  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


PRON = make_pron()
FREQ = {"train": 90, "chain": 70, "pane": 40, "pain": 12, "grind": 8,
        "blind": 6, "lined": 4, "mine": 3, "shine": 2, "line": 1, "sign": 1}


def item(n, split="train", target="pain", partner="rain", song=None):
    return {"itemId": f"t:{n}", "granularity": "rhyme", "split": split,
            "songId": song or f"gs:{n}",
            "context": {"before": [f"invented bar {n}"],
                        "maskedLine": "this bar ends with ____", "after": []},
            "target": {"text": target, "syllables": 1},
            "constraints": {"syllables": 1, "rhymeWith": partner,
                            "rhymeStrictness": "slant"}}


CTX = arms.ArmContext(pron=PRON, freq=FREQ, k=5)
ITEMS = [item(i) for i in range(8)] + [item(100, partner="mind", target="grind")]

m = xenc_data.mint_pairs(ITEMS, CTX, n_items=20, n_neg=4)
check("mints one triple per drawn item, each with n_neg negatives",
      m["manifest"]["nItems"] > 0
      and all(len(t["negatives"]) == 4 for t in m["triples"]),
      str(m["manifest"]))
check("TRUTH is never among the negatives",
      all("pain" not in " ".join(t["negatives"]) for t in m["triples"]
          if t["itemId"] != "t:100"),
      "a truth-completed line leaked into the negatives")
check("query keeps the blank a blank (truth-free)",
      all("____" in t["query"] and "pain" not in t["query"]
          for t in m["triples"] if t["itemId"] != "t:100"))
check("positive is the truth-completed line",
      all(t["positive"].endswith("pain") for t in m["triples"]
          if t["itemId"] != "t:100"))

# split guard: dev/golden items REFUSED and counted
mixed = ITEMS + [item(200, split="dev"), item(201, split="golden")]
m2 = xenc_data.mint_pairs(mixed, CTX, n_items=20, n_neg=4)
check("non-train items are refused and counted",
      m2["manifest"]["refusedSplit"] == 2
      and not any(t["itemId"] in ("t:200", "t:201") for t in m2["triples"]),
      str(m2["manifest"]))

# forbidden ids/songs guard (belt over the split braces)
m3 = xenc_data.mint_pairs(ITEMS, CTX, n_items=20, n_neg=4,
                          forbidden_ids={"t:1"}, forbidden_songs={"gs:2"})
check("forbidden ids AND songs are excluded and counted",
      m3["manifest"]["refusedForbidden"] == 2
      and not any(t["itemId"] in ("t:1", "t:2") for t in m3["triples"]),
      str(m3["manifest"]))

# determinism: same inputs + seed => byte-identical content sha
m4 = xenc_data.mint_pairs(ITEMS, CTX, n_items=20, n_neg=4)
check("deterministic: same seed reproduces the content sha",
      m4["manifest"]["contentSha"] == m["manifest"]["contentSha"])
m5 = xenc_data.mint_pairs(ITEMS, CTX, n_items=20, n_neg=4, seed=7)
check("a different seed changes the tail negatives (sha moves)",
      m5["manifest"]["contentSha"] != m["manifest"]["contentSha"])

# short-pool: an item whose pool cannot supply n_neg clean negatives is skipped.
# 'guap' is the testlex's one-word rime family — the menu excludes the partner
# itself, so the pool is EMPTY (the earlier 'scene' fixture still slant-matched
# four words; a short-pool fixture must actually be short).
tiny = [item(300, partner="guap", target="drip")]
m6 = xenc_data.mint_pairs(tiny, CTX, n_items=5, n_neg=4)
check("short-pool items are skipped and counted, never padded",
      m6["manifest"]["nItems"] == 0 and m6["manifest"]["shortPool"] == 1,
      str(m6["manifest"]))

# write round-trip
with tempfile.TemporaryDirectory() as td:
    man = xenc_data.write(td, m)
    lines = [json.loads(l) for l in open(os.path.join(td, "pairs.jsonl"),
                                         encoding="utf-8")]
    check("write: pairs.jsonl round-trips and manifest lands beside it",
          len(lines) == man["nItems"]
          and os.path.exists(os.path.join(td, "manifest.json")))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
