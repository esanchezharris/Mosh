"""FlowSpec — a rhythm/pitch-GROUNDED LineSpec for Finish-My-Song (Stage 1).

A mumbled take is a *specification*, not noise: the skeleton's `lineScores` carry every
syllable's real onset, duration, velocity and MIDI pitch (see service/skeleton/core.py).
The lyric brain, though, was only ever fed a bare syllable count — and an arbitrary
"collapse 32 fragments into 8-syllable bars" step then severed the `lineScores` link, so
no generated word was tied to the time or pitch it must land on. Of course it couldn't
fit the mumble.

FlowSpec is the fix — it turns a skeleton into a LineSpec the generator (lyrics.core) and
the SoulX score author (soulx.score) both consume, WITHOUT throwing away the take:

  * group_by_rest — merge the mumble's fragments into writable PHRASE-lines, split only on
    the take's REAL rests (a gap ≥ ``gap_s`` between consecutive slots). Each phrase keeps
    its true slots verbatim, at their ABSOLUTE times, so author_score places the words back
    on the mumble's grid (the render lands where the mumble actually sang).
  * build_flow_spec — per phrase, derive the exact syllable count, a velocity-stress
    contour, a compact pitch contour (so the brain lands rhyme/payoff words on the sung
    high/held notes), a theme hint from the mumble's OWN ASR (inspiration, never required
    words), and an end-rhyme scheme. The phrase's slots ride along as an author_score-ready
    `score` blob.

Pure stdlib, deterministic. This module derives context; it never mutates the skeleton.
"""
from __future__ import annotations

from typing import List, Optional


# ── grouping ──────────────────────────────────────────────────────────────────────────

def _merge_into(dst: dict, src: dict) -> None:
    """Fold src's slots/bars/span into dst, keeping slots in absolute-time order."""
    dst["slots"] = sorted(dst["slots"] + src["slots"], key=lambda s: float(s.get("start", 0.0)))
    for b in src["bars"]:
        if b not in dst["bars"]:
            dst["bars"].append(b)
    dst["bars"].sort()
    dst["start"] = min(dst["start"], src["start"])
    dst["end"] = max(dst["end"], src["end"])


def group_by_rest(line_scores: List[dict], gap_s: float = 0.35, min_syllables: int = 1) -> List[dict]:
    """Flatten the skeleton's per-bar slots onto one time-ordered line and split into
    phrase groups wherever the silence between consecutive slots (prev.end → next.start)
    is at least ``gap_s`` — the take's real breaths/rests, the unit a listener hears as a
    line. Slots ride through verbatim (absolute times, segments/pitch intact).

    ``min_syllables`` (>1) then absorbs any phrase shorter than that into its NEAREST
    neighbor (by inter-phrase gap) — a 1-note mumble fragment can't be a standalone
    rhyming line (the brain crams a whole line onto one note), so it belongs with the
    phrase it's closest to. Default 1 = no merge.

    Returns ``[{"slots": [...], "bars": [barIndex, ...], "start": float, "end": float}]``.
    None entries and slot-less bars are skipped.
    """
    flat: List[tuple] = []  # (bar, slot)
    for ls in line_scores or []:
        if not isinstance(ls, dict):
            continue
        bar = ls.get("bar")
        for s in ls.get("slots") or []:
            flat.append((bar, s))
    flat.sort(key=lambda bs: float(bs[1].get("start", 0.0)))

    phrases: List[dict] = []
    cur: Optional[dict] = None
    prev_end: Optional[float] = None
    for bar, s in flat:
        st = float(s.get("start", 0.0))
        en = float(s.get("end", st))
        if cur is None or (prev_end is not None and st - prev_end >= gap_s):
            cur = {"slots": [], "bars": [], "start": st, "end": en}
            phrases.append(cur)
        cur["slots"].append(s)
        if bar is not None and bar not in cur["bars"]:
            cur["bars"].append(bar)
        cur["end"] = max(cur["end"], en)
        prev_end = en

    # Absorb un-writable short phrases into the temporally nearest neighbor (repeat until
    # none remain or only one phrase is left). Deterministic: leftmost short phrase first.
    while min_syllables > 1 and len(phrases) > 1:
        i = next((k for k, p in enumerate(phrases) if len(p["slots"]) < min_syllables), None)
        if i is None:
            break
        gap_prev = (phrases[i]["start"] - phrases[i - 1]["end"]) if i > 0 else float("inf")
        gap_next = (phrases[i + 1]["start"] - phrases[i]["end"]) if i < len(phrases) - 1 else float("inf")
        _merge_into(phrases[i - 1] if gap_prev <= gap_next else phrases[i + 1], phrases[i])
        phrases.pop(i)
    return phrases


# ── per-phrase derivations ────────────────────────────────────────────────────────────

def _slot_pitch(slot: dict) -> float:
    """Representative pitch of a slot = median of its (voiced) segment pitches."""
    ps = sorted(float(seg.get("pitch", 0)) for seg in (slot.get("segments") or [])
                if float(seg.get("pitch", 0)) > 0)
    if not ps:
        return 0.0
    n = len(ps)
    return ps[n // 2] if n % 2 else (ps[n // 2 - 1] + ps[n // 2]) / 2.0


def _stress_from_velocity(slots: List[dict]) -> str:
    """'X' where a slot is at/above the phrase's mean velocity (a stressed/accented
    syllable), 'x' below — the rhythmic emphasis the brain should honor."""
    vels = [float(s.get("velocity", 0.0)) for s in slots]
    if not vels:
        return ""
    mean = sum(vels) / len(vels)
    return "".join("X" if v >= mean else "x" for v in vels)


def _pitch_contour(slots: List[dict]) -> str:
    """A compact, human description of the phrase's sung shape so the brain can land the
    rhyme/payoff word on the high or held note. Deterministic."""
    reps = [_slot_pitch(s) for s in slots]
    if not reps:
        return ""
    durs = [float(s.get("end", 0.0)) - float(s.get("start", 0.0)) for s in slots]
    peak = max(range(len(reps)), key=lambda i: reps[i])            # first-max syllable
    held = max(range(len(durs)), key=lambda i: durs[i])            # longest note
    if reps[-1] - reps[0] > 0.5:
        direction = "rises"
    elif reps[0] - reps[-1] > 0.5:
        direction = "falls"
    else:
        direction = "level"
    span = int(round(max(reps) - min(p for p in reps if p > 0))) if any(p > 0 for p in reps) else 0
    return (f"{direction} contour; highest pitch on syllable {peak + 1}; "
            f"held note on syllable {held + 1}; {span} semitone range")


def _theme_hint(bars: List[int], line_heard: List[Optional[dict]]) -> str:
    """The mumble's OWN words for this phrase (Whisper-kept, time-ordered) — a vibe seed
    for the brain, NEVER required words. Empty when the take had no confident words."""
    barset = set(bars)
    words: List[str] = []
    for lh in line_heard or []:
        if not isinstance(lh, dict) or lh.get("bar") not in barset:
            continue
        for w in lh.get("words") or []:
            if w.get("kept") and w.get("word"):
                tok = str(w["word"]).strip().lower()
                if tok and tok not in words:
                    words.append(tok)
    return " ".join(words)


def _rhyme_group(index: int, scheme: str = "AABB") -> str:
    """End-rhyme scheme across phrases. AABB (couplets) is the rap default — adjacent
    lines rhyme; the mumble doesn't dictate rhyme, so we impose a singable one."""
    if scheme == "ABAB":
        return chr(ord("A") + index % 2)
    return chr(ord("A") + (index // 2) % 26)   # AABB couplets


def _word_by_slot_id(skeleton: dict) -> dict:
    """Map each lineScores slot (by object id) to the KEPT mumble word at that position, from
    the skeleton's own per-line `seedText` (extract.py's confident words → mumble.py anchors,
    with `___` for filler). Lets a grouped phrase reconstruct the words at their real slots."""
    line_by_index = {l.get("index"): l for l in (skeleton.get("lines") or [])}
    out: dict = {}
    for ls in skeleton.get("lineScores") or []:
        if not isinstance(ls, dict):
            continue
        line = line_by_index.get(ls.get("bar"))
        tokens = str((line or {}).get("seedText", "") or "").split()
        for i, s in enumerate(ls.get("slots") or []):
            out[id(s)] = tokens[i] if i < len(tokens) else "___"
    return out


def build_flow_spec(skeleton: dict, *, gap_s: float = 0.35, min_syllables: int = 1,
                    preserve_words: bool = False, chorus: str = "", theme: str = "",
                    mood: str = "", grid: str = "1/16", rhymeStrictness: str = "slant",
                    rhyme_scheme: str = "AABB") -> dict:
    """Turn a mumble skeleton into a rhythm/pitch-grounded LineSpec. Each line carries the
    exact syllable count, velocity-stress, pitch contour, and a theme hint derived from the
    real take, plus its true slots as an author_score-ready `score` blob. Shaped like the
    lyric engine's spec so lyrics.core.complete_verse can consume it directly.

    ``preserve_words``: carry the take's KEPT words into each phrase's `seedText` (words at
    their real slots, `___` for filler gaps) so the generator keeps your actual bars and
    invents only the gaps. Default False = blank seed (invent every line freely)."""
    line_scores = skeleton.get("lineScores") or []
    line_heard = skeleton.get("lineHeard") or []
    slot_word = _word_by_slot_id(skeleton) if preserve_words else {}
    bpm = 138.0
    for ls in line_scores:
        if isinstance(ls, dict) and ls.get("bpm"):
            bpm = float(ls["bpm"])
            break

    lines: List[dict] = []
    for i, ph in enumerate(group_by_rest(line_scores, gap_s=gap_s, min_syllables=min_syllables)):
        slots = ph["slots"]
        seed = " ".join(slot_word.get(id(s), "___") for s in slots) if preserve_words else ""
        lines.append({
            "index": i,
            "role": "verse",
            "seedText": seed,                        # kept words + gaps (preserve) or blank (invent)
            "syllableTarget": len(slots),
            # EXACT count — the hand-fit discipline the owner certified by ear (demo d5,
            # 2026-07-11): one syllable per measured note; ±1 slack re-introduces squeeze/hold.
            "syllableTol": 0,
            "stress": _stress_from_velocity(slots),
            "pitchContour": _pitch_contour(slots),
            "themeHint": _theme_hint(ph["bars"], line_heard),
            "rhymeGroup": _rhyme_group(i, rhyme_scheme),
            "score": {"v": 1, "algo": "flow", "bar": (ph["bars"][0] if ph["bars"] else 0),
                      "bpm": bpm, "timeSig": [4, 4], "grid": grid, "clamped": False,
                      "slots": slots},
            "startS": round(float(ph["start"]), 3),
            "endS": round(float(ph["end"]), 3),
        })
    return {"ok": True, "grid": grid, "topic": theme, "mood": mood,
            "rhymeStrictness": rhymeStrictness, "lines": lines,
            "source": "flowspec", "chorus": chorus, "theme": theme}
