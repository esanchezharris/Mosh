#!/usr/bin/env python3
"""Build a rewrite spec from a gated take (FMS hybrid rewrite-and-sing, stage 3b).

The coherence gate (service/lyrics/extract.py) labels each line sung / partial / mumble.
This turns those per-line records into the spec service/lyrics/core.py rewrites:

- SUNG   → a LOCKED line carrying his verbatim words. core.complete SKIPS it, and its end
           word becomes the anchor its rhyme group is rewritten against.
- PARTIAL→ a fillable line seeded with the words he DID sing (gaps as `___`); core keeps
           those words and fills only the gaps.
- MUMBLE → a fillable line with an empty seed and the DETECTED syllable count as target;
           core writes a fresh line that hits that count and rhymes to the group's anchor.

Rhyme groups come from rhyme_scheme.infer_scheme (read off the clear end-words), so a
rewritten line rhymes to whichever clear neighbour shares its group. Pure stdlib.

Record shape (per line, produced by the gate in hybrid_sing.py):
  {"index": int, "origin": "sung"|"partial"|"mumble", "syllables": int,
   "text": str,        # sung: the verbatim clear line
   "seedText": str,    # partial: kept words with ___ gaps
   "endWord": str|None}# rhyme evidence (sung/partial end; None for mumble)
"""
from __future__ import annotations

from typing import List, Optional

import rhyme_scheme


def build_spec(records: List[dict], topic: Optional[str] = None, mood: Optional[str] = None,
               grid: str = "1/16", strictness: str = "slant") -> dict:
    groups = rhyme_scheme.infer_scheme(
        [{"endWord": r.get("endWord"), "origin": r.get("origin")} for r in records],
        strictness=strictness)

    lines: List[dict] = []
    for r, g in zip(records, groups):
        origin = r.get("origin")
        line = {"index": r.get("index"), "rhymeGroup": g, "origin": origin}
        syl = int(r.get("syllables") or 0)
        if syl > 0:
            line["syllableTarget"] = syl
        if origin == "sung":
            line["text"] = r.get("text", "")
            line["locked"] = True          # his verbatim words — never rewritten, just anchor
        elif origin == "partial":
            line["seedText"] = r.get("seedText", "")   # keep his words, fill the gaps
        else:                               # mumble — write it fresh to target + group rhyme
            line["seedText"] = ""
        lines.append(line)

    spec = {"grid": grid, "rhymeStrictness": strictness, "lines": lines}
    if topic:
        spec["topic"] = topic
    if mood:
        spec["mood"] = mood
    return spec
