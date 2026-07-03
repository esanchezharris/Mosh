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


def load_annotations() -> dict:
    """(round, file) → [late notes] from labels/annotations.jsonl — the owner's
    after-the-CSV thoughts (e.g. pack-004 #14: 'I love it, but it isn't exactly dark
    or menacing'). Merged into ledger rows as lateNotes; the journal shows them."""
    path = BEATS / "labels" / "annotations.jsonl"
    out: dict = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            a = json.loads(line)
            out.setdefault((a.get("round"), a.get("file")), []).append(a.get("note", ""))
    return out


def pack_sources():
    """Any TASTE-PACK CSV dropped beside a pack dir: pack-*/RATINGS*.csv → keep/kill rows."""
    out = []
    for d in sorted(BEATS.glob("pack-*")):
        for c in sorted(d.glob("RATINGS*.csv")):
            out.append((d.name, c))
    return out


def pair_sources():
    """Pairwise bonus-round CSVs (schema pre-registered era-0; UI ships boundary-2):
    pack-*/PAIRS*.csv with columns file_a,file_b,winner → kind='packpair' rows.
    CONSUMER CONTRACT: everything that counts keep/kill (bench, ranker, journal
    stats) filters kind=='keep' — packpair rows are ordinal data for the ranker's
    pairwise loss only."""
    out = []
    for d in sorted(BEATS.glob("pack-*")):
        for c in sorted(d.glob("PAIRS*.csv")):
            out.append((d.name, c))
    return out


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    annotations = load_annotations()
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
            raw_chips = (r.get("chips") or "").split("+") if r.get("chips") else []
            row = {"round": pack, "file": r.get("file"), "kind": "keep",
                   "value": r.get("verdict"),
                   # CSV v2 (era-0): a chip prefixed '*' is a STAR — "this element is
                   # why I kept it" — split out so bench chip-AUCs keep their DEFECT
                   # semantics. No historical CSV contains '*' (verified), so old
                   # ledgers stay byte-identical.
                   "chips": [c for c in raw_chips if not c.startswith("*")],
                   "stars": r.get("stars") or None,
                   # pack-004+: the forced 'which would you open in the DAW' choice —
                   # the strongest single label per pack (topPick > keep > kill)
                   "topPick": r.get("top") == "1",
                   "notes": (r.get("notes") or "").strip()}
            star = [c[1:] for c in raw_chips if c.startswith("*")]
            if star:
                row["starChips"] = star
            # CSV v2: idea/mix split verdict — empty means "inherits the verdict",
            # so only explicit divergence lands in the ledger.
            for k in ("idea", "mix"):
                if r.get(k):
                    row[k] = r[k]
            late = annotations.get((pack, r.get("file")))
            if late:
                row["lateNotes"] = late
            f = feats.get(r.get("file"))
            if f:
                row["features"] = {k: f.get(k) for k in
                                   ("request", "seed", "backbone", "sources", "samples",
                                    "density", "gate", "balance", "axes", "rmsDb",
                                    "fx", "priors", "priorsHash", "filters", "drumRoles",
                                    "distinct", "subOverlap", "tailEnergyDb",
                                    "audibility808", "measuredKey", "form", "predictedKeep",
                                    "simTopPick", "soundsLike", "moreLike", "rankerMode",
                                    "topPickAnchor", "nearestTopPick", "simNearestTopPick",
                                    "sectionTailOnsets", "strikesHash")
                                   if f.get(k) is not None}
            rows.append(row)
    for pack, path in pair_sources():
        for r in csv.DictReader(open(path)):
            if r.get("file_a") and r.get("file_b"):
                rows.append({"round": pack, "kind": "packpair",
                             "fileA": r["file_a"], "fileB": r["file_b"],
                             "winner": r.get("winner") or ""})
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
    strikes = build_element_strikes(rows)
    sfile = OUT.parent / "element_strikes.json"
    with open(sfile, "w") as f:
        json.dump({"version": 1, "rows": len(rows), "strikes": strikes}, f, indent=1)
    print(f"element strikes: {sum(len(v) for v in strikes.values())} sources (≥2 key-chip"
          f" strikes) → {sfile}")
    return 0


def build_element_strikes(rows: list) -> dict:
    """Per-(group, source) counts of KEY-CHIPPED rated beats → sources with ≥2
    strikes, by group. The S2 recurrence damper (owner, pack-005 #05: "STILL the
    wrong note in the melody" — the same lead recipe drew key chips in two packs):
    generate.py's lead pick excludes struck sources (relaxing rather than emptying).
    Counts CHIPS not kills — both confirmed offenders were keeps-with-key-chip; the
    chip is the owner flagging the defect regardless of verdict. Beat-level labels
    can't attribute WHICH element earned the chip, which is exactly why this is a
    per-group pool nudge and never a global ban."""
    per: dict = {}
    for r in rows:
        if r.get("kind") != "keep" or "key" not in (r.get("chips") or []):
            continue
        for group, src in ((r.get("features") or {}).get("sources") or {}).items():
            per.setdefault(group, {})
            per[group][src] = per[group].get(src, 0) + 1
    return {g: {s: n for s, n in srcs.items() if n >= 2}
            for g, srcs in per.items() if any(n >= 2 for n in srcs.values())}


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
