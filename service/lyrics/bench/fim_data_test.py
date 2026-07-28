#!/usr/bin/env python3
"""Guards for the FIM-LoRA triple miner (I4). Fixtures carry their failures.

Run:  python3 service/lyrics/bench/fim_data_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import arms, fim_data  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def item(n, split="train", target="grind", masked="i came up from the ____",
         song=None):
    return {"itemId": f"t:{n}", "granularity": "rhyme", "split": split,
            "songId": song or f"gs:{n}",
            "context": {"before": ["invented setup bar"],
                        "maskedLine": masked, "after": []},
            "target": {"text": target, "syllables": 1},
            "constraints": {"syllables": 1, "rhymeWith": "mind",
                            "rhymeStrictness": "slant"}}


ITEMS = [item(i) for i in range(6)]
m = fim_data.mint_triples(ITEMS, n_items=10)
check("mints a triple per drawn item with the serve-parity prompt shape",
      m["manifest"]["nItems"] == 6
      and all(t["completion"] == "grind\n" for t in m["triples"]),
      str(m["manifest"]))
_i, _p = arms._local_prompt(ITEMS[0])
check("instruction+prefill are BYTE-IDENTICAL to the local arms' serve prompt",
      m["triples"][0]["instruction"] == _i and m["triples"][0]["prefill"] == _p)
check("LEAKAGE rule: the truth appears nowhere in instruction or prefill",
      all("grind" not in t["instruction"] and "grind" not in t["prefill"]
          for t in m["triples"]))

# A leaky item — masked line already carries the answer — is refused + counted.
leaky = [item(50, masked="i came up from the grind ____")]
m2 = fim_data.mint_triples(leaky, n_items=5)
check("a truth-leaking prompt is REFUSED and counted, never minted",
      m2["manifest"]["nItems"] == 0 and m2["manifest"]["leakedRefused"] == 1,
      str(m2["manifest"]))

mixed = ITEMS + [item(60, split="dev"), item(61, split="golden")]
m3 = fim_data.mint_triples(mixed, n_items=10)
check("non-train splits refused and counted",
      m3["manifest"]["refusedSplit"] == 2)
m4 = fim_data.mint_triples(ITEMS, n_items=10, forbidden_ids={"t:1"},
                           forbidden_songs={"gs:2"})
check("forbidden ids/songs excluded; exclude-manifest sizes recorded",
      m4["manifest"]["refusedForbidden"] == 2
      and m4["manifest"]["excludeManifest"] == {"forbiddenIds": 1,
                                                "forbiddenSongs": 1},
      str(m4["manifest"]))
check("multi-word targets are skipped (end-word task only)",
      fim_data.mint_triples([item(70, target="the grind")],
                            n_items=5)["manifest"]["nItems"] == 0)
# v2 guard: a truth fused to a neighbor by punctuation is STILL a leak, and
# an unrelated superstring is NOT (no substring over-blocking).
fused = [item(80, masked="the grind-house taught me ____")]
check("punctuation-FUSED truth is refused (hyphen is a boundary, not deleted)",
      fim_data.mint_triples(fused, n_items=5)["manifest"]["leakedRefused"] == 1,
      str(fim_data.mint_triples(fused, n_items=5)["manifest"]))
superstr = [item(81, masked="i kept grinding for the ____")]
check("a superstring ('grinding') does NOT over-refuse the truth ('grind')",
      fim_data.mint_triples(superstr, n_items=5)["manifest"]["nItems"] == 1,
      str(fim_data.mint_triples(superstr, n_items=5)["manifest"]))

check("deterministic content sha",
      fim_data.mint_triples(ITEMS, n_items=10)["manifest"]["contentSha"]
      == m["manifest"]["contentSha"])

with tempfile.TemporaryDirectory() as td:
    man = fim_data.write(td, m)
    n = sum(1 for _ in open(os.path.join(td, "triples.jsonl"), encoding="utf-8"))
    check("write round-trips", n == man["nItems"]
          and os.path.exists(os.path.join(td, "manifest.json")))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
