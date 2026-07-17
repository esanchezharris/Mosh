#!/usr/bin/env python3
"""B1-lite lab arm builder — derive durations for the u2 back-half chunk scores.

Score-to-score transform (the V2 oracle-splice methodology): text / phoneme /
note_pitch / note_type stay byte-identical, only `duration` changes, chain-sum stays
exact on each chunk's `time` span. Chunks are derived independently — each carries its
own leading placement rest, so phrase-initial rest-steal behaves as in the full clip.

Usage (base python3, from scripts/fms-killshot/):
  python3 b1_derive.py [--params ~/mosh-fms-ksb/.../mechanism/b1/params.json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

from soulx import duration as sd  # noqa: E402

ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
HANDOFF = os.path.join(ROOT, "asserted-proof", "back-half", "sing-handoff")
SRC = os.path.join(HANDOFF, "scores")
DST = os.path.join(HANDOFF, "scores-derived")
B1 = os.path.join(ROOT, "asserted-proof", "mechanism", "b1")
DEFAULT_PARAMS = os.path.join(B1, "params.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", default=DEFAULT_PARAMS)
    args = ap.parse_args()
    ppath = os.path.abspath(os.path.expanduser(args.params))
    params = sd.load_params(ppath if os.path.isfile(ppath) else None)
    print(f"params: {ppath if os.path.isfile(ppath) else 'module defaults'}")
    print(json.dumps({k: v for k, v in params.items() if k != "provenance"}, indent=1))

    os.makedirs(DST, exist_ok=True)
    summary = {"params_path": ppath if os.path.isfile(ppath) else None, "chunks": {}}
    for name in sorted(os.listdir(SRC)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(SRC, name)) as f:
            clips = json.load(f)
        one = isinstance(clips, dict)
        clip = clips if one else clips[0]
        new_clip, log = sd.derive_clip(clip, params)
        span_s = (clip["time"][1] - clip["time"][0]) / 1000.0
        chain = sum(float(d) for d in new_clip["duration"].split())
        if abs(chain - span_s) > 0.005:
            raise RuntimeError(f"{name}: chain {chain:.4f}s != span {span_s:.4f}s")
        for k in ("text", "phoneme", "note_pitch", "note_type", "time", "index",
                  "language"):
            if new_clip.get(k) != clip.get(k):
                raise RuntimeError(f"{name}: field {k} changed — derive must be "
                                   "durations-only")
        old = [float(d) for d in clip["duration"].split()]
        new = [float(d) for d in new_clip["duration"].split()]
        deltas = [abs(a - b) for a, b in zip(old, new)]
        changed = sum(1 for d in deltas if d > 0.0005)
        with open(os.path.join(DST, name), "w") as f:
            json.dump(new_clip if one else [new_clip], f, indent=1)
        summary["chunks"][name] = {
            "notes": len(new), "changed": changed,
            "max_delta_ms": round(max(deltas) * 1000, 1),
            "flags": sorted({fl.get("flag", "?") for ph in log.get("phrases", [])
                             for fl in ph.get("flags", [])}),
        }
        print(f"{name}: {changed}/{len(new)} notes changed, "
              f"max |delta| {max(deltas)*1000:.0f}ms")
    os.makedirs(B1, exist_ok=True)
    with open(os.path.join(B1, "b1-derive-summary.json"), "w") as f:
        json.dump(summary, f, indent=1, sort_keys=True)
    print(json.dumps({"ok": True, "dst": DST}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
