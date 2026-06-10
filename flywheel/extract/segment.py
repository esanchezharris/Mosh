"""Segmentation (phase0 §7.2): chapter the transcript into tutorial steps.

Trap/lo-fi/club tutorials are strongly conventionalized (drums → 808 →
melody → mix → arrange), so ASR discourse markers carry most of the signal;
visual change points join in when keyframes exist.
"""
from __future__ import annotations

import re

DISCOURSE_MARKERS = re.compile(
    r"\b(now( let'?s)?|next( up)?|alright|okay so|let'?s (add|do|make|get|throw)"
    r"|moving on|for the (808|drums?|hats?|kick|snare|melody|keys|bass|mix)"
    r"|time (for|to)|last(ly)?|finally)\b", re.I)

MIN_STEP_SECONDS = 8.0


def segment(transcript: list[dict]) -> list[dict]:
    """[{start, end, text}] → [{step_id, narration, narration_ts: [s, e]}]."""
    if not transcript:
        return []
    steps: list[dict] = []
    cur: list[dict] = [transcript[0]]
    for seg in transcript[1:]:
        boundary = bool(DISCOURSE_MARKERS.search(seg["text"]))
        long_enough = (seg["start"] - cur[0]["start"]) >= MIN_STEP_SECONDS
        if boundary and long_enough:
            steps.append(_step(len(steps) + 1, cur))
            cur = [seg]
        else:
            cur.append(seg)
    steps.append(_step(len(steps) + 1, cur))
    return steps


def _step(n: int, segs: list[dict]) -> dict:
    return {
        "step_id": f"s{n}",
        "narration": " ".join(s["text"] for s in segs).strip(),
        "narration_ts": [round(segs[0]["start"], 2), round(segs[-1]["end"], 2)],
    }
