#!/usr/bin/env python3
"""Fully-rewrite the mumbled lines (A/B option B): keep only clearly-SUNG lines verbatim; for
every other line, blank the (often garbled) seed, re-grid the score to a NATURAL syllable rate
(so words aren't stretched over his sparse 2-note mumble slots), and let the LLM write a fresh
coherent line of that syllable count. His melody contour is preserved by interpolating the
original slot pitches across the finer grid. Output: a sheet the score author + splice render.

  brain-env python3 rewrite_full.py <sheet.json> <out-sheet.json> [syl_per_sec]
"""
from __future__ import annotations

import json
import os
import statistics
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

from lyrics import core as lyr  # noqa: E402


def _slot(a, b, pitch):
    return {"start": round(a, 4), "end": round(b, 4), "velocity": 90,
            "segments": [{"start": round(a, 4), "end": round(b, 4), "pitch": int(pitch)}]}


def make_fully_rewritten(sheet: dict, syl_per_sec: float = 3.0) -> dict:
    by = {l["index"]: sc for l, sc in zip(sheet["lines"], sheet["lineScores"])}
    for l in sheet["lines"]:
        if l.get("origin") == "sung":
            continue                                  # keep his clearly-sung lines verbatim
        sc = by.get(l["index"])
        slots = (sc or {}).get("slots") or []
        if not slots:
            continue
        s0 = min(float(x["start"]) for x in slots)
        e0 = max(float(x["end"]) for x in slots)
        dur = e0 - s0
        n = max(2, round(dur * syl_per_sec))          # natural syllable count for the span
        # preserve his melody: interpolate the original slot pitches across the finer grid
        ot = [(float(x["start"]) + float(x["end"])) / 2 for x in slots]
        op = [int(statistics.median([int(sg.get("pitch", 60)) for sg in (x.get("segments") or [{"pitch": 60}])]))
              for x in slots]
        centers = [s0 + (i + 0.5) * dur / n for i in range(n)]
        pit = np.interp(centers, ot, op) if len(ot) > 1 else [op[0]] * n
        step = dur / n
        sc["slots"] = [_slot(s0 + i * step, s0 + (i + 1) * step, round(pit[i])) for i in range(n)]
        l["text"] = ""
        l["seedText"] = ""
        l["syllableTarget"] = int(n)
        l["origin"] = "mumble"
    return sheet


def main() -> int:
    sheet = json.load(open(sys.argv[1]))
    syl = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
    sheet = make_fully_rewritten(sheet, syl)
    gen = lyr.complete(sheet, backend=None)           # LLM when a brain key is present, else fake
    by = {x["index"]: x for x in gen.get("lines", [])}
    filled = 0
    for l in sheet["lines"]:
        props = by.get(l["index"], {}).get("proposals") or []
        if props and not (l.get("text") or "").strip():
            l["text"] = props[0]["text"]
            l["origin"] = "generated"
            filled += 1
    json.dump(sheet, open(sys.argv[2], "w"))
    print(f"backend={gen.get('backend')} rewrote={filled} lines -> {sys.argv[2]}")
    for l in sheet["lines"]:
        if l.get("origin") == "generated":
            print(f"  idx{l['index']:>2} ({l.get('syllableTarget')} syl): {l.get('text')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
