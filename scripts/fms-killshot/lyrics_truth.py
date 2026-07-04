#!/usr/bin/env python3
"""Lyrics-truth comparison for KS-B: written words vs detected syllable slots.

Takes a v3 diagnostic.json (articulations with absolute times) and a lyrics text file
(one sung line per line; `#` comments; parenthesised lines = response/echo vocal).
Counts TEXT syllables per line via the phonology core (cmudict/pronouncing, heuristic
fallback), gap-segments the DETECTED articulations into phrases (a new phrase after a
silence >= --phrase-gap seconds), and prints both side by side in order, plus totals.

The alignment is order-based and approximate — echoes overlapping the lead in a stereo
pella will interleave (Basic Pitch collapses to one voice), so phrase k may not equal
lyric line k late in the song. The point is the per-line COUNT comparison early and the
totals; the ear (overlay.wav) arbitrates disagreements.

Usage: lyrics_truth.py --diagnostic <v3 diagnostic.json> --lyrics <txt> [--phrase-gap 0.6]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
from phonology import core as ph  # noqa: E402


def line_syllables(pr: "ph.Pronouncer", line: str) -> tuple[int, list]:
    words = [w for w in re.split(r"[\s,;]+", line) if any(c.isalpha() for c in w)]
    per = []
    for w in words:
        clean = w.strip(".,!?'\"()-—").lower()
        n = pr.syllables(clean) or 1
        per.append((w, n))
    return sum(n for _, n in per), per


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--diagnostic", required=True)
    ap.add_argument("--lyrics", required=True)
    ap.add_argument("--phrase-gap", type=float, default=0.6)
    args = ap.parse_args()

    diag = json.load(open(args.diagnostic))
    arts = diag.get("articulations") or diag.get("nuclei")
    if not arts:
        print("no articulations in diagnostic", file=sys.stderr)
        return 2

    # gap-segment detected articulations into phrases
    phrases = []
    for a in arts:
        if phrases and float(a["start"]) - phrases[-1]["end"] < args.phrase_gap:
            phrases[-1]["end"] = float(a["end"])
            phrases[-1]["slots"] += 1
        else:
            phrases.append({"start": float(a["start"]), "end": float(a["end"]), "slots": 1})

    pr = ph.Pronouncer()
    lines = []
    for raw in open(args.lyrics):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        echo = raw.startswith("(")
        n, per = line_syllables(pr, raw)
        lines.append({"text": raw, "syllables": n, "echo": echo,
                      "words": [{"w": w, "syl": s} for w, s in per]})

    lead_total = sum(l["syllables"] for l in lines if not l["echo"])
    all_total = sum(l["syllables"] for l in lines)
    det_total = len(arts)

    print(f"TEXT: {len(lines)} lines, lead syllables={lead_total} (+echo={all_total - lead_total})")
    print(f"DETECTED: {det_total} slots in {len(phrases)} gap-phrases "
          f"(gap>={args.phrase_gap}s)\n")
    print(f"{'line (text)':52s} {'txt':>4s}   {'phrase':>14s} {'det':>4s}  {'d':>4s}")
    for i, l in enumerate(lines):
        p = phrases[i] if i < len(phrases) else None
        mark = "~" if l["echo"] else " "
        if p:
            d = p["slots"] - l["syllables"]
            print(f"{mark}{l['text'][:50]:51s} {l['syllables']:>4d}   "
                  f"{p['start']:>6.1f}-{p['end']:<6.1f} {p['slots']:>4d}  {d:>+4d}")
        else:
            print(f"{mark}{l['text'][:50]:51s} {l['syllables']:>4d}   {'—':>14s}")
    extra = phrases[len(lines):]
    if extra:
        print(f"\n+{len(extra)} detected phrases beyond the written lines "
              f"(repeats/adlibs): slots={sum(p['slots'] for p in extra)}")
    out = {"text_lead": lead_total, "text_all": all_total,
           "detected_slots": det_total, "phrases": phrases, "lines": lines}
    sidecar = os.path.join(os.path.dirname(args.diagnostic), "lyrics_truth.json")
    with open(sidecar, "w") as f:
        json.dump(out, f, indent=1)
    print(f"\nwrote {sidecar}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
