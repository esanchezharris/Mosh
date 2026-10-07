#!/usr/bin/env python3
"""Recipe-hygiene regression: track/clip naming and mix-stage headroom for
`generate_beat_recipe`. Engine-free; the peak check reads real palette one-shot bytes with
stdlib `wave` (this file's OWN reader — independent of compile.py's internal numpy-based
`_predict_peak_at_0db`, so a bug in that estimator would still show up here).

    python3 service/teardown/render/recipe_hygiene_test.py   (exit 0 = pass)

2026-09-23 investor-demo-prep (OWNER-TODAY.md / recipe-probe/summary.json) found, over the
project's 6 canonical demo seeds (A minor, 90 BPM, `generate_beat_recipe(seed=1..6)`):
  - track names were the raw FL-project source labels — artist names and explicit words
    (e.g. "skrill · kick friendly trsut beno #2 (kick)") — which would be on screen live;
  - 4-5 of 6 seeds' rendered mix peaked at exactly 0.0 dBFS (clipping).

A first fix (per-track, worst-case-bound trim) solved the clipping but over-corrected: real
seeds landed at -12.9 to -15.3 dBFS, and a held/long-duration note got double-penalized by a
duration-based overlap test never intended for one-shot triggers. The reworked fix (a) fixes
the actual extraction artifact at its root — `_dedupe_drum_onsets` collapses simultaneous-
onset drum-mode notes into one hit — and (b) computes ONE real, measured, per-recipe trim
from the actual palette audio instead of a worst-case formula. This file checks BOTH: naming
stays exactly as before, and the peak must land in a WINDOW (PEAK_FLOOR_DB..PEAK_CEILING_DB),
not just under a ceiling — a fix that merely goes very quiet would still fail this file.

2026-10-06 (PR #738 review): the measurement must play each voice for as long as the engine
does. assign_sample(mode="melodic") sounds (808/bass/pad/lead/pluck) are NOTE-GATED in the
engine (MoshOps.Plugins.cpp: setSoundOpenEnded (idx, false)) — the MIDI note length cuts the
sample, then Tracktion's SamplerPlugin fades it out over at most 100 samples; drum-mode
one-shots are open-ended and ring out whole. Summing an 808's whole 3 s one-shot per note
stacked tails the engine never plays: with gating modelled, the predicted 0 dB peak of seeds
1/3/4/5 falls from 9.01/8.76/8.99/7.39 to 4.85/4.93/5.56/4.19 dBFS, so the old sum cut them
3-4 dB deeper than the target needs. Section 2 pins the gating rule on synthetic one-shots
(portable, no palette); section 3 re-measures the real seeds with the same rule.

Uses the exact request shape the real `generate_beat_recipe` MoshOps command sends (see
src/moshops/MoshOps.cpp's `beatRecipeRequestBody` + service/server.py's
`_generate_recipe_payload`): tempo/key/seed/lead, seed as a top-level int, NOT folded into
the request dict.
"""
from __future__ import annotations

import math
import os
import re
import shutil
import struct
import sys
import tempfile
import wave

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from recipes.generate import generate, PALETTE_MANIFEST  # noqa: E402
from teardown import recipe as R  # noqa: E402
from teardown.render.compile import (  # noqa: E402
    HEADROOM_TRIM_DB, ROLE_DISPLAY_NAMES, TARGET_PEAK_DB, _predict_peak_at_0db, compile_recipe,
)

# Acceptance window for the REALIZED (post-trim) summed-mix peak. Ceiling: no clipping or
# near-clipping (TARGET_PEAK_DB is what compile.py aims a hot recipe at). Floor: not crushed
# — a fix that is merely "quiet enough" by attenuating far past the target is still a
# regression (2026-09-24 coordinator review of the first attempt, which landed 6/6 real
# seeds at -12.9 to -15.3 dBFS: technically safe, audibly damaged).
PEAK_FLOOR_DB = -9.0
PEAK_CEILING_DB = TARGET_PEAK_DB  # -3.0
# A hot recipe's trim is computed to land EXACTLY at TARGET_PEAK_DB using compile.py's own
# (numpy) summation; this file re-measures with an independent, pure-Python summation for a
# genuinely separate check, and floating-point summation order differences between the two
# put the result a few 1e-5 dB above -3.0 (never a few 1e-2, let alone audible) — a small,
# explicit tolerance for that, not a loosening of the acceptance window itself.
PEAK_TOLERANCE_DB = 0.01

fails: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


REQUEST = {"key": "A minor", "lead": False, "tempo": 90}
SEEDS = (1, 2, 3, 4, 5, 6)
# A name is BASE or "BASE N" (N>=2) for some role display name — the dedup suffix
# _role_display_name adds for a genuine same-role repeat.
_NAME_RE = re.compile(
    r"^(" + "|".join(re.escape(v) for v in ROLE_DISPLAY_NAMES.values()) + r")( [2-9]\d*)?$")

print(f"palette manifest: {PALETTE_MANIFEST} (exists={os.path.isfile(PALETTE_MANIFEST)})")

# ── 1) naming: role-only, no source-label leakage — fully portable (committed library only) ──
for seed in SEEDS:
    rec, prov = generate(REQUEST, seed=seed)
    cr = compile_recipe(rec)
    track_names = [c["args"]["name"] for c in cr.commands if c["command"] == "create_track"]
    clip_names = [c["args"]["name"] for c in cr.commands
                  if c["command"] == "add_midi_clip" and "name" in c["args"]]

    check(f"seed {seed}: every track name is in the role vocabulary",
          all(_NAME_RE.match(n) for n in track_names), str(track_names))
    check(f"seed {seed}: every clip name is in the role vocabulary",
          all(_NAME_RE.match(n) for n in clip_names), str(clip_names))
    check(f"seed {seed}: track count matches element count (one name per element, no drops)",
          len(track_names) == len(rec.elements), f"{len(track_names)} vs {len(rec.elements)}")
    # the direct regression: an element's OWN compiled name never carries its OWN source
    # label — a name-vocabulary check alone would miss a bug that left `label` concatenated
    # onto a valid-looking role string, so this checks containment independently, per element
    # (not a flat cross-product, which would false-flag e.g. one element's plain "Hat" label
    # against a DIFFERENT element's unrelated "Hats" name). A label that is just the role word
    # itself (singular or plural — a source project that already called its own kick track
    # "Kick") is not a leak of DISTINGUISHING information, so it is excluded; an artist name,
    # an explicit word, or a filename is not, and must never appear in that element's name.
    leaked = []
    for el, name in zip(rec.elements, track_names):
        lbl = (el.label or "").strip()
        if not lbl:
            continue
        role_words = {el.role.value, ROLE_DISPLAY_NAMES.get(el.role.value, "").lower(),
                      ROLE_DISPLAY_NAMES.get(el.role.value, "").lower().rstrip("s")}
        if lbl.lower() not in role_words and lbl in name:
            leaked.append((lbl, name))
    check(f"seed {seed}: no element's source label leaks into its own track/clip name",
          not leaked, str(leaked))
    # de-dup is exercised for real only when a seed actually repeats a role; still assert no
    # two elements of the SAME role produced the SAME display name (a silent collision).
    per_role: dict[str, list[str]] = {}
    for el, n in zip(rec.elements, track_names):
        per_role.setdefault(el.role.value, []).append(n)
    dupes = {role: names for role, names in per_role.items()
             if len(names) > 1 and len(set(names)) != len(names)}
    check(f"seed {seed}: a repeated role never collides on the same display name",
          not dupes, str(dupes))

# ── independent mixer (pure Python; shared by sections 2 and 3) ──────────────────────────
# Sums every one-shot-bearing track's compiled notes into one buffer, at the recipe's own tempo,
# each note's velocity and each track's compiled `set_track_volume` dB (the gain the fix under
# test computed — applying it to real audio, not just reading the number back, is what makes
# this a real measurement: a wrong sign, a forgotten polyphony case, or a broken tile/velocity
# path would still show up in the summed peak). Melodic elements with no matched sample play
# the stock 4OSC synth instead of a one-shot — there is no PCM to read for those, so they are
# excluded from the sum, as compile.py's estimator excludes them.
#
# Voice length follows the ENGINE, written here independently of compile.py's numpy version:
#   - assign_sample mode "drum" (and the engine default when mode is absent): open-ended, the
#     whole one-shot rings out whatever the note length;
#   - mode "melodic": note-gated (MoshOps.Plugins.cpp setSoundOpenEnded (idx, false)). The
#     voice plays for the note's length, then Tracktion's SamplerPlugin::SampledNote fades it
#     linearly to silence over RELEASE_SAMPLES samples, then stops.
SR = 44100.0
RELEASE_SAMPLES = 100


def _read_wav_mono(path: str) -> list[float]:
    with wave.open(path, "rb") as w:
        n, sw, ch = w.getnframes(), w.getsampwidth(), w.getnchannels()
        data = w.readframes(n)
    if sw == 3:
        vals = []
        for i in range(len(data) // 3):
            b = data[i * 3:i * 3 + 3]
            v = b[0] | (b[1] << 8) | (b[2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            vals.append(v / 8388608.0)
    elif sw == 2:
        raw = struct.unpack("<%dh" % (len(data) // 2), data)
        vals = [v / 32768.0 for v in raw]
    else:
        raise ValueError(f"unsupported sample width {sw} in {path}")
    if ch > 1:
        return [sum(vals[i * ch:(i + 1) * ch]) / ch for i in range(len(vals) // ch)]
    return vals


_sample_cache: dict[str, list[float]] = {}


def _sample(path: str) -> list[float]:
    if path not in _sample_cache:
        _sample_cache[path] = _read_wav_mono(path)
    return _sample_cache[path]


def _voice_gain(i: int, gate_at) -> float:
    """Gain of sample i of a voice: 1 while the key is held (or always, for an open-ended
    voice: gate_at None), then a linear release to 0 over RELEASE_SAMPLES, then silence."""
    if gate_at is None or i < gate_at:
        return 1.0
    k = i - gate_at
    return 1.0 - k / RELEASE_SAMPLES if k < RELEASE_SAMPLES else 0.0


def _mix_peak_dbfs(commands: list[dict], tempo_default: float = 120.0) -> tuple[float, int]:
    """(peak_dBFS, n_tracks_measured) of the compiled program's one-shot audio. -inf if
    nothing measurable (no track had a matched sample)."""
    tempo = next((c["args"]["bpm"] for c in commands if c["command"] == "set_tempo"),
                 tempo_default)
    spb = 60.0 / float(tempo)
    file_by_track = {c["args"]["trackId"]: c["args"]["file"]
                     for c in commands if c["command"] == "assign_sample"}
    mode_by_track = {c["args"]["trackId"]: c["args"].get("mode", "drum")
                     for c in commands if c["command"] == "assign_sample"}
    db_by_track = {c["args"]["trackId"]: c["args"]["db"]
                   for c in commands if c["command"] == "set_track_volume"}
    mix: list[float] = []

    def _grow(k: int) -> None:
        if len(mix) < k:
            mix.extend([0.0] * (k - len(mix)))

    measured = 0
    for c in commands:
        if c["command"] != "add_midi_clip":
            continue
        tref = c["args"]["trackId"]
        fpath = file_by_track.get(tref)
        if not fpath:
            continue
        measured += 1
        gain = 10.0 ** (db_by_track.get(tref, 0.0) / 20.0)
        samp = _sample(fpath)
        gated = mode_by_track.get(tref) == "melodic"
        for note in c["args"].get("notes", []):
            start_i = int(round(float(note["start"]) * spb * SR))
            vel_gain = max(1, min(127, int(note.get("velocity", 100)))) / 127.0
            g = gain * vel_gain
            gate_at = (max(1, int(round(float(note["length"]) * spb * SR))) if gated else None)
            audible = len(samp) if gate_at is None else min(len(samp), gate_at + RELEASE_SAMPLES)
            _grow(start_i + audible)
            for i in range(audible):
                mix[start_i + i] += samp[i] * g * _voice_gain(i, gate_at)
    if not mix:
        return float("-inf"), measured
    peak = max(abs(v) for v in mix)
    return (20.0 * math.log10(peak) if peak > 0 else float("-inf")), measured


# ── 2) the note-gating rule itself, on synthetic one-shots (portable: no palette) ──────────
# A DC one-shot (every sample exactly 0.5) LONGER than the gap between its notes, so a
# whole-sample sum stacks voices that the engine never plays together. Velocity 127 (gain 1),
# 90 BPM (one beat = 29400 samples), the sample 2.0 s = 88200 samples (3 beats).
#   gapped:  notes at beats 0/1/2, each 0.5 beat long. Note-gated, one voice sounds at a time
#            (0.5 = -6.02 dBFS); whole one-shots stack 3-deep from beat 2 (1.5 = +3.52 dBFS).
#   legato:  notes at beats 0/0.5/1/1.5, each 0.5 beat long. Note-gated, two voices overlap only
#            inside the release fade at each note boundary (0.5 + 0.5 = 1.0 = 0.00 dBFS); a model
#            that dropped the release would say 0.5 (-6.02), whole one-shots stack 4-deep (+6.02).
# The old whole-sample estimator gets the gapped melodic case wrong by 9.5 dB (and the legato
# one by 6 dB), so the compile.py estimator's melodic checks below fail against it.
print("\nnote-gating model (synthetic one-shots):")
_np_available = True
try:
    import numpy  # noqa: F401  (compile.py's estimator needs it; the independent mixer does not)
except ImportError:
    _np_available = False
    print("  skip compile.py estimator checks (numpy unavailable: it returns None by design)")

_tmp = tempfile.mkdtemp(prefix="recipe-gating-")
try:
    _dc_path = os.path.join(_tmp, "dc-half.wav")
    with wave.open(_dc_path, "wb") as _w:
        _w.setnchannels(1)
        _w.setsampwidth(2)
        _w.setframerate(int(SR))
        _w.writeframes(struct.pack("<h", 16384) * 88200)   # 16384 / 32768 = 0.5 exactly

    def _program(mode: str, starts: tuple, length: float) -> list[dict]:
        return [
            {"command": "set_tempo", "args": {"bpm": 90}},
            {"command": "assign_sample",
             "args": {"trackId": "T", "note": 33, "mode": mode, "file": _dc_path}},
            {"command": "add_midi_clip",
             "args": {"trackId": "T", "start": 0, "length": 4.0,
                      "notes": [{"pitch": 33, "start": b, "length": length, "velocity": 127}
                                for b in starts]}},
        ]

    _DB_HALF, _DB_ONE = 20.0 * math.log10(0.5), 0.0
    _DB_THREE_HALVES = 20.0 * math.log10(1.5)
    _GAPPED, _LEGATO = (0.0, 1.0, 2.0), (0.0, 0.5, 1.0, 1.5)
    _cases = [
        ("gapped melodic notes: one gated voice at a time, the whole tails are not summed",
         _program("melodic", _GAPPED, 0.5), _DB_HALF),
        ("gapped drum-mode notes: open-ended one-shots still ring out whole and stack",
         _program("drum", _GAPPED, 0.5), _DB_THREE_HALVES),
        ("legato melodic notes: two voices overlap only inside the release fade",
         _program("melodic", _LEGATO, 0.5), _DB_ONE),
    ]
    for _label, _cmds, _want in _cases:
        _got_indep, _ = _mix_peak_dbfs(_cmds)
        check(f"independent mixer, {_label}", abs(_got_indep - _want) < 1e-6,
              f"got {_got_indep:.4f} dBFS, want {_want:.4f}")
        if _np_available:
            _got_est = _predict_peak_at_0db(_cmds, 90.0)
            check(f"compile.py estimator, {_label}",
                  _got_est is not None and abs(_got_est - _want) < 1e-6,
                  f"got {_got_est}, want {_want:.4f}")

    # end-to-end through compile_recipe: the gated 808 is quiet enough to keep the baseline
    # trim, while the same notes on an open-ended drum one-shot need a deeper cut. Under the
    # old whole-sample sum the 808 recipe was cut to -6.52 dB instead of -4.5.
    def _one_element_recipe(role: str) -> "R.Recipe":
        return R.Recipe(
            meta=R.Meta(tempo_bpm=R.MetaField(value=90)),
            elements=[R.Element(
                element_id="e0", role=role, label="x",
                sample_match=R.SampleMatch(status="matched", matched_path=_dc_path,
                                           distance=0.1, root_note=33),
                midi=R.Midi(status="extracted", notes=[
                    R.NoteEvent(pitch=33, start_beats=b, duration_beats=0.5, velocity=127)
                    for b in _GAPPED]))])

    def _trim_and_mode(rec) -> tuple:
        cmds = compile_recipe(rec).commands
        trim = next(c["args"]["db"] for c in cmds if c["command"] == "set_track_volume")
        mode = next(c["args"]["mode"] for c in cmds if c["command"] == "assign_sample")
        return trim, mode

    if _np_available:
        _trim808, _mode808 = _trim_and_mode(_one_element_recipe("808"))
        check("e2e fixture: the 808 compiles to a melodic (note-gated) sampler",
              _mode808 == "melodic", _mode808)
        check("e2e: a gated 808 under the target keeps the baseline trim "
              f"({HEADROOM_TRIM_DB} dB; the whole-sample sum cut it to "
              f"{TARGET_PEAK_DB - _DB_THREE_HALVES:.2f})",
              abs(_trim808 - HEADROOM_TRIM_DB) < 1e-9, f"trim {_trim808}")
        _trimkick, _modekick = _trim_and_mode(_one_element_recipe("kick"))
        check("e2e fixture: the kick compiles to a drum-mode (open-ended) one-shot",
              _modekick == "drum", _modekick)
        check("e2e: the same notes on an open-ended one-shot are cut to land at the target",
              abs(_trimkick - round(TARGET_PEAK_DB - _DB_THREE_HALVES, 4)) < 1e-9,
              f"trim {_trimkick}")
finally:
    shutil.rmtree(_tmp, ignore_errors=True)

# ── 3) mix-stage peak: a REAL measurement of the audio the recipe produces ───────────────
# Re-measures the six canonical seeds with the independent mixer above (real palette one-shot
# bytes, compiled note positions/velocities/lengths, compiled per-track dB, the engine's
# note-gating rule) and requires the realized peak inside the acceptance window.
if not os.path.isfile(PALETTE_MANIFEST):
    print(f"  skip peak measurement (no palette manifest at {PALETTE_MANIFEST!r} — "
          "generate_beat_recipe's real one-shots are unavailable on this machine)")
else:
    peak_table: list[tuple[int, float]] = []
    for seed in SEEDS:
        rec, prov = generate(REQUEST, seed=seed)
        cr = compile_recipe(rec)
        peak_db, n_measured = _mix_peak_dbfs(cr.commands)
        peak_table.append((seed, peak_db))
        check(f"seed {seed}: at least one track's real one-shot audio was measured",
              n_measured > 0, f"n_measured={n_measured}")
        check(f"seed {seed}: real summed-mix peak is in [{PEAK_FLOOR_DB}, {PEAK_CEILING_DB}] dBFS "
              "(ceiling = no clipping/near-clipping, floor = not crushed)",
              PEAK_FLOOR_DB - PEAK_TOLERANCE_DB <= peak_db <= PEAK_CEILING_DB + PEAK_TOLERANCE_DB,
              f"measured {peak_db:.4f} dBFS")
        # A MEASURED cut deeper than the baseline exists only to land a hot recipe AT the
        # target; if the realized peak sits well under it, the estimator over-predicted (the
        # whole-tail 808 sum left 4 of 6 seeds at -6.2 to -7.2 dBFS, 3-4 dB quieter than
        # intended). Without numpy the compiler takes the unmeasured FALLBACK trim instead,
        # which aims at no target, so there is nothing to land.
        trim_db = next(c["args"]["db"] for c in cr.commands if c["command"] == "set_track_volume")
        if _np_available and trim_db < HEADROOM_TRIM_DB - 1e-9:
            check(f"seed {seed}: its deeper-than-baseline trim ({trim_db} dB) lands the peak AT "
                  f"{TARGET_PEAK_DB} dBFS, not below it",
                  abs(peak_db - TARGET_PEAK_DB) <= PEAK_TOLERANCE_DB,
                  f"measured {peak_db:.4f} dBFS")

    print("\nseed -> realized peak dBFS:")
    for seed, peak_db in peak_table:
        print(f"  {seed}: {peak_db:.2f}")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
