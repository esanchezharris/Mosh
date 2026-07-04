"""§9 Recipe → MoshOps command list (the data half — pure, JUCE-clean, golden-testable).

Emits commands in dependency order: meta → tracks → content → (mix). Each new track
captures its engine-assigned `trackId` into a `${T<i>}` variable (the `--run-script`
capture mechanism), so later commands reference ids without hard-coding them.

v1 compiles only the UNAMBIGUOUS mappings and records everything engine-dependent in
`unresolved` (honest graceful degradation, per the spec):
- compiled now: set_tempo/set_key/set_time_signature, create_track, import_clip
  (a matched owned sample), add_midi_clip (the clip container)
- deferred to execute (needs the engine): synth plugin load + param-index mapping
  (names→indices via the loaded plugin), MIDI-note emission (parse midi_ref → add_note),
  the Tier-B render-layer fallback for unavailable patches.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional

DRUM_ROLES = {"kick", "snare", "hat", "clap", "perc", "808"}
DEFAULT_CLIP_LEN_S = 8.0
HEADROOM_TRIM_DB = -4.5  # per-track static trim (mix stage) — see compile_recipe


@dataclass
class CompileResult:
    commands: list[dict] = field(default_factory=list)
    unresolved: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"commands": self.commands, "unresolved": self.unresolved}


def _u(issue: str, element_id: Optional[str], action: str) -> dict:
    return {"issue": issue, "element_id": element_id, "suggested_action": action}


def _num(v: Any) -> Optional[float]:
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v))
    except (TypeError, ValueError):
        return None


def _parse_key(value: str) -> Optional[tuple[str, str]]:
    # "F# minor" → ("F#", "minor"); "C" → ("C", "major"); unparseable → None
    parts = str(value).strip().split()
    if not parts:
        return None
    tonic = parts[0]
    if not tonic or tonic[0].upper() not in "ABCDEFG":
        return None
    mode = parts[1].lower() if len(parts) > 1 else "major"
    return tonic, mode


def _parse_time_sig(value: str) -> Optional[tuple[int, int]]:
    s = str(value).strip()
    if "/" not in s:
        return None
    a, b = s.split("/", 1)
    try:
        return int(a), int(b)
    except ValueError:
        return None


MELODIC_BASS_ROLES = {"808", "bass"}


def _is_melodic_bass(role: str, has_inline: bool) -> bool:
    # An 808/bass element with an inline note phrase is a *pitched, MIDI-triggered* voice
    # (repitched one-shot or synth), NOT a percussion pad — the whole point of the restart.
    return role in MELODIC_BASS_ROLES and has_inline


def _track_type(role: str, melodic_bass: bool, midi_driven: bool) -> str:
    # melodic 808/bass + every non-drum role → audio (sampler/synth). A drum role is a DRUM
    # track only when MIDI-triggered (a kit/pad); a drum sample placed as raw audio one-shots
    # (no MIDI) is an audio track — preserves the §7 timeline-placement behavior.
    if melodic_bass or role not in DRUM_ROLES:
        return "audio"
    return "drum" if midi_driven else "audio"


def _notes_payload(notes) -> list[dict]:
    """recipe NoteEvents → add_midi_clip inline-note dicts ({pitch,start,length,velocity},
    beats) — the format cmdAddMidiClip / read_midi already speak."""
    return [{"pitch": int(n.pitch), "start": round(float(n.start_beats), 6),
             "length": round(float(n.duration_beats), 6), "velocity": int(n.velocity)}
            for n in notes]


_BAR_BEATS = 4.0          # 4/4 — every current recipe; revisit with time-sig support
_BAR_TOL = 0.25           # a note ending a hair past the bar line doesn't add a bar


def _whole_bars(end_beats: float) -> float:
    """end-of-phrase → whole-bar length (≥1 bar, small tolerance for sloppy tails)."""
    return max(_BAR_BEATS, math.ceil((end_beats - _BAR_TOL) / _BAR_BEATS) * _BAR_BEATS)


def _arrangement_beats(recipe) -> Optional[float]:
    """The recipe's arrangement length = the LONGEST element's phrase in whole bars."""
    ends = [max(float(n.start_beats) + float(n.duration_beats) for n in el.midi.notes)
            for el in recipe.elements if el.midi.notes]
    return _whole_bars(max(ends)) if ends else None


def _tile_period(pattern_beats: float, target_beats: float) -> float:
    """Tiling period: the smallest whole-bar length ≥ the phrase that DIVIDES the
    target with ≥2 repetitions, so every cycle is identical and the final bars sound
    like every other cycle (owner pack-005, dictated: 'drum sounds trail off before
    the pattern loops' — a non-dividing phrase, e.g. 3 bars under 8, used to end in a
    mid-phrase truncated stub). No divisor ≤ target/2 → the phrase's own length
    (status-quo truncation, still better than a mostly-silent single placement)."""
    p = pattern_beats
    while p <= target_beats / 2 + 1e-6:
        ratio = target_beats / p
        if abs(ratio - round(ratio)) < 1e-6:
            return p
        p += _BAR_BEATS
    return pattern_beats


def _tile_notes(notes, target_beats: Optional[float]):
    """Loop an element's pattern out to the arrangement length (owner audition round 3:
    'the composition kind of trails off towards the end like parts drop out' — 2-bar seed
    drum motifs were placed ONCE under 4-bar pads/808s, so the drums quit halfway in every
    beat). The pattern repeats at a whole-bar period that divides the target (see
    _tile_period); copies keep the phrase's internal timing; a copy's note is dropped
    only if it would START past the target."""
    if not notes or not target_beats:
        return notes
    pattern = _tile_period(
        _whole_bars(max(float(n.start_beats) + float(n.duration_beats) for n in notes)),
        target_beats)
    if pattern >= target_beats:
        return notes
    out = []
    k = 0
    while k * pattern < target_beats - 1e-6:
        off = k * pattern
        for n in notes:
            if off + float(n.start_beats) < target_beats - 1e-6:
                out.append(n.model_copy(update={"start_beats": off + float(n.start_beats)}))
        k += 1
    return out


def _clip_len_s(notes, tempo: Optional[float]) -> float:
    """Clip container length in SECONDS, sized to hold the note phrase (notes are in beats;
    the clip is placed/length-ed in seconds, matching the proven execute path)."""
    if not notes:
        return DEFAULT_CLIP_LEN_S
    end_beats = max(float(n.start_beats) + float(n.duration_beats) for n in notes)
    spb = 60.0 / (tempo or 120.0)
    return max(1.0, round(end_beats * spb, 4))


def _common_pitch(notes) -> int:
    """The drum pad's note: the pitch the element's hits actually trigger (so assign_sample's
    single-note pad matches the MIDI). Most-common, deterministic tie-break = lowest."""
    counts: dict[int, int] = {}
    for n in notes:
        counts[int(n.pitch)] = counts.get(int(n.pitch), 0) + 1
    return min(counts, key=lambda p: (-counts[p], p)) if counts else 36


def _root_pitch(notes) -> int:
    """The melodic sampler's root note: the lowest pitch in the phrase, so the bass sits in
    register and higher notes repitch UP (avoids extreme down-pitch artifacts)."""
    return min((int(n.pitch) for n in notes), default=36)


def _sampler_root(el, notes, fallback) -> int:
    """The sampler's `note` must be the SAMPLE'S true pitch (match.root_note) — the engine
    treats `note` as the pitch at which the file plays as-is, so MIDI repitches relative to
    it. A phrase-derived root only when the match carries no root (then rendered pitch is
    off by sample-vs-root delta — flagged unresolved upstream; 2026-07 out-of-key audit)."""
    rn = getattr(el.sample_match, "root_note", None)
    return int(rn) if rn is not None else fallback(notes)


def _center_pitch(notes) -> int:
    """A melodic (non-bass) sampler's root: the phrase's median pitch, so chords/melodies
    repitch modestly in both directions instead of stretching far from one extreme."""
    ps = sorted(int(n.pitch) for n in notes)
    return ps[len(ps) // 2] if ps else 60


def compile_recipe(recipe) -> CompileResult:
    """Compile a §0 Recipe (recipe.Recipe) into a full, inline MoshOps program + unresolved.

    v2 (the real-recipes restart) emits the MUSICAL BODY inline: each element's
    `midi.notes` become an `add_midi_clip` with an inline `notes` array (no external .mid
    round-trip). Sound binding:
      * drum role + matched sample + notes → assign_sample(mode="drum") then add_midi_clip
      * 808/bass + notes → assign_sample(mode="melodic", root=lowest pitch) then add_midi_clip
        (a real, repitched, MIDI-triggered bass — NOT a percussion pad)
      * melodic synth element → add_midi_clip(notes); the plugin load/param map is still
        resolved at execute (needs the engine).
    assign_sample ALWAYS precedes add_midi_clip so the sampler is present and the clip's
    default-instrument auto-load (4OSC / stock kit) is skipped — no doubled/duplicated voice.
    Back-compat paths (matched sample + `onsets` but no inline notes → import_clip; `midi_ref`
    only → deferred note parse) are preserved for §7 extraction recipes."""
    out = CompileResult()
    add, defer = out.commands.append, out.unresolved.append

    # ── meta ──────────────────────────────────────────────────────────────────
    m = recipe.meta
    tempo = _num(m.tempo_bpm.value)
    if tempo is not None:
        add({"command": "set_tempo", "args": {"bpm": tempo}})
    if m.key.value:
        parsed = _parse_key(m.key.value)
        if parsed:
            add({"command": "set_key", "args": {"tonic": parsed[0], "mode": parsed[1]}})
        else:
            defer(_u(f"unparseable key {m.key.value!r}", None, "set key manually"))
    if m.time_signature.value:
        ts = _parse_time_sig(m.time_signature.value)
        if ts:
            add({"command": "set_time_signature", "args": {"numerator": ts[0], "denominator": ts[1]}})
        else:
            defer(_u(f"unparseable time signature {m.time_signature.value!r}", None, "set sig manually"))

    # ── elements ────────────────────────────────────────────────────────────────
    arr_beats = _arrangement_beats(recipe)
    for i, el in enumerate(recipe.elements):
        tvar = f"T{i}"
        role = el.role.value
        notes = _tile_notes(list(el.midi.notes), arr_beats)
        has_inline = bool(notes)
        has_ref_midi = el.midi.status in ("extracted", "partial") and bool(el.midi.midi_ref)
        matched = el.sample_match.status == "matched" and bool(el.sample_match.matched_path)
        melodic_bass = _is_melodic_bass(role, has_inline)
        is_drum = role in DRUM_ROLES and not melodic_bass

        add({"command": "create_track",
             "args": {"name": el.label or role,
                      "type": _track_type(role, melodic_bass, has_inline or has_ref_midi)},
             "capture": {tvar: "trackId"}})
        tref = f"${{{tvar}}}"
        placed = False

        if has_inline:
            cvar = f"C{i}"
            # bind the real sound BEFORE the clip (so the default-instrument auto-load is a no-op).
            if matched and is_drum:
                add({"command": "assign_sample",
                     "args": {"trackId": tref, "note": _common_pitch(notes), "mode": "drum",
                              "file": el.sample_match.matched_path}})
            elif melodic_bass and matched:
                add({"command": "assign_sample",
                     "args": {"trackId": tref, "note": _sampler_root(el, notes, _root_pitch), "mode": "melodic",
                              "file": el.sample_match.matched_path}})
            elif melodic_bass and not matched:
                defer(_u("808/bass has notes but no matched sample — falls back to 4OSC",
                         el.element_id, "match an 808 one-shot in the palette for a real sub"))
            elif matched:
                # melodic non-bass (pad/lead/pluck): the SAME repitched-sampler path as the
                # 808 — real sound instead of the stock 4OSC sine patch (2026-07 fix).
                add({"command": "assign_sample",
                     "args": {"trackId": tref, "note": _sampler_root(el, notes, _center_pitch), "mode": "melodic",
                              "file": el.sample_match.matched_path}})
            elif role in ("pad", "lead", "pluck"):
                defer(_u("melodic element has no bound sample — plays the stock synth patch",
                         el.element_id, "bind a palette 'melodic' one-shot"))
            add({"command": "add_midi_clip",
                 "args": {"trackId": tref, "start": 0, "length": _clip_len_s(notes, tempo),
                          "name": el.label or role, "notes": _notes_payload(notes)},
                 "capture": {cvar: "clipId"}})
            placed = True

        # back-compat: matched sample placed as audio one-shot(s) at onset times (§7 slices)
        elif matched:
            onsets = list(el.onsets) if el.onsets else [0.0]
            for t in onsets:
                add({"command": "import_clip",
                     "args": {"file": el.sample_match.matched_path, "trackId": tref,
                              "startSeconds": round(float(t), 4)}})
            placed = True

        # back-compat: only an external midi_ref → emit the container, defer note parse to execute
        elif has_ref_midi:
            cvar = f"C{i}"
            add({"command": "add_midi_clip",
                 "args": {"trackId": tref, "start": 0, "length": DEFAULT_CLIP_LEN_S},
                 "capture": {cvar: "clipId"}})
            defer(_u(f"MIDI notes in {el.midi.midi_ref} not yet compiled",
                     el.element_id, f"parse {el.midi.midi_ref} → notes on ${{{cvar}}}"))
            placed = True

        # synth patch: loading + param mapping needs the engine (plugin id + param indices).
        # Applies to a melodic synth element (has inline notes + a named plugin).
        sp = el.synth_patch
        if sp.status in ("params_visible", "matched", "substituted") and sp.plugin.name:
            defer(_u(f"load synth '{sp.plugin.name}' + {len(sp.params)} param(s) on {tref}",
                     el.element_id,
                     "execute: resolve plugin id via list_plugins, map param names→indices via the loaded plugin"))
        elif sp.status in ("unavailable", "unknown") and not placed:
            defer(_u("no sample/patch — Tier-B render-layer fallback", el.element_id,
                     "execute: create_render_layer + set_render_param on a placeholder clip"))
        elif not placed and not sp.plugin.name:
            # chained (elif) so an unplaced element gets exactly ONE deferral, never both this
            # and the Tier-B fallback above.
            defer(_u("element has no compilable content", el.element_id,
                     "fill sample_match / midi / synth_patch"))

    # ── mix stage: static headroom trim ──────────────────────────────────────────
    # Full-scale one-shots stacked across 4-6 tracks clip the master hard (audit measured
    # 7.4% clipped samples on a 6-track render). A flat −4.5 dB per track buys ~the same
    # headroom a producer's first gain-staging pass would; deterministic, undo-friendly.
    for i, el in enumerate(recipe.elements):
        add({"command": "set_track_volume", "args": {"trackId": f"${{T{i}}}", "db": HEADROOM_TRIM_DB}})

    return out
