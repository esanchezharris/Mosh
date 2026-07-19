#!/usr/bin/env python3
"""Golden tests for taste feature-family row builders (charter Q1).

Only the hermetic families are golden-tested: `audiobox` (axes already sitting in
render manifests — zero model cost) and `fake` (a deterministic bytes-hash embedding
that proves the batch->probe->table pipeline with no venv). The heavy families
(clap/mert/tunejury) run through the same row shape via taste_cli.py under the eval
venv and are exercised by the real table run, not the golden — the real-model gating
posture used repo-wide.

Run:  python3 service/taste/taste_features_test.py   (exit 0 = pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from taste import features  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


LABELS = [
    {"ts": 10, "verdict": "accept", "wav": None, "axes": {"CE": 5.0, "CU": 6.0, "PC": 2.0, "PQ": 7.0}},
    {"ts": 20, "verdict": "reject", "wav": None, "axes": {"CE": 3.0, "CU": 5.5, "PC": 2.5, "PQ": 6.0}},
    {"ts": 30, "verdict": "accept", "wav": None, "axes": None},  # no axes -> dropped
]

rows = features.audiobox_rows(LABELS)
check("audiobox: rows only where axes exist", len(rows) == 2)
check("audiobox: y from verdict", rows[0]["y"] == 1 and rows[1]["y"] == 0)
check("audiobox: stable axis order CE,CU,PC,PQ",
      rows[0]["x"] == [5.0, 6.0, 2.0, 7.0], str(rows[0]["x"]))
check("audiobox: ts carried for the temporal split", rows[0]["ts"] == 10)

with tempfile.TemporaryDirectory() as td:
    wav_a = os.path.join(td, "a.wav")
    wav_b = os.path.join(td, "b.wav")
    open(wav_a, "wb").write(b"RIFFxxxxWAVEdata" + b"\x01\x02" * 64)
    open(wav_b, "wb").write(b"RIFFxxxxWAVEdata" + b"\x03\x04" * 64)
    labs = [
        {"ts": 1, "verdict": "accept", "wav": wav_a, "axes": None},
        {"ts": 2, "verdict": "reject", "wav": wav_b, "axes": None},
        {"ts": 3, "verdict": "reject", "wav": os.path.join(td, "missing.wav"), "axes": None},
    ]
    frows = features.fake_rows(labs, dim=6)
    check("fake: rows only where the wav exists", len(frows) == 2)
    check("fake: fixed dim", all(len(r["x"]) == 6 for r in frows))
    check("fake: deterministic per content",
          json.dumps(features.fake_rows(labs, dim=6)) == json.dumps(frows))
    check("fake: different audio -> different embedding", frows[0]["x"] != frows[1]["x"])

    # embed_rows adapts a {path: vector} map (what taste_cli emits) into probe rows.
    emb = {wav_a: [0.1, 0.2], wav_b: [0.3, 0.4]}
    erows = features.embed_rows(labs, emb)
    check("embed_rows: joins by wav path, keeps ts/y", len(erows) == 2
          and erows[0]["x"] == [0.1, 0.2] and erows[1]["y"] == 0)

print()
if fails:
    print(f"FAILED: {len(fails)} — {fails}")
    sys.exit(1)
print("taste_features_test: ALL PASS")
