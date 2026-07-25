#!/usr/bin/env python3
"""Golden tests for the eval-item schema + the FROZEN item golden (FMS lyrics-bench I1).

Two load-bearing layers:
  1. expected_items_v1.jsonl is the frozen output of mask over the fixture corpus —
     regenerating must be byte-identical. ANY drift in the masking policy (stopword
     set, seed derivation, window rules) reds this golden, which is the point.
  2. schema.validate_item accepts every golden item and rejects targeted mutations.

Run:  python3 service/lyrics/bench/schema_test.py     (exit 0 = all pass)
"""
import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import mask, schema  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


with open(os.path.join(HERE, "fixtures", "synthetic_songs.jsonl"), encoding="utf-8") as f:
    SONGS = [json.loads(ln) for ln in f if ln.strip()]

PRON = make_pron()
FREQ = mask.build_freq_table(SONGS)
regen = [i for s in SONGS for i in mask.items_for_song(s, PRON, FREQ)]

golden_path = os.path.join(HERE, "fixtures", "expected_items_v1.jsonl")
with open(golden_path, encoding="utf-8") as f:
    frozen = [json.loads(ln) for ln in f if ln.strip()]

check("frozen golden: regeneration is byte-identical (masking policy pinned)",
      regen == frozen, f"regen={len(regen)} frozen={len(frozen)}")
check("frozen golden: non-trivial size", len(frozen) >= 80, str(len(frozen)))

# ---- validator accepts every golden item ----
probs = [(i["itemId"], schema.validate_item(i)) for i in frozen]
bad = [(iid, p) for iid, p in probs if p]
check("validate_item: all golden items accepted", not bad, str(bad[:3]))

# ---- validator rejects targeted mutations ----
base = copy.deepcopy(frozen[0])


def mutated(**kw):
    m = copy.deepcopy(base)
    for k, v in kw.items():
        parent, _, leaf = k.partition(".")
        if leaf:
            m[parent][leaf] = v
        else:
            m[parent] = v
    return m


def dropped(key):
    m = copy.deepcopy(base)
    del m[key]
    return m


# Mutation asserts name the SPECIFIC problem — bool(problems) alone would stay
# green if the targeted validator were deleted but another check happened to
# fire on the mutated item (review finding #10).
check("rejects: missing target",
      any("target" in p for p in schema.validate_item(dropped("target"))))
check("rejects: unknown granularity",
      any("granularity" in p for p in
          schema.validate_item(mutated(granularity="stanza"))))
check("rejects: inverted tokenSpan",
      any("tokenSpan" in p for p in schema.validate_item(
          mutated(granularity="span", **{"target.tokenSpan": [3, 1]}))))

# Substring matching would falsely reject 'old' visible inside 'hold' — the
# visibility check must be token-based (review finding #5).
tricky = copy.deepcopy(next(i for i in frozen if i["granularity"] == "word"))
tricky["context"]["maskedLine"] = "hold the ____ down for the winter"
tricky["target"] = {**tricky["target"], "text": "old", "tokenIndex": 2,
                    "syllables": 1, "stress": "X",
                    "phones": ["OW1", "L", "D"], "phonesSource": "lexicon"}
check("accepts: target 'old' with 'hold' visible (token-based visibility)",
      schema.validate_item(tricky) == [], str(schema.validate_item(tricky)))
leak = copy.deepcopy(tricky)
leak["context"]["maskedLine"] = "old habits ____ for the winter"
check("rejects: target token actually visible in maskedLine",
      any("visible" in p for p in schema.validate_item(leak)),
      str(schema.validate_item(leak)))
line_item = next(i for i in frozen if i["granularity"] == "line")
check("rejects: line item with a maskedLine", bool(schema.validate_item(
    {**copy.deepcopy(line_item),
     "context": {**line_item["context"], "maskedLine": "should be None"}})))
word_item = next(i for i in frozen if i["granularity"] == "word")
noblank = copy.deepcopy(word_item)
noblank["context"]["maskedLine"] = noblank["context"]["maskedLine"].replace("____", "gone")
check("rejects: word item without a blank", bool(schema.validate_item(noblank)))
rhyme_item = next(i for i in frozen if i["granularity"] == "rhyme")
norw = copy.deepcopy(rhyme_item)
norw["constraints"]["rhymeWith"] = None
check("rejects: rhyme item without rhymeWith", bool(schema.validate_item(norw)))
check("rejects: bad licenseTier", bool(schema.validate_item(
    mutated(licenseTier="whatever"))))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
