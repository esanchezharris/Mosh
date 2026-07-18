#!/usr/bin/env python3
"""Golden tests for the own-voice pairs normalizer (pure naming/pairing; no audio, no venv).

Run:  python3 scripts/fms-killshot/bench_own_pairs_test.py   (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_dataset as bd  # noqa: E402
import bench_own_pairs as op  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── role classification: "<song> <role>.<ext>" ──────────────────────────────────────────
check("classify: 'real' is the finished take", op.classify("LookinBack real.aif") == ("LookinBack", "finished"))
check("classify: role is case-insensitive", op.classify("stage9orsum Real.aif") == ("stage9orsum", "finished"))
check("classify: 'mumble' is the draft", op.classify("LookinBack mumble.aif") == ("LookinBack", "mumble"))
check("classify: 'raw' is also the draft", op.classify("stage10 raw.aif") == ("stage10", "mumble"))
check("classify: song names keep inner spaces",
      op.classify("My Long Song real.aif") == ("My Long Song", "finished"))
check("classify: unknown role → no role", op.classify("LookinBack stems.aif")[1] is None)
check("classify: non-audio extension is rejected (Ableton .asd sidecars)",
      op.classify("LookinBack real.aif.asd")[1] is None)
check("classify: wav is accepted too", op.classify("x mumble.wav") == ("x", "mumble"))

# ── pairing ─────────────────────────────────────────────────────────────────────────────
NAMES = ["LookinBack real.aif", "LookinBack mumble.aif", "LookinBack real.aif.asd",
         "stage9orsum Real.aif", "stage9orsum raw.aif",
         "stage10 Real.aif", "stage10 raw.aif"]
pairs = op.pair_files(NAMES)
check("pairs: finds all 3 songs", len(pairs) == 3, str([p["song"] for p in pairs]))
check("pairs: sorted by song (deterministic)",
      [p["song"] for p in pairs] == sorted(p["song"] for p in pairs))
lb = [p for p in pairs if p["song"] == "LookinBack"][0]
check("pairs: routes each take to its role",
      lb["finished"] == "LookinBack real.aif" and lb["mumble"] == "LookinBack mumble.aif")
check("pairs: .asd sidecar never becomes a take",
      not any(".asd" in v for p in pairs for v in (p["mumble"], p["finished"])))
check("pairs: an unpaired take is dropped (no half-items)",
      op.pair_files(["solo mumble.aif"]) == [])
check("pairs: a song needs BOTH takes",
      len(op.pair_files(["a mumble.aif", "a real.aif", "b mumble.aif"])) == 1)

# ── item assembly ───────────────────────────────────────────────────────────────────────
WORDS = [{"word": "we", "start": 0.10, "end": 0.35}, {"word": "been", "start": 0.35, "end": 0.62}]
item = op.pair_item("LookinBack", "/d/LookinBack.mumble.wav", "/d/LookinBack.finished.wav", WORDS)
check("item id is namespaced", item["id"] == "own-LookinBack")
check("item: clean_vocal is the FINISHED take (the reference/ground truth)",
      item["clean_vocal"] == "/d/LookinBack.finished.wav")
check("item: mumble_vocal is the REAL mumble (the input)",
      item["mumble_vocal"] == "/d/LookinBack.mumble.wav")
check("item carries the ground-truth words", item["words"] == WORDS)
check("item is train-ok (owner's own voice + lyrics)", item["license_tier"] == "train-ok")
check("item exposes train_ok flag", item["train_ok"] is True)

# the field that makes the runner branch: NUS items must NOT have it, own-pairs must.
check("mumble_vocal is the discriminating field vs NUS items", "mumble_vocal" in item)

# ── registry ────────────────────────────────────────────────────────────────────────────
check("registry: own-pairs registered", "own-pairs" in bd.REGISTRY)
check("registry: own-pairs IS train_ok", bd.REGISTRY["own-pairs"]["train_ok"] is True)
check("license_tier helper agrees", bd.license_tier("own-pairs") == "train-ok")
check("registry: nus-48e still eval-only (unchanged)", bd.license_tier("nus-48e") == "eval-only")

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
