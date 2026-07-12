#!/usr/bin/env python3
"""Golden tests for ground-truth annotation persistence (annotator round, 2026-07-12).

The owner marks syllable onsets over the take's waveform; the tool POSTs them and the
server writes back-half/ground-truth.json — the hand-certified grid everything else
calibrates against. Mirrors the verdict-save pattern (validate -> atomic write).

Run:  python3 scripts/fms-killshot/annotate_persist_test.py   (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from asserted_proof_verdict import (MAX_ANNOTATION_ONSETS, save_annotations,  # noqa: E402
                                    validate_annotations)

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


GOOD = {"take": "source-backhalf-48k.wav", "takeS": 56.5,
        "createdAt": "2026-07-12T00:00:00Z",
        "phrases": {"0": [0.12, 0.34], "1": [1.0, 1.5, 2.0]},
        "done": {"0": True}}


# ── 1. a valid payload writes to disk atomically and round-trips ──────────────────────
with tempfile.TemporaryDirectory() as d:
    dest = Path(d) / "ground-truth.json"
    save_annotations(GOOD, dest)
    check("valid annotations write to disk", dest.is_file())
    back = json.loads(dest.read_text())
    check("round-trips the per-phrase onsets", back["phrases"]["1"] == [1.0, 1.5, 2.0])
    check("atomic write leaves no .tmp behind", not (Path(d) / "ground-truth.json.tmp").exists())


# ── 2. validation rejects bad shapes ───────────────────────────────────────────────────
def rejects(name, payload):
    try:
        validate_annotations(payload)
        check(name, False, "did not raise")
    except RuntimeError:
        check(name, True)


rejects("non-dict payload", [1, 2, 3])
rejects("phrases not a dict", {**GOOD, "phrases": [1, 2]})
rejects("an onset time out of range", {**GOOD, "phrases": {"0": [999999.0]}})
rejects("a negative onset time", {**GOOD, "phrases": {"0": [-0.5]}})
rejects("a non-finite onset time", {**GOOD, "phrases": {"0": [float("inf")]}})
rejects("a non-numeric onset time", {**GOOD, "phrases": {"0": ["x"]}})
rejects("a non-list phrase entry", {**GOOD, "phrases": {"0": 0.3}})
rejects("missing createdAt", {k: v for k, v in GOOD.items() if k != "createdAt"})
rejects("too many onsets total",
        {**GOOD, "phrases": {"0": [0.1] * (MAX_ANNOTATION_ONSETS + 1)}})

check("a valid payload does NOT raise", validate_annotations(GOOD) is None
      or True)   # returns None on success


# ── 2b. word strikes (truth v2): struck ASR words persist with the marks ──────────────
STRUCK = {**GOOD, "struck": {"balls@29.11": True, "berry@28.90": True}}
with tempfile.TemporaryDirectory() as d:
    dest = Path(d) / "gt.json"
    save_annotations(STRUCK, dest)
    check("struck words round-trip", json.loads(dest.read_text())["struck"]["balls@29.11"] is True)
rejects("struck not a dict", {**GOOD, "struck": ["balls"]})
rejects("struck key too long", {**GOOD, "struck": {"x" * 80: True}})
rejects("too many strikes", {**GOOD, "struck": {f"w{i}@1.0": True for i in range(600)}})


# ── 3. an empty grid (all markers cleared) is a legal save ────────────────────────────
with tempfile.TemporaryDirectory() as d:
    dest = Path(d) / "ground-truth.json"
    save_annotations({**GOOD, "phrases": {}, "done": {}}, dest)
    check("an empty annotation set is a legal save", dest.is_file())


# ── 4. determinism ─────────────────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as d:
    outs = set()
    for _ in range(3):
        dest = Path(d) / "gt.json"
        save_annotations(GOOD, dest)
        outs.add(dest.read_text())
    check("save is deterministic (3x)", len(outs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
