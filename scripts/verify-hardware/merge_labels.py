#!/usr/bin/env python3
"""Merge every owner rating (audition rounds + taste packs) into ONE label ledger:
~/mosh-beats/labels/labels.jsonl — the taste ranker's training set and the benchmark
for external evaluators. Idempotent: rebuilds the ledger from the source CSVs each run.

    python3 scripts/verify-hardware/merge_labels.py
"""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path

BEATS = Path(os.path.expanduser("~/mosh-beats"))
OUT = BEATS / "labels" / "labels.jsonl"

# (round, csv path, kind, value column, extra columns)
SOURCES = [
    ("r1", BEATS / "owner-dna/v1/RATINGS-2026-07-02.csv", "star", "rating", ()),
    ("r2", BEATS / "owner-dna/RATINGS-V2-2026-07-02.csv", "star", "rating", ("subGate",)),
    ("r3ab", BEATS / "owner-dna-v3/RATINGS-R3-AB-2026-07-02.csv", "pref", "preference", ()),
    ("r4ab", BEATS / "owner-dna-v4/RATINGS-R4-AB-2026-07-02.csv", "pref", "preference", ()),
]


def pack_sources():
    """Any TASTE-PACK CSV dropped beside a pack dir: pack-*/RATINGS*.csv → keep/kill rows."""
    out = []
    for d in sorted(BEATS.glob("pack-*")):
        for c in sorted(d.glob("RATINGS*.csv")):
            out.append((d.name, c))
    return out


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for rnd, path, kind, col, extras in SOURCES:
        if not path.is_file():
            print(f"  (missing {path.name} — skipped)")
            continue
        for r in csv.DictReader(open(path)):
            rows.append({"round": rnd, "file": r.get("file"), "kind": kind,
                         "value": r.get(col), "notes": (r.get("notes") or "").strip(),
                         **{k: r.get(k) for k in extras if r.get(k)}})
    for pack, path in pack_sources():
        feats = {}
        pj = path.parent / "pack.json"
        if pj.is_file():
            feats = {c.get("pack_file"): c for c in json.load(open(pj))}
        for r in csv.DictReader(open(path)):
            row = {"round": pack, "file": r.get("file"), "kind": "keep",
                   "value": r.get("verdict"), "chips": (r.get("chips") or "").split("+") if r.get("chips") else [],
                   "stars": r.get("stars") or None, "notes": (r.get("notes") or "").strip()}
            f = feats.get(r.get("file"))
            if f:
                row["features"] = {k: f.get(k) for k in
                                   ("request", "seed", "backbone", "sources", "samples",
                                    "density", "gate", "balance", "axes", "rmsDb") if f.get(k) is not None}
            rows.append(row)
    with open(OUT, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    kinds = {}
    for r in rows:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    print(f"labels ledger: {len(rows)} rows → {OUT}  ({kinds})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
