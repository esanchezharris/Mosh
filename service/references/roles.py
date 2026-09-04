#!/usr/bin/env python3
"""Role attribution for reference projects — shared by the .als and (later) .flp readers.

Three tiers, and the third one is the point:

  A  drum lexicon      — name matching, high confidence. Reference projects name their
                         drums well ("Kick", "Snare 1", "Shaker 3") and that is the one
                         place naming is reliable.
  B  note-derived      — melodic tracks are named after the PLUGIN ("Sylenth1",
                         "7-Analog", "PLUCK BZN"), which says nothing about the part. So
                         do not read the name: read what the notes do. Recorded as
                         heuristic, with the features attached so a human can audit it.
  C  null              — unmappable, WITH a reason. Never impute a role from track
                         position, colour or order.

The tier-C outcome is deliberate. `~/AbletonMONSTER/extract_als.py:87-98` has a
name-only `classify_track()` that always returns something; a classifier that cannot
say "I don't know" manufactures coverage, and every downstream median inherits the lie.
"""
from __future__ import annotations

import re
from typing import Optional

# ── Tier A: the drum lexicon ────────────────────────────────────────────────────────
# Order matters: "open hat" must beat "hat", "kick layer" must beat "kick" only insofar
# as both are kicks. Each entry is (role, compiled pattern).
_DRUM_LEXICON: list[tuple[str, re.Pattern[str]]] = [
    ("808",      re.compile(r"\b(808|sub ?bass|subbass)\b")),
    ("openhat",  re.compile(r"\b(open ?hat|ohat|oh)\b")),
    ("hat",      re.compile(r"\b(hi ?hat|hihat|hat|hh|closed ?hat|chh)\b")),
    ("kick",     re.compile(r"\b(kick|kik|bd|bass ?drum)\b")),
    ("snare",    re.compile(r"\b(snare|snr|sd)\b")),
    ("clap",     re.compile(r"\b(clap|clp|hand ?clap)\b")),
    ("rim",      re.compile(r"\b(rim|rimshot|cross ?stick)\b")),
    ("shaker",   re.compile(r"\b(shaker|shkr|tamb|tambourine|maraca)\b")),
    ("tom",      re.compile(r"\b(tom|floor ?tom)\b")),
    ("cymbal",   re.compile(r"\b(crash|ride|cymbal|cym|splash)\b")),
    ("perc",     re.compile(r"\b(perc|percussion|conga|bongo|clave|cowbell|woodblock)\b")),
]

# Names that are a PLUGIN or a placeholder, never a part. Matching one is a positive
# signal that the name is uninformative — it sends the track to tier B rather than
# letting a stray substring ("Analog" contains no drum word, but "Kick Synth" does)
# score it as a drum.
_PLUGIN_NAMES = re.compile(
    r"\b(serum|sylenth|massive|nexus|omnisphere|kontakt|vital|analog|operator|wavetable|"
    r"simpler|sampler|drum ?rack|instrument|midi|audio|track|inst)\b"
)


def _normalise(name: str) -> str:
    """Lowercase, strip Ableton's leading track index and trailing dup markers."""
    n = name.lower().strip()
    n = re.sub(r"^\d+[-\s]+", "", n)          # "18-snare - money" -> "snare - money"
    n = re.sub(r"[_\-.]+", " ", n)
    n = re.sub(r"\s+\d+\s*$", " ", n)          # "Snare 1" -> "snare"
    n = re.sub(r"\s+", " ", n)
    return n.strip()


def role_from_name(name: str) -> Optional[str]:
    """Tier A only. None means 'the name did not say', not 'no role'."""
    n = _normalise(name)
    if not n:
        return None
    for role, pat in _DRUM_LEXICON:
        if pat.search(n):
            return role
    return None


def name_is_uninformative(name: str) -> bool:
    """True when the name is a plugin/placeholder — i.e. tier B must decide."""
    n = _normalise(name)
    if not n:
        return True
    return bool(_PLUGIN_NAMES.search(n)) and role_from_name(name) is None


def role_from_notes(feat: dict) -> tuple[Optional[str], str]:
    """Tier B. `feat` comes from note_features(). Returns (role, why).

    Coarse on purpose: these boundaries separate parts that BEHAVE differently, which is
    what the produce lane's roles are. Anything that does not clearly land is tier C.
    """
    n = feat.get("noteCount", 0)
    if n < 4:
        return None, f"only {n} notes — too few to characterise"
    med = feat.get("medianPitch")
    poly = feat.get("meanPolyphony", 1.0)
    per_bar = feat.get("notesPerBar", 0.0)
    length = feat.get("medianLengthBeats", 0.0)
    duty = feat.get("dutyCycle", 0.0)
    if med is None:
        return None, "no pitch data"

    if med < 48 and poly < 1.5:
        return "bass", f"median pitch {med} below C3 and monophonic (polyphony {poly:.1f})"
    if length >= 4.0 and duty >= 0.6:
        return "pad", f"long notes ({length:.1f} beats) covering {duty:.0%} of the clip"
    if poly >= 2.5 and length >= 1.0:
        return "chords", f"polyphony {poly:.1f} with sustained notes ({length:.1f} beats)"
    if poly < 1.5 and per_bar >= 6.0:
        return "arp", f"monophonic at {per_bar:.1f} notes/bar"
    if poly >= 2.0 and length < 0.5:
        return "stab", f"polyphony {poly:.1f} in short hits ({length:.2f} beats)"
    if poly < 1.5 and 1.0 <= per_bar < 6.0:
        return "lead", f"monophonic at {per_bar:.1f} notes/bar"
    return None, (f"no rule fits (polyphony {poly:.1f}, {per_bar:.1f}/bar, "
                  f"length {length:.2f}, duty {duty:.0%})")
