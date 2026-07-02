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
                   "stars": r.get("stars") or None,
                   # pack-004+: the forced 'which would you open in the DAW' choice —
                   # the strongest single label per pack (topPick > keep > kill)
                   "topPick": r.get("top") == "1",
                   "notes": (r.get("notes") or "").strip()}
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
    priors = build_source_priors(rows)
    pfile = OUT.parent / "source_priors.json"
    with open(pfile, "w") as f:
        json.dump({"version": 1, "rows": len(rows), "priors": priors}, f, indent=1)
    print(f"source priors: {len(priors)} sources (n≥3) → {pfile}")
    return 0


def build_source_priors(rows: list) -> dict:
    """Per-source keep-rate prior from the pack keep/kill rows — the gentle retrieval
    nudge (±1.0 vs the mood scorer's +3.0: reorders within a band, never bans). A beat
    using a source in ANY group counts once. Laplace-smoothed, emitted only at n≥3
    (pack-003 forensics: seed_dark_trap backbone 1/7, lofi_trap drums 0/3,
    melodic_trap 5/5 — stark records worth a nudge, not a rule)."""
    per: dict = {}
    for r in rows:
        if r.get("kind") != "keep" or r.get("value") not in ("keep", "kill"):
            continue
        feats = r.get("features") or {}
        srcs = set((feats.get("sources") or {}).values())
        if feats.get("backbone"):
            srcs.add(feats["backbone"])
        for s in srcs:
            st = per.setdefault(s, {"n": 0, "keeps": 0})
            st["n"] += 1
            st["keeps"] += 1 if r["value"] == "keep" else 0
    out = {}
    for s, st in sorted(per.items()):
        if st["n"] < 3:
            continue
        prior = max(-1.0, min(1.0, 2.0 * ((st["keeps"] + 1) / (st["n"] + 2) - 0.5)))
        out[s] = {"n": st["n"], "keeps": st["keeps"], "prior": round(prior, 4)}
    return out


if __name__ == "__main__":
    raise SystemExit(main())
