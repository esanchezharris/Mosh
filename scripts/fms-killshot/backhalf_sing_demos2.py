#!/usr/bin/env python3
"""Demo round 2 — triage from the owner's ear verdicts on round 1.

Verdicts: d3 (hand-fit) beats d1 ✓ lyrics+alignment is a lever. d4 (B-major snap) sounded
WORSE — the owner: "we are in D maj". That resolves the key saga: the melody centers on B
because B is D major's RELATIVE MINOR (same pitch set) — the B-*major* snap moved D/G/A
naturals onto D#/G#/A#, manufacturing sour notes. d2 (take words) doesn't quite sit —
suspects: the "la" filler notes on gap slots (many are Basic-Pitch phantoms), the 1.5-beat
hold cap chopping real sustains, or SoulX phrasing. Round 2 separates all of it:

  d5-pitch-Dmaj    d3's words, pitch snapped to D MAJOR, capped     -> the key fix (vs d4)
  d6-words-only    take's KEPT words at their slots, NO la filler   -> phantom slots (vs d2)
  d7-uncapped      d3's words, raw holds (no condition cap)         -> the cap (vs d3)
  d8-best          d3's words, D major + uncapped                   -> composite candidate

Same section, ref, and pipeline as round 1. Nothing enters git.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backhalf_ab_bench import BH, CHORUS, SECT0, SECT1, THEME, slice_and_rebase  # noqa: E402
from backhalf_flowfit_ab import authored_for  # noqa: E402
from backhalf_sing_demos import HAND_LINES, SCORES, author, pitch_clean  # noqa: E402
import backhalf_sing_demos as demos1  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "service"))
from lyrics import flowspec  # noqa: E402

# Owner ear verdict (with the beat, in the DAW): the session is D MAJOR (= B minor pitch set).
demos1.SCALE.clear()
demos1.SCALE.update({2, 4, 6, 7, 9, 11, 1})   # D E F# G A B C#


def main() -> int:
    SCORES.mkdir(parents=True, exist_ok=True)
    for old in SCORES.glob("*.json"):
        old.unlink()

    skel = json.loads((BH / "skeleton.json").read_text())
    sec = slice_and_rebase(skel, SECT0, SECT1)
    spec = flowspec.build_flow_spec(sec, chorus=CHORUS, theme=THEME, gap_s=0.35,
                                    min_syllables=2, preserve_words=True)
    lines = spec["lines"]

    hand = [{"index": l["index"], "text": t, "score": l["score"]}
            for l, t in zip(lines, HAND_LINES)]

    # d5 — hand words, D-major snap, capped (the d4 fix)
    d5 = [{**e, "score": {**e["score"], "slots": pitch_clean(e["score"]["slots"])}}
          for e in authored_for(hand, condition=True)]
    author("d5-pitch-Dmaj", d5)

    # d6 — the take's KEPT words at their exact slots, phantom/gap slots become real rests
    d6 = []
    for l in lines:
        toks = l["seedText"].split()
        slots = l["score"]["slots"]
        pairs = [(t, s) for t, s in zip(toks, slots) if t != "___"]
        if not pairs:
            continue
        d6.append({"index": l["index"], "text": " ".join(t for t, _ in pairs),
                   "score": {**l["score"], "slots": [s for _, s in pairs]}})
    author("d6-words-only", authored_for(d6, condition=True))

    # d7 — hand words, raw holds (no cap)
    author("d7-uncapped", authored_for(hand, condition=False))

    # d8 — hand words, D major + raw holds (composite)
    d8 = [{**e, "score": {**e["score"], "slots": pitch_clean(e["score"]["slots"])}}
          for e in authored_for(hand, condition=False)]
    author("d8-best", d8)

    print(f"\nround-2 scores staged -> {SCORES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
