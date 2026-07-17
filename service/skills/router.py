#!/usr/bin/env python3
"""Route a task string + a snapshot to a mined skill, fill its slots, and
emit a MoshOps command sequence. No model, no training — deterministic
lexical retrieval (textutil.tokenize + a per-skill trigger bag mined by
mine.py) plus rule-based slot extraction (regexes + snapshot lookups).

The minimal snapshot shape this module expects (a hand-rolled stand-in for
`MoshOps::snapshot()` — mapping the real one is Wave 2's job, see README):

    {
      "tracks": [{"id": "1011", "name": "Drums", "type": "drum"}, ...],
      "clips":  [{"id": "1018", "trackId": "1016", "kind": "midi",
                  "notes": [{"pitch": 60, "start": 0, "length": 1, "velocity": 100}, ...]}, ...],
      "buses":  [{"index": 0, "name": "Reverb"}, ...],
      "selectedTrackId": "1019",   # optional — the deictic fallback ("keep
      "selectedClipId": "1021",    # this take", "arm it") when no track/clip
                                    # is named in the clause at all.
    }

Pipeline for one task string:

  1. `select_skill`   — rank every skill by lexical overlap between the task
     text and the skill's mined `triggers`; highest score wins (deterministic
     tie-break: score, then provenance count, then name).
  2. `fill_slots`      — for the handful of skills whose slots need computed
     values (existing-note transforms, mute-all-but, bus reuse — the same
     families mine.py's SEMANTIC_REFINERS special-cased), dispatch to a
     matching special filler; every other skill is filled generically:
     trackId/clipId resolve by name/number against the snapshot, everything
     else through a small (command, arg-name) -> extractor table, falling
     back to the slot's mined `default` (a real value from provenance, never
     invented) when the text doesn't say.
  3. Preconditions are checked against the snapshot before a skill is
     accepted; unmet preconditions surface as an error rather than emitting
     a command that would fail against the real engine.
  4. `expand_template` — substitute `{slot}` / `{item.field}` placeholders,
     honoring `repeat_over` (once per list item) and `emit_if` (skip a
     command whose predicate doesn't hold, e.g. don't re-create an existing
     bus).
  5. `route()` tries the whole task text as one skill first; only if that
     fails does it split on conjunctions ("and", ";", ", then") and route
     each clause separately, chaining up to `max_chain` skills' commands —
     the "composition" the brief asks for, kept simple and predictable
     rather than a general planner.

Every emitted command is validated against `moshops_catalog` before being
returned; `route()` never returns a command the real MoshOps command surface
would reject for an unknown name or a missing required arg.
"""
from __future__ import annotations

import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import moshops_catalog as mc  # noqa: E402
import textutil as tu  # noqa: E402
from schema import Skill, eval_predicate  # noqa: E402

LIBRARY_PATH = Path(__file__).resolve().parent / "library.jsonl"


def load_library(path: Path = LIBRARY_PATH) -> list[Skill]:
    skills = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                skills.append(Skill.from_dict(json.loads(line)))
    return skills


# ── retrieval ─────────────────────────────────────────────────────────────


def _trigger_idf(skills: list[Skill]) -> dict[str, float]:
    """IDF of each trigger token over 'how many skills' trigger bags contain
    it' — recomputed fresh from the loaded library every call (a few dozen
    skills, trivially cheap), not persisted in library.jsonl.

    mine.py's derive_triggers already discounts a word that's common across
    the WHOLE CORPUS TEXT ("track", "the melody") from dominating any one
    cluster's own trigger bag. But that doesn't stop the same word from
    still showing up in MANY different skills' (already-discounted) trigger
    bags — e.g. "track" legitimately belongs in assign-sample's,
    set-track-type's, rename-track's, and others' trigger lists all at once.
    A first cut at scoring (plain overlap-count / trigger-set-size) let a
    tiny trigger bag (e.g. set-track-type's 3 words) win over a properly-
    matching large one (assign-sample's 16) purely because sharing 2-of-3
    generic words looks like better *coverage* than sharing 4-of-16 more
    specific ones. Weighting the overlap by how skill-specific each token
    actually is (this function) fixes that — see router_test.py's held-out
    accuracy suite, which caught the regression.
    """
    from collections import Counter

    df: Counter[str] = Counter()
    for s in skills:
        df.update(set(s.triggers))
    n = len(skills)
    return {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()}


def score_skill(task_text: str, skill: Skill, trigger_idf: dict[str, float]) -> float:
    query = set(tu.tokenize(task_text))
    triggers = set(skill.triggers)
    if not query or not triggers:
        return 0.0
    overlap = query & triggers
    if not overlap:
        return 0.0
    return sum(trigger_idf.get(t, 1.0) for t in overlap)


@dataclass(frozen=True)
class Candidate:
    skill: Skill
    score: float


def rank_skills(task_text: str, skills: list[Skill]) -> list[Candidate]:
    trigger_idf = _trigger_idf(skills)
    cands = [Candidate(s, score_skill(task_text, s, trigger_idf)) for s in skills]
    cands = [c for c in cands if c.score > 0]
    cands.sort(key=lambda c: (-c.score, -len(c.skill.provenance), c.skill.name))
    return cands


def select_skill(task_text: str, skills: list[Skill]) -> Optional[Skill]:
    ranked = rank_skills(task_text, skills)
    return ranked[0].skill if ranked else None


# ── snapshot lookups (track/clip resolution) ────────────────────────────


def find_track_mentions(text: str, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Every track referenced in `text`, ordered by first mention: by literal
    name (word-boundary, case-insensitive) or a bare 'track N' / 'track
    called X' numeric/quoted reference."""
    text_l = text.lower()
    hits: list[tuple[int, dict[str, Any]]] = []

    num = tu.extract_track_number(text)
    if num is not None:
        m = re.search(r"\btrack\s+\d+\b", text_l)
        for t in snapshot.get("tracks", []):
            if str(t.get("id")) == str(num):
                hits.append((m.start() if m else 0, t))

    for t in snapshot.get("tracks", []):
        name = (t.get("name") or "").lower()
        if not name:
            continue
        m = re.search(rf"\b{re.escape(name)}\b", text_l)
        if m:
            hits.append((m.start(), t))

    hits.sort(key=lambda h: h[0])
    seen: set[str] = set()
    ordered: list[dict[str, Any]] = []
    for _, t in hits:
        if t["id"] not in seen:
            ordered.append(t)
            seen.add(t["id"])
    return ordered


def resolve_track_id(text: str, snapshot: dict[str, Any]) -> Optional[str]:
    hits = find_track_mentions(text, snapshot)
    return hits[0]["id"] if hits else None


def resolve_clip_for_track(
    snapshot: dict[str, Any], track_id: Optional[str], kind: Optional[str] = None
) -> Optional[str]:
    if track_id is None:
        return None
    for c in snapshot.get("clips", []):
        if c.get("trackId") == track_id and (kind is None or c.get("kind") == kind):
            return c.get("id")
    return None


def clip_notes(snapshot: dict[str, Any], clip_id: Optional[str]) -> list[dict[str, Any]]:
    for c in snapshot.get("clips", []):
        if c.get("id") == clip_id:
            return list(c.get("notes", []))
    return []


def find_bus(snapshot: dict[str, Any], name: Optional[str]) -> Optional[dict[str, Any]]:
    for b in snapshot.get("buses", []):
        if b.get("name") == name:
            return b
    return None


def next_bus_index(snapshot: dict[str, Any], already_created: int = 0) -> int:
    return len(snapshot.get("buses", [])) + already_created


# ── scalar text extractors (small, composable, no external deps) ───────

_ORDINALS = {"first": 0, "1st": 0, "second": 1, "2nd": 1, "third": 2, "3rd": 2, "fourth": 3, "4th": 3, "fifth": 4, "5th": 4}
_INTERVAL_SEMITONES = {
    "unison": 0, "second": 2, "third": 4, "fourth": 5, "fifth": 7, "sixth": 9, "seventh": 11, "octave": 12,
}


def extract_transport_action(text: str) -> Optional[str]:
    t = text.lower()
    if "record" in t:
        return "record"
    if "to the start" in t or "to start" in t or "rewind" in t:
        return "to_start"
    if "to the end" in t:
        return "to_end"
    if "stop" in t:
        return "stop"
    if "play" in t:
        return "play"
    return None


def extract_ordinal_index(text: str) -> Optional[int]:
    t = text.lower()
    for word, idx in _ORDINALS.items():
        if re.search(rf"\b{word}\b", t):
            return idx
    m = re.search(r"\btake\s+(\d+)\b", t)
    return int(m.group(1)) - 1 if m else None


def extract_pan(text: str) -> Optional[float]:
    t = text.lower()
    hard = bool(re.search(r"\b(hard|full(?:y)?|all the way)\b", t))
    if "left" in t:
        return -1.0 if hard else -0.5
    if "right" in t:
        return 1.0 if hard else 0.5
    if re.search(r"\b(center|centre|middle)\b", t):
        return 0.0
    return None


_DOWNWARD_RE = re.compile(r"\b(down|lower|drop|below)\b")


def extract_signed_interval(text: str) -> Optional[int]:
    """A signed semitone count from words like 'down a fifth' / 'up an octave'."""
    t = text.lower()
    m = re.search(r"(-?\d+)\s*semitones?", t)
    if m:
        n = int(m.group(1))
        if not m.group(1).startswith("-") and _DOWNWARD_RE.search(t):
            n = -n
        return n
    magnitude = None
    for word, semis in _INTERVAL_SEMITONES.items():
        if re.search(rf"\b{word}\b", t):
            magnitude = semis
            break
    if magnitude is None:
        return None
    if _DOWNWARD_RE.search(t):
        return -magnitude
    return magnitude  # unspecified/"up" both default to up, matching the corpus


def extract_effect_type(text: str) -> Optional[str]:
    t = text.lower()
    table = [
        (r"\breverb\b", "reverb"),
        (r"\b(delay|echo)\b", "delay"),
        (r"\bcompress", "compressor"),
        (r"\b(high-?pass|hpf|low-?pass|lpf|bright|\beq\b|equali[sz]er)", "4bandEq"),
    ]
    for pat, val in table:
        if re.search(pat, t):
            return val
    return None


def extract_bus_type_name(text: str) -> Optional[str]:
    t = text.lower()
    if "reverb" in t:
        return "Reverb"
    if "delay" in t or "echo" in t:
        return "Delay"
    if "chorus" in t:
        return "Chorus"
    return None


def extract_all_bus_type_names(text: str) -> list[str]:
    t = text.lower()
    found = []
    for kw, name in (("reverb", "Reverb"), ("delay", "Delay"), ("echo", "Delay"), ("chorus", "Chorus")):
        if kw in t and name not in found:
            found.append(name)
    return found


def extract_rename_target(text: str) -> Optional[str]:
    m = re.search(r"\b(?:to|as|named|called)\s+([A-Za-z][A-Za-z0-9]*)\s*$", text.strip())
    return m.group(1) if m else None


def extract_track_type(text: str) -> Optional[str]:
    t = text.lower()
    if "drum" in t:
        return "drum"
    if "audio" in t:
        return "audio"
    return None


def extract_sample_mode(text: str) -> Optional[str]:
    t = text.lower()
    if "melodic" in t or "pitched" in t or "keyboard" in t:
        return "melodic"
    return "drum"


def extract_input_monitor_mode(text: str) -> Optional[str]:
    t = text.lower()
    if "off" in t:
        return "off"
    if "auto" in t:
        return "automatic"
    if "on" in t:
        return "on"
    return None


def extract_discard(text: str) -> Optional[bool]:
    t = text.lower()
    if re.search(r"\b(scrap|discard|toss|ditch|trash|delete)\b", t):
        return True
    if re.search(r"\bkeep\b", t):
        return False
    return None


def extract_armed(text: str) -> Optional[bool]:
    t = text.lower()
    if re.search(r"\bdisarm\b", t):
        return False
    if re.search(r"\barm\b", t):
        return True
    return None


def extract_file_path(text: str) -> Optional[str]:
    m = re.search(r"(?:/[\w.\-]+){2,}", text)
    return m.group(0) if m else None


_FRACTION_PARTS: dict[str, Callable[[str], Optional[int]]] = {
    "numerator": lambda t: (tu.extract_fraction(t) or (None, None))[0],
    "denominator": lambda t: (tu.extract_fraction(t) or (None, None))[1],
}

# (owning MoshOps command, arg name) -> extractor. Only truly ambiguous names
# (reused across commands with different meanings, e.g. "type"/"name"/"mode")
# need the command-qualified key; everything else is keyed by name alone.
_EXTRACTORS: dict[tuple[Optional[str], str], Callable[[str], Any]] = {
    ("assign_sample", "note"): tu.extract_note_number,
    ("assign_sample", "file"): extract_file_path,
    ("assign_sample", "mode"): extract_sample_mode,
    ("set_track_type", "type"): extract_track_type,
    ("load_builtin", "type"): extract_effect_type,
    ("rename_track", "name"): extract_rename_target,
    ("create_bus", "name"): extract_bus_type_name,
    ("set_input_monitor", "mode"): extract_input_monitor_mode,
    (None, "bpm"): tu.extract_bpm,
    (None, "db"): tu.extract_db,
    (None, "pan"): extract_pan,
    (None, "solo"): lambda t: True,
    (None, "armed"): extract_armed,
    (None, "action"): extract_transport_action,
    (None, "discardRecordings"): extract_discard,
    (None, "takeIndex"): extract_ordinal_index,
    (None, "numerator"): _FRACTION_PARTS["numerator"],
    (None, "denominator"): _FRACTION_PARTS["denominator"],
}


def _arg_owner_command(skill: Skill, slot_name: str) -> Optional[str]:
    """Which template command has a scalar `{slot_name}` placeholder."""
    for tc in skill.template:
        for v in tc.args.values():
            if v == f"{{{slot_name}}}":
                return tc.command
    return None


def _repeat_owner_command(skill: Skill, slot_name: str) -> Optional[str]:
    for tc in skill.template:
        if tc.repeat_over == slot_name:
            return tc.command
    return None


def extract_scalar(skill: Skill, slot_name: str, text: str) -> Any:
    owner = _arg_owner_command(skill, slot_name)
    fn = _EXTRACTORS.get((owner, slot_name)) or _EXTRACTORS.get((None, slot_name))
    return fn(text) if fn else None


# ── note-list construction (shared by the generic add_note filler and the
#    note-transform special fillers) ─────────────────────────────────────


def notes_from_names(text: str) -> list[dict[str, Any]]:
    """Explicit note names ('A1, C#2, E2') -> a simple, evenly-spaced note list.
    Timing/velocity aren't recoverable from the text (the corpus's own values
    for this case aren't derivable from the phrasing either — see README) so
    this uses a plain, documented default shape rather than guessing."""
    pitches = tu.parse_note_names(text)
    return [
        {"pitch": p, "start": round(i * 0.5, 3), "length": 0.5, "velocity": 90} for i, p in enumerate(pitches)
    ]


def fill_note_pattern_slot(skill: Skill, slot_name: str, text: str, default: Any) -> list[dict[str, Any]]:
    owner = _repeat_owner_command(skill, slot_name)
    if owner == "add_note":
        explicit = notes_from_names(text)
        if explicit:
            return explicit
    return default if default is not None else []


# ── generic slot filling ─────────────────────────────────────────────────


def _wants_midi_clip(skill: Skill) -> bool:
    return any(tc.command in ("add_note", "set_note", "quantize_notes") for tc in skill.template)


def fill_generic_slot(
    skill: Skill, slot_name: str, slot_type: str, default: Any, text: str, snapshot: dict[str, Any], filled: dict[str, Any]
) -> Any:
    if slot_name == "trackId":
        # deictic fallback ("arm it", "keep this take") — no track named in
        # the clause at all: fall back to whatever the snapshot says is
        # currently selected/focused, when it says anything.
        return resolve_track_id(text, snapshot) or snapshot.get("selectedTrackId")
    if slot_name == "clipId":
        track_id = filled.get("trackId") or resolve_track_id(text, snapshot) or snapshot.get("selectedTrackId")
        kind = "midi" if _wants_midi_clip(skill) else None
        return resolve_clip_for_track(snapshot, track_id, kind=kind) or snapshot.get("selectedClipId")
    if slot_type == "list<param>":
        return fill_note_pattern_slot(skill, slot_name, text, default)
    extracted = extract_scalar(skill, slot_name, text)
    return extracted if extracted is not None else default


def fill_generic(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    filled: dict[str, Any] = {}
    errors: list[str] = []
    for slot in skill.slots:
        if slot.source == "computed":
            continue  # generic skills (by construction) have none; guard anyway
        value = fill_generic_slot(skill, slot.name, slot.type, slot.default, text, snapshot, filled)
        if value is None and slot.required:
            errors.append(f"{skill.name}: could not fill required slot '{slot.name}' from {text!r}")
            continue
        if value is not None:
            filled[slot.name] = value
    return filled, errors


# ── special fillers (mirror mine.py's SEMANTIC_REFINERS families) ───────
# Matched structurally against the SKILL OBJECT (slot names/sources/types +
# template shape), not by name string — so a skill only gets special-cased
# because its shape genuinely needs computed values, the same reasoning
# mine.py used to decide it needed a refiner in the first place.


def _has_slot(skill: Skill, name: str, source: Optional[str] = None) -> bool:
    s = skill.slot(name)
    return s is not None and (source is None or s.source == source)


_GLUE_ITEM_FIELDS = frozenset({"index"})  # noteIndex glue — not a "content" field


def _repeat_command_and_keys(skill: Skill, over_slot: str) -> tuple[Optional[str], set[str]]:
    """(command, content-only item fields) for the command that repeats over
    `over_slot` — glue fields like the note index are excluded so callers can
    compare against just the fields that carry the transform's meaning."""
    for tc in skill.template:
        if tc.repeat_over == over_slot:
            keys = {v[1:-1].split(".", 1)[1] for v in tc.args.values() if isinstance(v, str) and v.startswith("{item.")}
            return tc.command, keys - _GLUE_ITEM_FIELDS
    return None, set()


def _is_transpose(skill: Skill) -> bool:
    if not (_has_slot(skill, "semitones") and _has_slot(skill, "sourceNotes", "computed")):
        return False
    cmd, keys = _repeat_command_and_keys(skill, "sourceNotes")
    return cmd == "set_note" and keys == {"pitch"}


def _is_crescendo(skill: Skill) -> bool:
    return _has_slot(skill, "startVelocity") and _has_slot(skill, "sourceNotes", "computed")


def _is_note_nudge(skill: Skill) -> bool:
    if not (_has_slot(skill, "amount") and _has_slot(skill, "sourceNotes", "computed")):
        return False
    cmd, keys = _repeat_command_and_keys(skill, "sourceNotes")
    return cmd == "set_note" and keys == {"start"}


def _is_layer(skill: Skill) -> bool:
    if not (_has_slot(skill, "semitones") and _has_slot(skill, "sourceNotes", "computed")):
        return False
    cmd, _ = _repeat_command_and_keys(skill, "sourceNotes")
    return cmd == "add_note"


def _is_harmonize(skill: Skill) -> bool:
    return _has_slot(skill, "intervals") and _has_slot(skill, "sourceNotes", "computed")


def _is_mute_except(skill: Skill) -> bool:
    return _has_slot(skill, "keepTrackIds") and _has_slot(skill, "targetTrackIds", "computed")


def _is_bus_family(skill: Skill) -> bool:
    return _has_slot(skill, "busIndex", "computed") or _has_slot(skill, "busIndices", "computed")


def _fill_transpose(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    track_id = resolve_track_id(text, snapshot)
    clip_id = resolve_clip_for_track(snapshot, track_id, kind="midi")
    errors = []
    if clip_id is None:
        errors.append(f"{skill.name}: could not resolve a MIDI clip from {text!r}")
        return {}, errors
    semitones = extract_signed_interval(text)
    if semitones is None:
        errors.append(f"{skill.name}: could not determine a transpose interval from {text!r}")
        return {}, errors
    notes = clip_notes(snapshot, clip_id)
    source = [{"index": i, "pitch": n["pitch"] + semitones} for i, n in enumerate(notes)]
    return {"clipId": clip_id, "semitones": semitones, "sourceNotes": source}, errors


def _fill_crescendo(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    track_id = resolve_track_id(text, snapshot)
    clip_id = resolve_clip_for_track(snapshot, track_id, kind="midi")
    if clip_id is None:
        return {}, [f"{skill.name}: could not resolve a MIDI clip from {text!r}"]
    start_v = skill.slot("startVelocity").default or 55
    end_v = skill.slot("endVelocity").default or 127
    notes = clip_notes(snapshot, clip_id)
    n = len(notes)
    if n <= 1:
        source = [{"index": i, "velocity": end_v} for i in range(n)]
    else:
        source = [
            {"index": i, "velocity": round(start_v + i * (end_v - start_v) / (n - 1))} for i in range(n)
        ]
    return {"clipId": clip_id, "startVelocity": start_v, "endVelocity": end_v, "sourceNotes": source}, []


def _fill_note_nudge(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    track_id = resolve_track_id(text, snapshot)
    clip_id = resolve_clip_for_track(snapshot, track_id, kind="midi")
    if clip_id is None:
        return {}, [f"{skill.name}: could not resolve a MIDI clip from {text!r}"]
    amount = tu.extract_percent(text)
    if amount is None:
        amount = 50.0
    notes = clip_notes(snapshot, clip_id)
    # Group notes into triples (matches the one demonstrated grid: 3
    # subdivisions/beat) and nudge every note that ISN'T the group's anchor
    # (index % 3 == 0) — a documented simplification, see README.
    source = []
    for i, n in enumerate(notes):
        if i % 3 == 0:
            continue
        # deterministic pseudo-jitter from (clipId, index) — no RNG, no clock
        seed = (hash((clip_id, i)) % 1000) / 1000.0
        jitter = (seed - 0.5) * 0.08 * (amount / 100.0)
        new_start = round(n["start"] + jitter + 0.1 * (amount / 100.0), 3)
        source.append({"index": i, "start": new_start})
    return {"clipId": clip_id, "amount": amount, "sourceNotes": source}, []


def _fill_layer(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    track_id = resolve_track_id(text, snapshot)
    clip_id = resolve_clip_for_track(snapshot, track_id, kind="midi")
    if clip_id is None:
        return {}, [f"{skill.name}: could not resolve a MIDI clip from {text!r}"]
    semitones = extract_signed_interval(text)
    if semitones is None:
        semitones = skill.slot("semitones").default or 12
    notes = clip_notes(snapshot, clip_id)
    source = [
        {"pitch": n["pitch"] + semitones, "start": n["start"], "length": n["length"], "velocity": n["velocity"]}
        for n in notes
    ]
    return {"clipId": clip_id, "semitones": semitones, "sourceNotes": source}, []


def _fill_harmonize(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    track_id = resolve_track_id(text, snapshot)
    clip_id = resolve_clip_for_track(snapshot, track_id, kind="midi")
    if clip_id is None:
        return {}, [f"{skill.name}: could not resolve a MIDI clip from {text!r}"]
    intervals = skill.slot("intervals").default or [4, 7]
    notes = clip_notes(snapshot, clip_id)
    source = []
    for n in notes:
        for iv in intervals:
            source.append(
                {
                    "pitch": n["pitch"] + iv,
                    "start": n["start"],
                    "length": n["length"],
                    "velocity": round(n["velocity"] * 0.85),
                }
            )
    return {"clipId": clip_id, "intervals": intervals, "sourceNotes": source}, []


def _fill_mute_except(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    keep = [t["id"] for t in find_track_mentions(text, snapshot)]
    target = [t["id"] for t in snapshot.get("tracks", []) if t["id"] not in keep]
    return {"keepTrackIds": keep, "targetTrackIds": [{"trackId": tid} for tid in target]}, []


def _fill_bus_family(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    if skill.slot("busIndices") is not None:  # one track -> many buses
        track_id = resolve_track_id(text, snapshot)
        if track_id is None:
            return {}, [f"{skill.name}: could not resolve a track from {text!r}"]
        names = extract_all_bus_type_names(text) or ["Reverb"]
        created_so_far = 0
        indices = []
        for name in names:
            existing = find_bus(snapshot, name)
            if existing is not None:
                indices.append(existing["index"])
            else:
                indices.append(next_bus_index(snapshot, created_so_far))
                created_so_far += 1
        return {
            "trackId": track_id,
            "busNames": [{"name": n} for n in names],
            "busIndices": [{"index": i} for i in indices],
        }, errors

    if skill.slot("trackIds") is not None:  # many tracks -> one bus
        tracks = find_track_mentions(text, snapshot)
        if not tracks:
            return {}, [f"{skill.name}: could not resolve any tracks from {text!r}"]
        bus_name = extract_bus_type_name(text) or "Reverb"
        existing = find_bus(snapshot, bus_name)
        bus_index = existing["index"] if existing else next_bus_index(snapshot)
        return {
            "busName": bus_name,
            "trackIds": [{"trackId": t["id"]} for t in tracks],
            "busIndex": bus_index,
        }, errors

    # one track -> one bus (route / adjust-level / remove)
    track_id = resolve_track_id(text, snapshot)
    if track_id is None:
        return {}, [f"{skill.name}: could not resolve a track from {text!r}"]
    bus_name = extract_bus_type_name(text) or skill.slot("busName").default or "Reverb"
    db = tu.extract_db(text)
    existing = find_bus(snapshot, bus_name)
    bus_index = existing["index"] if existing else next_bus_index(snapshot)
    filled: dict[str, Any] = {"trackId": track_id, "busName": bus_name, "busIndex": bus_index}
    if db is not None:
        filled["db"] = db
    return filled, errors


SPECIAL_FILLERS: list[tuple[Callable[[Skill], bool], Callable[[Skill, str, dict], tuple[dict, list[str]]]]] = [
    (_is_transpose, _fill_transpose),
    (_is_crescendo, _fill_crescendo),
    (_is_note_nudge, _fill_note_nudge),
    (_is_layer, _fill_layer),
    (_is_harmonize, _fill_harmonize),
    (_is_mute_except, _fill_mute_except),
    (_is_bus_family, _fill_bus_family),
]


def fill_slots(skill: Skill, text: str, snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    for matches, filler in SPECIAL_FILLERS:
        if matches(skill):
            return filler(skill, text, snapshot)
    return fill_generic(skill, text, snapshot)


# ── template expansion + command emission ───────────────────────────────


def _substitute(args_template: dict[str, Any], filled: dict[str, Any], item: Optional[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in args_template.items():
        if isinstance(v, str) and v.startswith("{") and v.endswith("}"):
            placeholder = v[1:-1]
            if placeholder.startswith("item."):
                field_name = placeholder.split(".", 1)[1]
                if item is None or field_name not in item or item[field_name] is None:
                    continue
                out[k] = item[field_name]
            else:
                value = filled.get(placeholder)
                if value is None:
                    continue
                out[k] = value
        else:
            out[k] = v
    return out


def expand_template(skill: Skill, filled: dict[str, Any], snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    commands: list[dict[str, Any]] = []
    for tc in skill.template:
        if tc.emit_if is not None:
            predicate = dict(tc.emit_if)
            name_slot = predicate.get("name_slot")
            resolved: dict[str, Any] = dict(filled)
            if name_slot and name_slot.startswith("item."):
                # emit_if inside a repeat body is evaluated per-item below instead
                pass
            elif not eval_predicate(predicate, snapshot, resolved):
                continue
        if tc.repeat_over:
            items = filled.get(tc.repeat_over) or []
            for item in items:
                if tc.emit_if is not None:
                    name_slot = tc.emit_if.get("name_slot", "")
                    if name_slot.startswith("item."):
                        field_name = name_slot.split(".", 1)[1]
                        probe = {**filled, "__item_value__": item.get(field_name)}
                        pred = dict(tc.emit_if, name_slot="__item_value__")
                        if not eval_predicate(pred, snapshot, probe):
                            continue
                args = _substitute(tc.args, filled, item)
                commands.append({"command": tc.command, "args": args})
        else:
            args = _substitute(tc.args, filled, None)
            commands.append({"command": tc.command, "args": args})
    return commands


def validate_commands(commands: list[dict[str, Any]], catalog: mc.Catalog) -> list[str]:
    errors = []
    for c in commands:
        err = mc.validate_command(c["command"], c["args"], catalog)
        if err:
            errors.append(err)
    return errors


# ── top-level routing (with a light conjunction-based composer) ─────────


@dataclass
class RouteResult:
    skill_names: tuple[str, ...]
    commands: list[dict[str, Any]]
    errors: list[str]

    @property
    def ok(self) -> bool:
        return bool(self.commands) and not self.errors


def route_single(
    task_text: str, snapshot: dict[str, Any], skills: list[Skill], catalog: Optional[mc.Catalog] = None
) -> RouteResult:
    skill = select_skill(task_text, skills)
    if skill is None:
        return RouteResult((), [], [f"no skill matched: {task_text!r}"])
    filled, errors = fill_slots(skill, task_text, snapshot)
    if errors:
        return RouteResult((skill.name,), [], errors)
    unmet = [p for p in skill.preconditions if not eval_predicate(p, snapshot, filled)]
    if unmet:
        return RouteResult((skill.name,), [], [f"{skill.name}: precondition failed: {p}" for p in unmet])
    commands = expand_template(skill, filled, snapshot)
    catalog = catalog if catalog is not None else mc.load_catalog()
    cmd_errors = validate_commands(commands, catalog)
    if cmd_errors:
        return RouteResult((skill.name,), [], cmd_errors)
    return RouteResult((skill.name,), commands, [])


_CONJUNCTION_RE = re.compile(r"\s*(?:,\s*and\s+|\s+and\s+|;\s*|,\s*then\s+)\s*", re.IGNORECASE)


def route(
    task_text: str,
    snapshot: dict[str, Any],
    skills: list[Skill],
    catalog: Optional[mc.Catalog] = None,
    max_chain: int = 3,
) -> RouteResult:
    """Whole text as one skill, AND (whenever there's a conjunction) chained
    per-clause routing — then pick whichever actually covers the sentence.

    Composing isn't only a fallback for when the whole-text match fails: a
    compound sentence like "solo the drums and set the tempo to 90" can
    still score well enough against a single skill (e.g. "set-tempo", which
    only needs a bpm number and doesn't care what else is in the sentence)
    to "succeed" while silently dropping the other clause. So both are
    always computed when there's a conjunction, and the composed result
    wins only when it demonstrably covers MORE of the sentence: it resolves
    to 2+ distinct skills (i.e. the split actually found separate intents,
    not just a listy single intent like "mute everything but the drums and
    bass") and yields at least as many commands as the whole-text attempt.
    Otherwise the whole-text match — which is right for exactly those listy
    cases — wins.
    """
    catalog = catalog if catalog is not None else mc.load_catalog()
    whole = route_single(task_text, snapshot, skills, catalog)
    clauses = [c.strip() for c in _CONJUNCTION_RE.split(task_text) if c.strip()]

    if whole.ok:
        matched = next((s for s in skills if s.name == whole.skill_names[0]), None)
        if matched is not None:
            triggers = set(matched.triggers)
            # Case 1: the matched skill's ENTIRE trigger vocabulary exactly
            # equals the query's tokens (not just overlaps it) — a complete
            # match, not a partial one. This is what "arm the vocal and
            # start recording" looks like: that's literally
            # arm-track-set-transport's own mined provenance text.
            if triggers == set(tu.tokenize(task_text)):
                return whole
            # Case 2: the sentence has a conjunction, but the matched skill's
            # triggers demonstrably draw from EVERY clause (not just one) —
            # e.g. assign-sample matching "...on note 48 AND make it melodic
            # so it follows the keyboard" uses "note"/"track" from the first
            # half and "melodic"/"keyboard" from the second, so it's already
            # using the whole sentence, not silently ignoring half of it (the
            # "set-tempo" in "solo the drums and set the tempo to 90" failure
            # mode this whole function exists to catch).
            if len(clauses) >= 2 and all(triggers & set(tu.tokenize(c)) for c in clauses):
                return whole
    # A clause with < 2 content tokens (e.g. the "bass" in "mute everything
    # but the drums and bass") isn't an independent clause at all — it's the
    # tail of a list inside ONE intent, and would otherwise be free to match
    # any skill whose trigger bag happens to contain that one word. Requiring
    # every clause to clear this bar, AND every one of them to independently
    # route clean, is what keeps composition from firing on listy sentences.
    substantial = [c for c in clauses[:max_chain] if len(tu.tokenize(c)) >= 2]
    composed: Optional[RouteResult] = None
    if len(substantial) >= 2:
        names: list[str] = []
        commands: list[dict[str, Any]] = []
        all_ok = True
        for clause in substantial:
            r = route_single(clause, snapshot, skills, catalog)
            if r.ok:
                names.extend(r.skill_names)
                commands.extend(r.commands)
            else:
                all_ok = False
                break
        if all_ok and commands:
            composed = RouteResult(tuple(names), commands, [])

    if composed is not None and len(set(composed.skill_names)) >= 2 and len(composed.commands) >= len(whole.commands):
        return composed
    if whole.ok:
        return whole
    if composed is not None:
        return composed
    return whole
