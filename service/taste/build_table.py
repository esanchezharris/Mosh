#!/usr/bin/env python3
"""Build the charter's AUC correlation table (Q1 — the week-1 deliverable).

Pipeline: census(session dir) -> usable labels (organic, non-contradicted, render
still on disk) -> per-feature-family probe rows -> temporal-split logistic probe ->
one table (markdown + JSON). Per-family statuses are honest: `ok` (AUC reported),
`insufficient_labels` (a class missing on either side of the temporal split),
`unavailable (<reason>)` (embedding backend not installed / failed).

Usage:
  python3 service/taste/build_table.py \
      --session ~/Library/Mosh/session \
      --families audiobox,fake,clap,mert,tunejury \
      --md /tmp/table.md --json /tmp/table.json

INTERNAL EVAL ONLY — see __init__.py (CC-BY-NC backends never ship in-product).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from taste import census, features, probe  # noqa: E402

HEAVY_FAMILIES = ("clap", "mert", "tunejury")


def usable_labels(session_dir):
    """The rows a probe may legitimately train on: organic (a human listened),
    non-contradicted (the label means something), joined to an on-disk render."""
    boots = census.parse_boots(os.path.join(session_dir, "mosh-log.jsonl"))
    joined = census.join_renders(session_dir, census.label_rows(boots))
    return [r for r in joined if not r["scripted"] and not r["contradicted"]]


def family_rows(family, labels):
    if family == "audiobox":
        return features.audiobox_rows(labels)
    if family == "fake":
        return features.fake_rows(labels)
    if family in HEAVY_FAMILIES:
        paths = sorted({r["wav"] for r in labels if r.get("wav")})
        emb = features.cli_embed(family, paths)
        return features.embed_rows(labels, emb)
    raise ValueError(f"unknown family: {family}")


def score_families(rows_by_family, eval_frac=0.25):
    out = []
    for family in rows_by_family:
        rows = rows_by_family[family]
        if isinstance(rows, str):                      # an unavailability reason
            out.append({"family": family, "status": f"unavailable ({rows})",
                        "n": 0, "n_train": 0, "n_eval": 0, "auc": None,
                        "clears_trust_bar": False})
            continue
        res = probe.evaluate(rows, eval_frac=eval_frac)
        out.append({"family": family, **res})
    return out


def build_report(session_dir, families=("audiobox", "fake"), eval_frac=0.25):
    labels = usable_labels(session_dir)
    rows_by_family = {}
    for family in families:
        try:
            rows_by_family[family] = family_rows(family, labels)
        except Exception as e:  # noqa: BLE001 — an absent backend is a status, not a crash
            rows_by_family[family] = str(e)
    return {
        "session_dir": session_dir,
        "eval_frac": eval_frac,
        "census": census.summarize(session_dir),
        "usable_labels": len(labels),
        "families": score_families(rows_by_family, eval_frac=eval_frac),
    }


def render_markdown(report):
    lines = [
        "| family | n | train/eval | temporal AUC | ≥0.7? | status |",
        "|---|---|---|---|---|---|",
    ]
    for f in report["families"]:
        aucs = "—" if f["auc"] is None else f"{f['auc']}"
        bar = "**yes**" if f.get("clears_trust_bar") else "no"
        lines.append(f"| {f['family']} | {f.get('n', 0)} | "
                     f"{f.get('n_train', 0)}/{f.get('n_eval', 0)} | {aucs} | "
                     f"{bar if f['auc'] is not None else '—'} | {f['status']} |")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default=os.path.expanduser("~/Library/Mosh/session"))
    ap.add_argument("--families", default="audiobox,fake")
    ap.add_argument("--eval-frac", type=float, default=0.25)
    ap.add_argument("--md", default=None)
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args(argv)
    report = build_report(args.session,
                          families=tuple(x for x in args.families.split(",") if x),
                          eval_frac=args.eval_frac)
    md = render_markdown(report)
    if args.md:
        open(args.md, "w").write(md + "\n")
    if args.json_out:
        open(args.json_out, "w").write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report["census"], indent=2, sort_keys=True))
    print(f"usable labels: {report['usable_labels']}")
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
