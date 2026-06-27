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

from dataclasses import dataclass, field
from typing import Any, Optional

DRUM_ROLES = {"kick", "snare", "hat", "clap", "perc", "808"}
DEFAULT_CLIP_LEN_S = 8.0


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


def _track_type(role: str, has_midi: bool) -> str:
    # A MIDI-triggered drum element wants a drum track (audible default sampler); a placed
    # audio one-shot or a melodic element is an audio track.
    return "drum" if (has_midi and role in DRUM_ROLES) else "audio"


def compile_recipe(recipe) -> CompileResult:
    """Compile a §0 Recipe (recipe.Recipe) into commands + unresolved deferrals."""
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
    for i, el in enumerate(recipe.elements):
        tvar = f"T{i}"
        role = el.role.value
        has_midi = el.midi.status in ("extracted", "partial") and bool(el.midi.midi_ref)
        add({"command": "create_track",
             "args": {"name": el.label or role, "type": _track_type(role, has_midi)},
             "capture": {tvar: "trackId"}})
        tref = f"${{{tvar}}}"
        placed = False

        # matched owned sample → place it as an audio clip (the one fully-clean content map).
        # onsets present → one clip per fire time on this single track (faithful timeline,
        # e.g. a §7 drum-slice group); empty → a single placement at 0 (back-compat).
        if el.sample_match.status == "matched" and el.sample_match.matched_path:
            onsets = list(el.onsets) if el.onsets else [0.0]
            for t in onsets:
                add({"command": "import_clip",
                     "args": {"file": el.sample_match.matched_path, "trackId": tref,
                              "startSeconds": round(float(t), 4)}})
            placed = True

        # MIDI: emit the clip container now; the notes (in midi_ref) are parsed at execute
        if has_midi:
            cvar = f"C{i}"
            add({"command": "add_midi_clip",
                 "args": {"trackId": tref, "start": 0, "length": DEFAULT_CLIP_LEN_S},
                 "capture": {cvar: "clipId"}})
            defer(_u(f"MIDI notes in {el.midi.midi_ref} not yet compiled",
                     el.element_id, f"parse {el.midi.midi_ref} → add_note×N onto ${{{cvar}}}"))
            placed = True

        # synth patch: loading + param mapping needs the engine (plugin id + param indices)
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

    return out
