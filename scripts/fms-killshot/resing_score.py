#!/usr/bin/env python3
"""Re-sing score author (FMS re-sing, stage ④ — one voice, rests where he rested).

The owner's top structural bug: the render sings where his raw take is SILENT. The re-sing
architecture fixes this at the source instead of gating the audio after the fact — before
authoring the SoulX score, every note slot is trimmed to the take's MEASURED voicing:

  - a slot that over-holds past where he went quiet has its end trimmed to the first
    sustained silence (reuses the validated `skeleton.align.clamp_span_to_voicing`);
  - a slot that falls ENTIRELY inside his silence is DROPPED — he wasn't singing there,
    so there is no note. The gap this opens becomes a `<SP>` rest in the authored score.

Then the whole finalized sheet (his kept lines + the re-sung rewritten lines, one continuous
lyric) is authored into ONE SoulX score via `soulx.score.author_score` — which already carries
the re-attack fix (`_slot_phonemes`/`_held_vowel`: held notes sustain the vowel, no re-articulation).

`lineScores` are position-aligned 1:1 with `lines` (build_sheet's contract). Pure stdlib +
skeleton.align + soulx.score. Golden-tested in resing_score_test.py.
"""
from __future__ import annotations

import copy
import re
from typing import List, Optional

from skeleton import align
from soulx import score as sx


def _any_voiced(env, hop_s: float, a: float, b: float, floor: float) -> bool:
    """Did the take have voiced energy anywhere in [a, b)? (measured rest map)."""
    i0 = max(0, int(a / hop_s))
    i1 = min(len(env), int(round(b / hop_s)))
    return any(env[j] >= floor for j in range(i0, i1))


def _clamp_segments(segs: List[dict], new_end: float) -> List[dict]:
    """Keep only segments that start before the trimmed note end, clamping their ends to it."""
    out = []
    for s in segs or []:
        s = dict(s)
        if float(s["start"]) >= new_end:
            continue
        s["end"] = min(float(s["end"]), new_end)
        if float(s["end"]) > float(s["start"]):
            out.append(s)
    return out


def clamp_slots_to_voicing(lineScores: List[dict], env, hop_s: float = 0.01,
                           sil_floor: Optional[float] = None) -> List[dict]:
    """Trim/drop every slot against the take's energy so no note lives in his silence.
    Returns NEW lineScores (deep-copied); a score left with no slots is returned empty
    (author_score skips it → no audio where he was fully silent)."""
    if not env:
        return copy.deepcopy(lineScores or [])
    floor = sil_floor if sil_floor is not None else 0.15 * max(env)
    out = []
    for sc in (lineScores or []):
        sc = copy.deepcopy(sc) if isinstance(sc, dict) else sc
        if not (isinstance(sc, dict) and sc.get("slots")):
            out.append(sc)
            continue
        kept = []
        for slot in sc["slots"]:
            a, b = float(slot["start"]), float(slot["end"])
            if not _any_voiced(env, hop_s, a, b, floor):
                continue                                    # entirely in silence → drop the note
            new_end = align.clamp_span_to_voicing(a, b, env, hop_s, floor)
            slot = dict(slot)
            slot["end"] = new_end
            segs = _clamp_segments(slot.get("segments"), new_end)
            slot["segments"] = segs or [{"start": a, "end": new_end,
                                         "pitch": (slot.get("segments") or [{}])[0].get("pitch", 69)}]
            kept.append(slot)
        sc["slots"] = kept
        out.append(sc)
    return out


def _line_text(line: dict) -> str:
    """The words to sing: the finalized text, else the seed with its ___ gaps removed."""
    txt = (line.get("text") or "").strip()
    if txt:
        return txt
    return re.sub(r"\s+", " ", re.sub(r"_{2,}", " ", line.get("seedText", "") or "")).strip()


def author_resing_score(sheet: dict, env=None, hop_s: float = 0.01,
                        sil_floor: Optional[float] = None, name: str = "resing") -> dict:
    """Finalized sheet (+ the take's energy envelope) → ONE SoulX score for the whole section.
    Clamps every slot to the take's voicing first (so the score rests where he rested), then
    authors his kept + re-sung lines as one continuous performance."""
    lines = sheet.get("lines", [])
    scores = clamp_slots_to_voicing(sheet.get("lineScores") or [], env, hop_s, sil_floor)
    author_lines = []
    for ln, sc in zip(lines, scores):
        if isinstance(sc, dict) and sc.get("slots"):
            # author_score sings only ASSERTED lines (_asserted_text) — without this flag
            # every line was filtered and the author returned no_asserted_scored_lines
            # (pre-existing; RED-proven by resing_score_test on the unfixed code)
            author_lines.append({"text": _line_text(ln), "score": sc, "asserted": True})
    if not author_lines:
        return {"ok": False, "error": "no_voiced_slots"}
    res = sx.author_score(author_lines, name=name)
    res["slotsDropped"] = sum(len((s or {}).get("slots") or []) for s in (sheet.get("lineScores") or [])) \
        - sum(len((s or {}).get("slots") or []) for s in scores)
    return res
