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
import wave
from dataclasses import dataclass, field
from typing import Any, Optional

DRUM_ROLES = {"kick", "snare", "hat", "clap", "perc", "808"}
DEFAULT_CLIP_LEN_S = 8.0

# ── mix-stage headroom (2026-09-24 recipe-hygiene fix, reworked 2026-09-24) ──────────
# The old flat HEADROOM_TRIM_DB = -4.5 (2026-07 clipping audit) was proven insufficient by
# the 2026-09-23 investor-demo-prep run: recipe-probe/summary.json measured 4-5 of 6
# generated seeds peaking at exactly 0.0 dBFS (hard clipping). Two DISTINCT causes, two
# distinct fixes:
#
# 1) A single track firing many simultaneous MIDI notes onto the same one-shot
#    (assign_sample's drum mode triggers the identical sample for every note regardless of
#    pitch — seed 4's "hat" element fired 14 overlapping voices at beat 0). This is an
#    EXTRACTION ARTIFACT, not musical content — a chord-shaped MIDI blob mis-read as N
#    simultaneous drum hits — so the root fix is `_dedupe_drum_onsets`: collapse notes that
#    land at the same onset (within a tiny epsilon) into ONE, keeping the loudest velocity.
#    (A first attempt compensated with a per-track -20*log10(polyphony) volume cut instead;
#    that punished the DURATION-based overlap of a merely HELD note, not just true
#    coincident onsets, and made ordinary hi-hats ~23 dB quieter at every other hit —
#    reverted.)
# 2) Several tracks' one-shots genuinely landing together (kick+hat+808 on one downbeat) —
#    real, not an artifact, and only a render can say how hot it actually gets. So
#    `_predict_peak_at_0db` reads the ACTUAL palette one-shot bytes the compiled
#    `assign_sample` commands reference and sums them at the compiled note positions/
#    velocities at 0 dB gain — a real measurement, not a formula — and the ONE per-recipe
#    trim is `min(HEADROOM_TRIM_DB, TARGET_PEAK_DB - predicted_peak)`: HEADROOM_TRIM_DB is
#    the loudest any recipe ever gets (matches balance.py's own flat first-pass baseline —
#    unchanged, so nothing there needs rescaling), and a hot recipe gets cut further, just
#    enough to land at TARGET_PEAK_DB. A quiet recipe (predicted_peak already under target)
#    keeps the −4.5 dB baseline rather than being pushed artificially louder. If the sample
#    files can't be read (missing palette, unreadable format — this machine's `generate_
#    beat_recipe` always HAS the palette, but the compiler must still degrade honestly),
#    FALLBACK_MARGIN_DB adds a small, documented hedge instead of guessing a worst case.
HEADROOM_TRIM_DB = -4.5          # the loudest any recipe track gets; mirrors balance.py's
TARGET_PEAK_DB = -3.0            # goal ceiling for a MEASURED hot recipe's summed-mix peak
FALLBACK_MARGIN_DB = -2.0        # can't measure (no palette) → this modest extra hedge,
                                  # not a worst-case crush — see the module note above

# ── track/clip display names (2026-09-24 recipe-hygiene fix) ─────────────────────────
# The recipe library's `Element.label` is the SOURCE recording's own metadata (an artist
# name, an FL project filename, an explicit word) — useful for provenance/debugging, never
# for an on-screen name. The 2026-09-23 demo-prep run found these verbatim on track headers,
# e.g. "skrill · kick friendly trsut beno #2 (kick)". Track/clip names are now derived ONLY
# from the element's ROLE (the controlled vocabulary in recipe.Role), never from `label`.
ROLE_DISPLAY_NAMES = {
    "kick": "Kick", "snare": "Snare", "hat": "Hats", "clap": "Clap", "perc": "Perc",
    "808": "808", "bass": "Bass", "lead": "Melody", "pad": "Chords", "pluck": "Pluck",
    "fx": "FX", "vocal": "Vocal", "other": "Other",
}


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


def _role_display_name(role: str, seen: dict[str, int]) -> str:
    """A user-visible track/clip name derived ONLY from the element's role — never the
    library recipe's source `label` (see the module comment above ROLE_DISPLAY_NAMES).
    `seen` counts prior uses of the same display name IN THIS RECIPE so a genuine same-role
    repeat (e.g. two "hat" elements from a drum fill) reads "Hats", "Hats 2", ... — never a
    silent on-screen collision. An out-of-vocabulary role (future Role addition) falls back
    to a capitalized version of the role string rather than ever showing raw `label` text."""
    base = ROLE_DISPLAY_NAMES.get(role) or (role.capitalize() if role else "Track")
    seen[base] = seen.get(base, 0) + 1
    return base if seen[base] == 1 else f"{base} {seen[base]}"


_ONSET_EPSILON_BEATS = 1e-6   # "the same instant", not a musical grid tolerance — a real
                              # 16th-note roll (0.25 beat apart) must NOT be touched


def _dedupe_drum_onsets(notes, epsilon: float = _ONSET_EPSILON_BEATS) -> list:
    """A drum-mode one-shot track (`assign_sample(mode="drum")`) triggers the IDENTICAL
    sample for every note regardless of pitch, so several notes landing at the exact same
    onset are not N real hits — they're an extraction artifact (a chord-shaped MIDI blob
    mis-read as N simultaneous drum hits; seed 4's "hat" element fires 14 different pitches
    at beat 0 onto one hi-hat sample). Collapse each coincident-onset group into ONE note,
    keeping the loudest (max velocity) — never a duration-based overlap test: a one-shot's
    audible length is the SAMPLE's own length, not the MIDI note's `duration_beats`, so a
    held note must not be treated as "overlapping" everything that starts during its
    nominal duration (that was the first attempt's bug — it made ordinary hi-hats ~23 dB
    quieter at every other hit). Preserves input order otherwise; a note a grid tick away
    (e.g. a genuine 16th-note roll) is untouched."""
    if not notes:
        return notes
    by_onset: dict[int, Any] = {}
    order: list[int] = []
    for n in notes:
        key = round(float(n.start_beats) / epsilon)
        winner = by_onset.get(key)
        if winner is None:
            by_onset[key] = n
            order.append(key)
        elif int(n.velocity) > int(winner.velocity):
            by_onset[key] = n
    return [by_onset[k] for k in order]


_MIX_SAMPLE_RATE = 44100.0


def _read_wav_mono(path: str, np_mod) -> Any:
    """A palette one-shot's samples as a mono numpy float array in [-1, 1] (16- or 24-bit
    PCM — the palette's own format). Header/frame reads are stdlib `wave`; the byte→sample
    decode and stereo downmix are vectorized numpy, not a per-sample Python loop (a
    per-sample loop over a whole recipe's notes measured 1-3.5 SECONDS per compile — far too
    slow for a command that otherwise runs in ~2s; the vectorized version is milliseconds)."""
    with wave.open(path, "rb") as w:
        n, sample_width, channels = w.getnframes(), w.getsampwidth(), w.getnchannels()
        data = w.readframes(n)
    if sample_width == 3:
        raw = np_mod.frombuffer(data, dtype=np_mod.uint8).reshape(-1, 3)
        as_int = (raw[:, 0].astype(np_mod.int32) | (raw[:, 1].astype(np_mod.int32) << 8)
                  | (raw[:, 2].astype(np_mod.int32) << 16))
        as_int = np_mod.where(as_int & 0x800000, as_int - 0x1000000, as_int)
        vals = as_int.astype(np_mod.float64) / 8388608.0
    elif sample_width == 2:
        vals = np_mod.frombuffer(data, dtype="<i2").astype(np_mod.float64) / 32768.0
    else:
        raise ValueError(f"unsupported sample width {sample_width} in {path!r}")
    if channels > 1:
        return vals.reshape(-1, channels).mean(axis=1)
    return vals


def _predict_peak_at_0db(commands: list[dict], tempo: Optional[float]) -> Optional[float]:
    """A REAL measurement of the mix this recipe will produce, at 0 dB (no per-track trim):
    reads the ACTUAL palette one-shot audio the already-compiled `assign_sample` commands
    reference, and sums it at the compiled `add_midi_clip` note positions, scaled by each
    note's own velocity — the same arithmetic a render would show, without an engine.
    Returns the summed-mix peak in dBFS, or None if numpy is unavailable, or not one track's
    sample file could be read (missing palette, unreadable format, ...) — callers must fall
    back to a fixed, documented margin rather than pretending a number this couldn't back
    up. A melodic element with no matched sample (plays the stock 4OSC synth) has no PCM to
    read and is correctly excluded — there's nothing to measure, not a failure to measure."""
    file_by_track = {c["args"]["trackId"]: c["args"]["file"]
                      for c in commands if c["command"] == "assign_sample"}
    if not file_by_track:
        return None
    try:
        import numpy as np
    except ImportError:
        return None
    spb = 60.0 / float(tempo or 120.0)

    # pass 1: every (sample array, start index, velocity gain) triple, and the buffer length
    # needed — ONE allocation, not a Python list that regrows per note.
    placements: list[tuple[Any, int, float]] = []
    sample_cache: dict[str, Any] = {}
    end = 0
    for c in commands:
        if c["command"] != "add_midi_clip":
            continue
        fpath = file_by_track.get(c["args"]["trackId"])
        if not fpath:
            continue
        if fpath not in sample_cache:
            try:
                sample_cache[fpath] = _read_wav_mono(fpath, np)
            except (OSError, wave.Error, ValueError):
                sample_cache[fpath] = None
        samp = sample_cache[fpath]
        if samp is None or len(samp) == 0:
            continue
        for note in c["args"].get("notes", []):
            start_i = int(round(float(note["start"]) * spb * _MIX_SAMPLE_RATE))
            vel_gain = max(1, min(127, int(note.get("velocity", 100)))) / 127.0
            placements.append((samp, start_i, vel_gain))
            end = max(end, start_i + len(samp))
    if not placements:
        return None

    # pass 2: one vectorized add per placement (not per sample).
    mix = np.zeros(end, dtype=np.float64)
    for samp, start_i, vel_gain in placements:
        mix[start_i:start_i + len(samp)] += samp * vel_gain
    peak = float(np.abs(mix).max()) if mix.size else 0.0
    return 20.0 * math.log10(peak) if peak > 0 else float("-inf")


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
    seen_names: dict[str, int] = {}
    for i, el in enumerate(recipe.elements):
        tvar = f"T{i}"
        role = el.role.value
        notes = _tile_notes(list(el.midi.notes), arr_beats)
        has_inline = bool(notes)
        has_ref_midi = el.midi.status in ("extracted", "partial") and bool(el.midi.midi_ref)
        matched = el.sample_match.status == "matched" and bool(el.sample_match.matched_path)
        melodic_bass = _is_melodic_bass(role, has_inline)
        is_drum = role in DRUM_ROLES and not melodic_bass
        display_name = _role_display_name(role, seen_names)

        add({"command": "create_track",
             "args": {"name": display_name,
                      "type": _track_type(role, melodic_bass, has_inline or has_ref_midi)},
             "capture": {tvar: "trackId"}})
        tref = f"${{{tvar}}}"
        placed = False

        if has_inline:
            cvar = f"C{i}"
            # bind the real sound BEFORE the clip (so the default-instrument auto-load is a no-op).
            if matched and is_drum:
                # every pitch here triggers the SAME one-shot (mode="drum") — collapse a
                # coincident-onset pile-up (an extraction artifact) into one hit each; see
                # _dedupe_drum_onsets. Only this branch dedupes: a melodic branch's distinct
                # pitches are real, distinct musical content, never collapsed.
                notes = _dedupe_drum_onsets(notes)
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
                          "name": display_name, "notes": _notes_payload(notes)},
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

    # ── mix stage: one uniform, measured headroom trim ────────────────────────────
    # See the HEADROOM_TRIM_DB block near the top of this module for the full derivation.
    # ONE trim for the whole recipe (every track gets the same dB — the relative balance the
    # elements were authored with is untouched): HEADROOM_TRIM_DB is the loudest a recipe
    # ever gets; a recipe whose REAL predicted peak would exceed TARGET_PEAK_DB gets cut
    # further, by exactly enough to land there.
    predicted_peak_db = _predict_peak_at_0db(out.commands, tempo)
    if predicted_peak_db is not None and predicted_peak_db != float("-inf"):
        trim_db = min(HEADROOM_TRIM_DB, TARGET_PEAK_DB - predicted_peak_db)
    else:
        trim_db = HEADROOM_TRIM_DB + FALLBACK_MARGIN_DB
    # 4 decimals: a 2-decimal round can drift the realized peak up to ~0.005 dB past
    # TARGET_PEAK_DB when it's the binding branch — negligible for a mix, but avoids ever
    # reporting a number technically over the ceiling this same call just computed.
    trim_db = round(trim_db, 4)
    for i in range(len(recipe.elements)):
        add({"command": "set_track_volume", "args": {"trackId": f"${{T{i}}}", "db": trim_db}})

    return out
