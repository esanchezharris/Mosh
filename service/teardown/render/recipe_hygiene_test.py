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

Uses the exact request shape the real `generate_beat_recipe` MoshOps command sends (see
src/moshops/MoshOps.cpp's `beatRecipeRequestBody` + service/server.py's
`_generate_recipe_payload`): tempo/key/seed/lead, seed as a top-level int, NOT folded into
the request dict.
"""
from __future__ import annotations

import math
import os
import re
import struct
import sys
import wave

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from recipes.generate import generate, PALETTE_MANIFEST  # noqa: E402
from teardown.render.compile import (  # noqa: E402
    ROLE_DISPLAY_NAMES, TARGET_PEAK_DB, compile_recipe,
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

# ── 2) mix-stage peak: a REAL measurement of the audio the recipe produces ───────────────
# Reads the ACTUAL palette one-shot bytes the compiled `assign_sample` commands reference and
# sums them at their compiled note positions, scaled by the compiled note velocity AND the
# compiled per-track `set_track_volume` dB (the gain the fix under test actually computed —
# applying it to real audio, not just reading the number back, is what makes this a real
# measurement: a wrong sign, a forgotten polyphony case, or a broken tile/velocity path would
# still show up in the summed peak). Melodic elements with no matched sample play the stock
# 4OSC synth instead of a one-shot — there is no PCM to read for those, so (matching what is
# actually audible from a one-shot) they are excluded from the sum, same as the demo-prep
# recipe-probe capture was dominated by the real one-shots, not the synth fallback.
if not os.path.isfile(PALETTE_MANIFEST):
    print(f"  skip peak measurement (no palette manifest at {PALETTE_MANIFEST!r} — "
          "generate_beat_recipe's real one-shots are unavailable on this machine)")
else:
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

    SR = 44100.0

    def _mix_peak_dbfs(rec, cr) -> tuple[float, int]:
        """Sums every one-shot-bearing track's compiled notes into one buffer at the
        recipe's own tempo and each track's own compiled dB, returns (peak_dBFS,
        n_tracks_measured). -inf if nothing measurable (no track had a matched sample)."""
        tempo = next((c["args"]["bpm"] for c in cr.commands if c["command"] == "set_tempo"), 120.0)
        spb = 60.0 / float(tempo)
        file_by_track = {c["args"]["trackId"]: c["args"]["file"]
                         for c in cr.commands if c["command"] == "assign_sample"}
        db_by_track = {c["args"]["trackId"]: c["args"]["db"]
                      for c in cr.commands if c["command"] == "set_track_volume"}
        mix: list[float] = []

        def _grow(k: int) -> None:
            if len(mix) < k:
                mix.extend([0.0] * (k - len(mix)))

        measured = 0
        for c in cr.commands:
            if c["command"] != "add_midi_clip":
                continue
            tref = c["args"]["trackId"]
            fpath = file_by_track.get(tref)
            if not fpath:
                continue
            measured += 1
            gain = 10.0 ** (db_by_track.get(tref, 0.0) / 20.0)
            samp = _sample(fpath)
            for note in c["args"].get("notes", []):
                start_i = int(round(float(note["start"]) * spb * SR))
                vel_gain = max(1, min(127, int(note.get("velocity", 100)))) / 127.0
                g = gain * vel_gain
                _grow(start_i + len(samp))
                for i, s in enumerate(samp):
                    mix[start_i + i] += s * g
        if not mix:
            return float("-inf"), measured
        peak = max(abs(v) for v in mix)
        return (20.0 * math.log10(peak) if peak > 0 else float("-inf")), measured

    peak_table: list[tuple[int, float]] = []
    for seed in SEEDS:
        rec, prov = generate(REQUEST, seed=seed)
        cr = compile_recipe(rec)
        peak_db, n_measured = _mix_peak_dbfs(rec, cr)
        peak_table.append((seed, peak_db))
        check(f"seed {seed}: at least one track's real one-shot audio was measured",
              n_measured > 0, f"n_measured={n_measured}")
        check(f"seed {seed}: real summed-mix peak is in [{PEAK_FLOOR_DB}, {PEAK_CEILING_DB}] dBFS "
              "(ceiling = no clipping/near-clipping, floor = not crushed)",
              PEAK_FLOOR_DB - PEAK_TOLERANCE_DB <= peak_db <= PEAK_CEILING_DB + PEAK_TOLERANCE_DB,
              f"measured {peak_db:.4f} dBFS")

    print("\nseed -> realized peak dBFS:")
    for seed, peak_db in peak_table:
        print(f"  {seed}: {peak_db:.2f}")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
