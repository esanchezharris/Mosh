#!/usr/bin/env python3
"""Backfill Audiobox aesthetic axes (PQ/CE/CU/PC) onto already-rendered beats.

Pack-001 shipped with zero axes attached (the factory took the sidecar's
@@MOSH@@{"ready":true} handshake as the payload — fixed in beat_factory.py).
This one-shot repair:
  1. scores every WAV referenced by <pack>/candidates.jsonl + pack.json and
     rewrites both files with an "axes" field per row;
  2. scores the historical audition-round WAVs (owner-dna*) into
     ~/mosh-beats/labels/axes-backfill.json (file-basename → axes) for the
     evaluator bench's transfer checks;
  3. re-runs merge_labels.py so ledger rows regain features.axes.

    python3 scripts/verify-hardware/backfill_axes.py [--pack ~/mosh-beats/pack-001]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from beat_factory import audiobox_axes  # noqa: E402

BEATS = os.path.expanduser("~/mosh-beats")
OLD_ROUND_DIRS = ["owner-dna/v1", "owner-dna", "owner-dna-v3", "owner-dna-v4"]


def _score(paths: list) -> dict:
    paths = [p for p in paths if os.path.isfile(p)]
    if not paths:
        return {}
    return audiobox_axes(paths)


def backfill_pack(pack_dir: str) -> int:
    cand_path = os.path.join(pack_dir, "candidates.jsonl")
    pack_path = os.path.join(pack_dir, "pack.json")
    rows = [json.loads(l) for l in open(cand_path)] if os.path.isfile(cand_path) else []
    pack = json.load(open(pack_path)) if os.path.isfile(pack_path) else []
    wavs = sorted({r["file"] for r in rows + pack if r.get("file")})
    axes = _score(wavs)
    if not axes:
        print("no axes returned — nothing rewritten", file=sys.stderr)
        return 1
    attached = 0
    for r in rows + pack:
        ax = axes.get(r.get("file"))
        if ax:
            r["axes"] = ax
            attached += 1
    with open(cand_path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    with open(pack_path, "w") as f:
        json.dump(pack, f, indent=1)
    print(f"pack backfill: {len(axes)}/{len(wavs)} wavs scored, "
          f"{attached} rows updated in {os.path.basename(pack_dir)}")
    return 0


def backfill_old_rounds() -> None:
    wavs = []
    for d in OLD_ROUND_DIRS:
        full = os.path.join(BEATS, d)
        if os.path.isdir(full):
            wavs += [os.path.join(full, f) for f in sorted(os.listdir(full))
                     if f.endswith(".wav") and " 2" not in f]
    axes = _score(wavs)
    # keyed by round-dir/basename: the same filename recurs across A/B rounds
    out = {os.path.relpath(p, BEATS): ax for p, ax in axes.items()
           for ax in [axes[p]]}
    dest = os.path.join(BEATS, "labels", "axes-backfill.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    json.dump(out, open(dest, "w"), indent=1)
    print(f"old rounds: {len(out)}/{len(wavs)} wavs scored → {dest}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=os.path.join(BEATS, "pack-001"))
    args = ap.parse_args(argv)
    rc = backfill_pack(os.path.expanduser(args.pack))
    backfill_old_rounds()
    if rc == 0:
        subprocess.run([sys.executable, os.path.join(HERE, "merge_labels.py")], check=True)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
