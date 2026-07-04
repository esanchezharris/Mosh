#!/usr/bin/env python3
"""Curate a final SFT train/valid set from one or more buildSft output dirs.

The v2 dataset's "balancing" was ad-hoc and never committed (2026-07 audit
reproducibility gap). This script IS the committed recipe:

  python3 service/sft/curate_dataset.py \
      --in <dir-priority-1> --in <dir-priority-2> \
      --exclude-eval <frozen test.eval.jsonl> [--exclude-eval ...] \
      --cap populate=2500 --cap add_midi_clip=2500 --cap set_tempo=2000 \
      --cap set_time_signature=1500 --cap defer=250 \
      --out <out-dir>

- Rows are read train+valid from each --in dir (line-aligned *.meta.jsonl
  sidecars supply id/sourceId — built by ui/scripts/buildSft.mts).
- LEAKAGE FILTER: any row whose sourceId appears in ANY --exclude-eval file's
  ids is dropped from train/valid (train on a source that feeds a frozen eval
  and the eval stops measuring generalization).
- CLASS CAPS: rows are classified by their assistant commands (single command
  name / populate = all-add_note / defer = no commands / multi). Caps apply in
  --in priority order, so scarce classes from the first dirs survive.
- DEDUPE: exact (user, assistant) content duplicates collapse.

Outputs train.jsonl / valid.jsonl ({messages} rows, mlx-lm chat format) +
manifest.json with the full composition table.
"""

import argparse
import hashlib
import json
import os
from collections import Counter


def classify(assistant: str) -> str:
    try:
        o = json.loads(assistant)
    except Exception:
        return "unparseable"
    cmds = [c.get("command") for c in (o.get("commands") or [])]
    if not cmds:
        return "defer"
    if all(c == "add_note" for c in cmds):
        return "populate"
    names = set(cmds)
    return cmds[0] if len(names) == 1 and len(cmds) == 1 else ("multi" if len(names) > 1 else cmds[0])


def read_rows(d: str, split: str):
    rows_path = os.path.join(d, f"{split}.jsonl")
    meta_path = os.path.join(d, f"{split}.meta.jsonl")
    if not os.path.exists(rows_path):
        return
    metas = []
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            metas = [json.loads(l) for l in f if l.strip()]
    with open(rows_path) as f:
        for i, line in enumerate(f):
            if not line.strip():
                continue
            row = json.loads(line)
            meta = metas[i] if i < len(metas) else {}
            yield row, meta.get("sourceId", ""), meta.get("id", "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="ins", action="append", required=True)
    ap.add_argument("--exclude-eval", dest="excl", action="append", default=[])
    ap.add_argument("--cap", dest="caps", action="append", default=[])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    caps = {}
    for c in args.caps:
        k, v = c.split("=")
        caps[k] = int(v)

    excluded_sources = set()
    for p in args.excl:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                rid = json.loads(line).get("id", "")
                src = rid.split("#")[0]
                if src:
                    excluded_sources.add(src)

    os.makedirs(args.out, exist_ok=True)
    stats = {"read": 0, "leak_dropped": 0, "dupe_dropped": 0, "cap_dropped": 0}
    comp = Counter()
    seen = set()
    counts = Counter()
    out = {"train": [], "valid": []}

    for split in ("train", "valid"):
        for d in args.ins:
            for row, source, _rid in read_rows(d, split):
                stats["read"] += 1
                if source and source in excluded_sources:
                    stats["leak_dropped"] += 1
                    continue
                msgs = row.get("messages", [])
                user = next((m["content"] for m in msgs if m["role"] == "user"), "")
                assistant = next((m["content"] for m in msgs if m["role"] == "assistant"), "")
                h = hashlib.sha256((user + "\x00" + assistant).encode()).hexdigest()
                if h in seen:
                    stats["dupe_dropped"] += 1
                    continue
                seen.add(h)
                cls = classify(assistant)
                if split == "train" and cls in caps and counts[cls] >= caps[cls]:
                    stats["cap_dropped"] += 1
                    continue
                if split == "train":
                    counts[cls] += 1
                    comp[cls] += 1
                out[split].append(row)

    for split in ("train", "valid"):
        with open(os.path.join(args.out, f"{split}.jsonl"), "w") as f:
            for row in out[split]:
                f.write(json.dumps(row) + "\n")

    manifest = {
        "curatedFrom": args.ins,
        "excludeEvals": args.excl,
        "caps": caps,
        "counts": {"train": len(out["train"]), "valid": len(out["valid"])},
        "composition": dict(comp.most_common()),
        "stats": stats,
        "excludedSources": len(excluded_sources),
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
