#!/usr/bin/env python3
"""Deterministic recipe verifier — a Python port of ui/src/agent/recipeVerifier.ts.

The reframe (owner, 2026-06-29): stop rewarding the rendered AUDIO (the §12 composite is a
fuzzy black box the rating probe proved doesn't track taste, ρ≈0). The agent's actual output
is a RECIPE — the symbolic command program / musical DNA (notes, pitches, grid, key, parts).
Because we built the engine, that recipe is fully inspectable, so we grade it with RULES — no
rendering, no taste-model, no GPU. This is the GRPO/GEPA reward over the DNA.

This is a byte-faithful port of the HARDENED TS verifier (which survived a 6-lens / 24-exploit
red-team: every Goodhart attack scores <0.7). Parity vs the TS is pinned by
recipe_verifier_test.py against testdata/verifier_parity.json (the TS verdicts on the same 25
recipes) — the port must reproduce every total + dim within 1e-6 or the test fails. That makes
the Python GRPO reward provably identical to the validated TS verifier (no cross-language drift).

Pure stdlib. Score a recipe with verify_recipe(recipe) -> {"total", "dims", "reasons"}.
"""
from __future__ import annotations

import math
from typing import Any

# Mirrors of ui/src/musicalKey.ts NOTE_PC / SCALES — itself pinned in lockstep with
# ui/src/vendor/voice.js by musicalKey.test.ts. This module is deliberately pure stdlib, so
# the tables are duplicated rather than imported; recipe_verifier_test.py's mode block keeps
# them honest against the TS. SCALES keys are the native `set_key` validator's six-mode domain.
NOTE_PC = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6,
    "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}
SCALES = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "pentatonic": [0, 3, 5, 7, 10],          # MINOR pentatonic
    "chromatic": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
}
KICK = 36
HAT_PADS = {42, 44, 46}
SNARE_PADS = {38, 40}
DRUM_RANGE = (35, 81)
GRID = 0.25
GRID_TOL = 0.06

# PRODUCTION (owner reframe — "the recipe includes production") real-vs-stock classifier:
# provenance only, NEVER taste. "stock" = the bundled mosh-kit (the only sounds the engine
# auto-provides); "real" = any other path (the owner's musica/Splice library / an import).
STOCK_KIT_DIRMARK = "drumkits/mosh-kit"
STOCK_KIT_FILES = {"kick.wav", "snare.wav", "clap.wav", "hat_closed.wav", "hat_open.wav", "tom_low.wav", "tom_mid.wav", "crash.wav"}
DEFAULT_INSTRUMENTS = {"4osc", "4OSC Synth", "sampler", "Sampler"}
KIT_PAD_PITCHES = [36, 38, 39, 42, 46, 45, 47, 49]

# weights sum to 1 — the three musical anti-gaming dims (dynamics/variation/contour) plus the
# production realness GATE carry the conjunction; production COMPLETENESS (kit_coverage, mix)
# adds modest weight. Musical dims still hold 0.89 of the base; realness's power is the gate.
WEIGHTS = {
    "parts": 0.09, "drums": 0.15, "grid": 0.08, "key": 0.12, "register": 0.04,
    "dynamics": 0.11, "variation": 0.11, "contour": 0.11, "density": 0.04, "hygiene": 0.04,
    "realness": 0.05, "kit_coverage": 0.04, "mix": 0.02,
}
DIM_ORDER = list(WEIGHTS.keys())
GATE_DIMS = ["dynamics", "variation", "contour", "realness"]
GATE_FLOOR = 0.5


def classify_sample(path: str) -> str:
    p = (path or "").replace("\\", "/")
    base = p.rsplit("/", 1)[-1].lower()
    if STOCK_KIT_DIRMARK in p:
        return "stock"
    if base in STOCK_KIT_FILES:
        return "stock"
    return "real"


def classify_instrument(name: str) -> str:
    return "default" if name in DEFAULT_INSTRUMENTS else "real"


# JS Math.round rounds half toward +inf; Python round() is banker's. Mirror JS exactly so the
# 16th-slot / on-grid quantization matches bit-for-bit.
def _jsround(x: float) -> int:
    return math.floor(x + 0.5)


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _mean(xs: list[float]) -> float:
    # left-fold from 0 / len — identical to the TS reduce
    if not xs:
        return 0.0
    acc = 0.0
    for v in xs:
        acc += v
    return acc / len(xs)


def _pc(p: float) -> int:
    return int((p % 12 + 12) % 12)


def _mode_of(mode: str) -> str:
    """The declared mode resolved into the six-mode `set_key` domain. Out-of-domain strings
    keep v2's coarse major-prefix heuristic (everything else read as minor) so grading never
    silently flips for a string the domain doesn't cover — the engine's `set_key` validates,
    but a raw command program reaching recipe_from_program may carry anything."""
    m = (mode or "").lower()
    if m in SCALES:
        return m
    return "major" if m.startswith("maj") else "minor"


def _tonic_pc(tonic: str) -> int:
    return NOTE_PC.get(tonic, 9)


def _on_grid(s: float) -> bool:
    return abs(s - _jsround(s / GRID) * GRID) <= GRID_TOL


def _near_beat(s: float, beat_in_bar: int, bars: int) -> bool:
    for b in range(bars):
        if abs(s - (b * 4 + beat_in_bar)) <= GRID_TOL:
            return True
    return False


def _bar_of(s: float) -> int:
    return math.floor(s / 4)


def _slot16(s: float) -> int:
    return _jsround(((s % 4) + 4) % 4 / GRID)


def _tracks_of(r: dict, role: str) -> list[dict]:
    return [t for t in r["tracks"] if t.get("role") == role]


def _notes_of(r: dict, role: str) -> list[dict]:
    out: list[dict] = []
    for t in _tracks_of(r, role):
        out.extend(t.get("notes", []))
    return out


def _melodic_tracks(r: dict) -> list[dict]:
    return [t for t in r["tracks"] if t.get("role") in ("bass", "melody", "other") and t.get("notes")]


# ── structural dimensions ─────────────────────────────────────────────────────

def _score_parts(r: dict, reasons: list[str]) -> float:
    want = ["drums", "bass", "melody"]
    have = 0
    for role in want:
        if len(_notes_of(r, role)) > 0:
            have += 1
        else:
            reasons.append(f"parts: missing/empty {role}")
    return have / len(want)


def _score_drums(r: dict, reasons: list[str]) -> float:
    notes = _notes_of(r, "drums")
    if not notes:
        reasons.append("drums: no drum part")
        return 0.0
    bars = max(1, r["bars"])
    kicks = [n for n in notes if n["pitch"] == KICK]
    snares = [n for n in notes if n["pitch"] in SNARE_PADS]
    hats = [n for n in notes if n["pitch"] in HAT_PADS]

    kick_bars = 0
    for b in range(bars):
        if any(abs(k["start"] - b * 4) <= GRID_TOL for k in kicks):
            kick_bars += 1
    kick_per_bar = len(kicks) / bars
    kick_sparse = 1.0 if kick_per_bar <= 6 else _clamp01((16 - kick_per_bar) / 10)
    kick_anchor = (kick_bars / bars) * kick_sparse if kicks else 0.0
    snare_backbeat = (len([s for s in snares if _near_beat(s["start"], 1, bars) or _near_beat(s["start"], 3, bars)]) / len(snares)) if snares else 0.0
    hats_per_bar = len(hats) / bars
    if hats_per_bar < 2:
        hats_sweet = _clamp01(hats_per_bar / 2)
    elif hats_per_bar <= 12:
        hats_sweet = 1.0
    else:
        hats_sweet = _clamp01((24 - hats_per_bar) / 12)
    pads_valid = len([n for n in notes if DRUM_RANGE[0] <= n["pitch"] <= DRUM_RANGE[1]]) / len(notes)
    collisions = len([s for s in snares if any(abs(k["start"] - s["start"]) <= GRID_TOL for k in kicks)])
    no_collision = (1 - collisions / len(snares)) if snares else 1.0

    if not kicks:
        reasons.append("drums: no kick (36)")
    if not snares:
        reasons.append("drums: no snare (38/40)")
    if not hats:
        reasons.append("drums: no hats (42/44/46)")
    if kick_per_bar > 8:
        reasons.append(f"drums: kick on too many slots ({kick_per_bar:.0f}/bar — a wall, not an anchor)")
    if hats_per_bar > 14:
        reasons.append(f"drums: machine-gun hats ({hats_per_bar:.0f}/bar)")
    if no_collision < 0.8:
        reasons.append("drums: kick buries the backbeat snare (collision)")

    return _mean([kick_anchor, snare_backbeat, hats_sweet, pads_valid, no_collision])


def _score_grid(r: dict, reasons: list[str]) -> float:
    all_notes = [n for t in r["tracks"] for n in t.get("notes", [])]
    if not all_notes:
        return 0.0
    frac = len([n for n in all_notes if _on_grid(n["start"])]) / len(all_notes)
    if frac < 0.8:
        reasons.append(f"grid: {_jsround((1 - frac) * 100)}% of notes off the 16th grid")
    return frac


# A chromatic key declares NO pitch constraint, so there is nothing to verify — every pitch is
# trivially "in scale". Scoring that 1.0 would pay the agent this dimension's full 0.12 of
# weight for REMOVING its own constraint (it authors `set_key`, so the exploit is reachable),
# which is exactly the Goodhart class v2 was hardened against. So chromatic takes the module's
# established "can't measure -> neutral" value, the same 0.7 dynamics/variation/realness use.
KEY_UNVERIFIABLE = 0.7


def _score_key(r: dict, reasons: list[str]) -> float:
    mode = _mode_of(r["key"]["mode"])
    mel = [n for t in _melodic_tracks(r) for n in t["notes"]]
    if not mel:
        reasons.append("key: no melodic content to check")
        return 0.0
    if mode == "chromatic":
        reasons.append("key: chromatic declares no pitch constraint — key left unscored")
        return KEY_UNVERIFIABLE
    scale = set(SCALES[mode])
    tonic = _tonic_pc(r["key"]["tonic"])
    frac = len([n for n in mel if _pc(n["pitch"] - tonic) in scale]) / len(mel)
    if frac < 0.85:
        reasons.append(f"key: {_jsround((1 - frac) * 100)}% of melodic notes out of {r['key']['tonic']} {r['key']['mode']}")
    return frac


def _score_register(r: dict, reasons: list[str]) -> float:
    checks: list[float] = []
    bass = _notes_of(r, "bass")
    if bass:
        ok = len([n for n in bass if 21 <= n["pitch"] <= 55]) / len(bass)
        if ok < 0.8:
            reasons.append("register: bass out of the bass register")
        checks.append(ok)
    mel = _notes_of(r, "melody")
    if mel:
        ok = len([n for n in mel if 48 <= n["pitch"] <= 100]) / len(mel)
        if ok < 0.8:
            reasons.append("register: lead out of the melodic register")
        checks.append(ok)
    drums = _notes_of(r, "drums")
    if drums:
        checks.append(len([n for n in drums if DRUM_RANGE[0] <= n["pitch"] <= DRUM_RANGE[1]]) / len(drums))
    return _mean(checks) if checks else 0.0


# ── anti-gaming dimensions ─────────────────────────────────────────────────────

def _score_dynamics(r: dict, reasons: list[str]) -> float:
    parts = [t for t in r["tracks"] if len(t.get("notes", [])) >= 4]
    if not parts:
        return 0.7
    vals = []
    for t in parts:
        v = [n["velocity"] for n in t["notes"]]
        vals.append(_clamp01((max(v) - min(v)) / 20))
    s = _mean(vals)
    if s < 0.4:
        reasons.append("dynamics: flat velocities (robotic — no accents/ghost notes)")
    return s


def _bar_sig(notes: list[dict]) -> str:
    return ",".join(sorted(f"{n['pitch']}:{_slot16(n['start'])}" for n in notes))


def _score_variation(r: dict, reasons: list[str]) -> float:
    mel = _melodic_tracks(r)
    if not mel or r["bars"] < 2:
        return 0.7
    vals = []
    for t in mel:
        by_bar: list[list[dict]] = [[] for _ in range(r["bars"])]
        for n in t["notes"]:
            b = _bar_of(n["start"])
            if 0 <= b < r["bars"]:
                by_bar[b].append(n)
        distinct = len(set(_bar_sig(b) for b in by_bar))
        vals.append((distinct - 1) / (r["bars"] - 1))
    s = _mean(vals)
    if s < 0.4:
        reasons.append("variation: bars are copy-paste clones (no development/turnaround)")
    return s


def _score_contour(r: dict, reasons: list[str]) -> float:
    mel = _melodic_tracks(r)
    if not mel:
        return 0.0
    vals = []
    for t in mel:
        notes = sorted(t["notes"], key=lambda n: n["start"])
        pc_var = _clamp01(len(set(_pc(n["pitch"]) for n in notes)) / 3)
        onset = _clamp01(len(set(_jsround(n["start"] / GRID) for n in notes)) / (r["bars"] * 2))
        steps = 0
        leaps = 0
        for i in range(1, len(notes)):
            d = abs(notes[i]["pitch"] - notes[i - 1]["pitch"])
            if d == 0:
                continue
            if d <= 12:
                steps += 1
            else:
                leaps += 1
        interval = (steps / (steps + leaps)) if (steps + leaps) else 0.5
        sub = [pc_var, onset, interval]
        vals.append(0.3 * _mean(sub) + 0.7 * min(sub))
    s = _mean(vals)
    if s < 0.5:
        reasons.append("contour: non-melodic (octave-spam / chord-stab / random leaps)")
    return s


def _score_density(r: dict, reasons: list[str]) -> float:
    bars = max(1, r["bars"])

    def band(n: float, lo: float, hi: float) -> float:
        if n < lo:
            return _clamp01(n / max(1, lo))
        if n > hi:
            return _clamp01(hi / n)
        return 1.0

    per_part: list[float] = []
    for role in ("drums", "bass", "melody"):
        notes = _notes_of(r, role)
        if not notes:
            continue
        per_bar = len(notes) / bars
        lo, hi = (3, 24) if role == "drums" else (1, 12) if role == "bass" else (1, 16)
        dens = band(per_bar, lo, hi)
        if dens < 0.5:
            reasons.append(f"density: {role} too {'sparse' if per_bar < lo else 'busy'} ({per_bar:.1f}/bar)")
        per_part.append(dens)
    return _mean(per_part) if per_part else 0.0


def _score_hygiene(r: dict, reasons: list[str]) -> float:
    all_notes = [n for t in r["tracks"] for n in t.get("notes", [])]
    if not all_notes:
        reasons.append("hygiene: no notes at all")
        return 0.0
    penalty = 0.0
    oor = len([n for n in all_notes if n["pitch"] < 0 or n["pitch"] > 127])
    bad_len = len([n for n in all_notes if not (n["length"] > 0)])
    empty_clips = len([t for t in r["tracks"] if len(t.get("notes", [])) == 0])
    flam = 0
    for t in r["tracks"]:
        by_pitch: dict[int, list[float]] = {}
        for n in t.get("notes", []):
            by_pitch.setdefault(n["pitch"], []).append(n["start"])
        for starts in by_pitch.values():
            starts.sort()
            for i in range(1, len(starts)):
                if starts[i] - starts[i - 1] < 0.1:
                    flam += 1
    cluster = 0
    for t in r["tracks"]:
        by_start: dict[float, int] = {}
        for n in t.get("notes", []):
            by_start[n["start"]] = by_start.get(n["start"], 0) + 1
        for c in by_start.values():
            if c > 4:
                cluster += 1
    if oor:
        penalty += 0.5
        reasons.append(f"hygiene: {oor} out-of-range pitches")
    if bad_len:
        penalty += 0.3
        reasons.append(f"hygiene: {bad_len} zero/negative-length notes")
    if empty_clips:
        penalty += 0.1 * empty_clips
        reasons.append(f"hygiene: {empty_clips} empty track(s)")
    if flam > 2:
        penalty += 0.4
        reasons.append(f"hygiene: {flam} flam/micro-offset stacks (spam)")
    if cluster:
        penalty += 0.4
        reasons.append(f"hygiene: {cluster} tone-cluster onset(s) (>4 notes at once)")
    return _clamp01(1 - penalty)


# ── production dimensions (presence/realness only — never taste) ───────────────

DRUM_CORES = [("kick", [36]), ("snare", [38, 40]), ("hat", [42, 44, 46])]


def _played_pitches(t: dict) -> set:
    return set(n["pitch"] for n in t.get("notes", []))


def _pad_realness(prod: dict, note: int):
    for p in prod.get("pads", []) or []:
        if p["note"] == note:
            return p["realness"]
    return None


def _has_drum_prod(t: dict) -> bool:
    return bool(t.get("production", {}).get("pads"))


def _has_voice_prod(t: dict) -> bool:
    pr = t.get("production", {})
    return bool(pr.get("instrument") or pr.get("pads") or pr.get("sampleRealness"))


def _voice_is_real(t: dict) -> bool:
    pr = t.get("production", {})
    inst = pr.get("instrument") or {}
    return (inst.get("realness") == "real" or pr.get("sampleRealness") == "real"
            or any(p["realness"] == "real" for p in (pr.get("pads") or [])))


def _score_realness(r: dict, reasons: list[str]) -> float:
    observed = bool(r.get("productionObserved"))
    units: list[float] = []
    for t in r["tracks"]:
        if not t.get("notes"):
            continue
        if t.get("role") == "drums":
            if not _has_drum_prod(t) and not observed:
                continue
            for note in _played_pitches(t):
                if note < DRUM_RANGE[0] or note > DRUM_RANGE[1]:
                    continue
                units.append(1.0 if _pad_realness(t.get("production", {}), note) == "real" else 0.0)
        else:
            if not _has_voice_prod(t) and not observed:
                continue
            units.append(1.0 if _voice_is_real(t) else 0.0)
    if not units:
        return 0.7
    s = _mean(units)
    if s < 0.5:
        reasons.append("realness: stock/outline sounds — real one-shots/instruments not used")
    return s


def _score_kit_coverage(r: dict, reasons: list[str]) -> float:
    observed = bool(r.get("productionObserved"))
    checks: list[float] = []
    for t in r["tracks"]:
        if not t.get("notes"):
            continue
        role = t.get("role")
        if role == "drums":
            if not _has_drum_prod(t) and not observed:
                continue
            played = _played_pitches(t)
            for _, notes in DRUM_CORES:
                triggered = any(n in played for n in notes)
                if not triggered:
                    checks.append(0.5)
                    continue
                backed = any(_pad_realness(t.get("production", {}), n) is not None for n in notes)
                checks.append(1.0 if backed else 0.0)
        elif role == "bass":
            if not _has_voice_prod(t) and not observed:
                continue
            checks.append(1.0 if _has_voice_prod(t) else 0.0)
        elif role == "melody":
            if not t.get("production", {}).get("instrument") and not observed:
                continue
            checks.append(1.0 if t.get("production", {}).get("instrument") else 0.0)
    if not checks:
        return 0.7
    s = _mean(checks)
    if s < 0.6:
        reasons.append("kit_coverage: not every voice is sound-backed (incomplete production)")
    return s


def _score_mix(r: dict, reasons: list[str]) -> float:
    voices = [t for t in r["tracks"] if t.get("notes")]
    if not voices:
        return 0.7
    moved = []
    for t in voices:
        pr = t.get("production", {})
        moved.append(1.0 if (abs(pr.get("volumeDb", 0.0)) > 0.01 or abs(pr.get("pan", 0.0)) > 0.01) else 0.0)
    s = _clamp01(0.5 + 0.5 * _mean(moved))
    if s <= 0.5:
        reasons.append("mix: levels left at default (no mix moves)")
    return s


# ── aggregate ───────────────────────────────────────────────────────────────

def verify_recipe(r: dict) -> dict:
    """Grade a recipe's musical DNA + PRODUCTION deterministically. Pure. Mirror of verifyRecipe (TS)."""
    reasons: list[str] = []
    dims = {
        "parts": _score_parts(r, reasons),
        "drums": _score_drums(r, reasons),
        "grid": _score_grid(r, reasons),
        "key": _score_key(r, reasons),
        "register": _score_register(r, reasons),
        "dynamics": _score_dynamics(r, reasons),
        "variation": _score_variation(r, reasons),
        "contour": _score_contour(r, reasons),
        "density": _score_density(r, reasons),
        "hygiene": _score_hygiene(r, reasons),
        "realness": _score_realness(r, reasons),
        "kit_coverage": _score_kit_coverage(r, reasons),
        "mix": _score_mix(r, reasons),
    }
    base = 0.0
    for k in DIM_ORDER:
        base += WEIGHTS[k] * dims[k]
    gate = 1.0
    for k in GATE_DIMS:
        gate *= GATE_FLOOR + (1 - GATE_FLOOR) * dims[k]
    total = _jsround(base * gate * 1e6) / 1e6
    return {"total": total, "dims": dims, "reasons": reasons}


# ── snapshot / program → recipe (to score real agent output) ───────────────────

def _infer_role(name: str, ttype: str, notes: list[dict]) -> str:
    if ttype == "drum":
        return "drums"
    import re
    if re.search(r"808|bass|sub", name, re.I):
        return "bass"
    if not notes:
        return "other"
    pitches = sorted(n["pitch"] for n in notes)
    return "bass" if pitches[len(pitches) // 2] < 52 else "melody"


def _normalize_production(tracks: list[dict]) -> None:
    """A melodic track with notes but no recorded instrument still plays (engine auto-loads
    4OSC) — mark it the bare default so realness counts it as stock, not unknown. Mirror of
    normalizeProduction (TS). Mutates."""
    for t in tracks:
        pr = t.get("production")
        if pr and pr.get("pads"):
            pr["pads"] = sorted(pr["pads"], key=lambda p: p["note"])
        if t.get("role") in ("melody", "bass") and t.get("notes") and not (pr and (pr.get("instrument") or pr.get("pads") or pr.get("sampleRealness"))):
            t.setdefault("production", {})["instrument"] = {"name": "4osc", "realness": "default"}


def recipe_from_snapshot(snap: dict, bars: int | None = None) -> dict:
    """Build a Recipe from a mock/native snapshot (mirror of recipeFromSnapshot). Production
    populated from what the snapshot exposes (instrument plugins, wave source, mix); the
    Sampler's drum pads are OPAQUE here, so drum-pad realness stays unobserved (neutral)."""
    tracks = []
    for t in snap.get("tracks", []):
        notes = [n for c in t.get("clips", []) for n in c.get("notes", [])]
        role = _infer_role(t.get("name", ""), t.get("type", ""), notes)
        prod: dict = {}
        inst = next((p for p in t.get("plugins", []) if p.get("isInstrument") and p.get("name")), None)
        if inst:
            prod["instrument"] = {"name": inst["name"], "realness": classify_instrument(inst["name"])}
        wave = [c.get("sourceFile") for c in t.get("clips", []) if c.get("sourceFile")]
        if wave:
            prod["sampleRealness"] = "real" if any(classify_sample(f) == "real" for f in wave) else "stock"
        if isinstance(t.get("volumeDb"), (int, float)):
            prod["volumeDb"] = float(t["volumeDb"])
        if isinstance(t.get("pan"), (int, float)):
            prod["pan"] = float(t["pan"])
        track = {"name": t.get("name", ""), "role": role, "notes": notes}
        if prod:
            track["production"] = prod
        tracks.append(track)
    _normalize_production(tracks)
    max_beat = max([0.0] + [n["start"] + n["length"] for t in tracks for n in t["notes"]])
    sess = snap.get("session", {})
    key = sess.get("key", {}) or {}
    return {
        "tempo": sess.get("tempo", 120),
        "key": {"tonic": key.get("tonic", "C"), "mode": key.get("mode", "minor")},
        "bars": bars if bars is not None else max(1, math.ceil(max_beat / 4)),
        "tracks": tracks,
    }


def recipe_from_program(commands: list[dict], bars: int | None = None) -> dict:
    """Reconstruct a Recipe from a MoshOps beat-build command program so the GRPO reward can
    score a rollout's symbolic DNA (no render). Handles the run-script shape (create_track /
    add_midi_clip / add_note with `capture` vars + "${var}" id refs) AND plain real-id args.

    Each command is {"command", "args", "capture"?}. ids resolve via capture vars first, then
    by raw id string — both map to the owning track record so notes land on the right part.
    """
    tempo = 120
    key = {"tonic": "C", "mode": "minor"}
    tracks: list[dict] = []
    var_to_track: dict[str, dict] = {}   # capture var or clip var → track record
    id_to_track: dict[str, dict] = {}    # raw engine id → track record

    def resolve(ref: Any) -> dict | None:
        if not isinstance(ref, str):
            return None
        v = ref[2:-1] if ref.startswith("${") and ref.endswith("}") else ref
        return var_to_track.get(v) or id_to_track.get(v) or var_to_track.get(ref) or id_to_track.get(ref)

    for c in commands:
        cmd = c.get("command")
        args = c.get("args", {}) or {}
        cap = c.get("capture", {}) or {}
        if cmd == "set_tempo":
            try:
                tempo = float(args.get("bpm", args.get("tempo", tempo)))
            except (TypeError, ValueError):
                pass
        elif cmd == "set_key":
            key = {"tonic": str(args.get("tonic", key["tonic"])), "mode": str(args.get("mode", key["mode"]))}
        elif cmd in ("create_track", "create_group"):
            tr = {"name": str(args.get("name", "track")), "type": str(args.get("type", "")), "role": "", "notes": []}
            tracks.append(tr)
            for var, field in cap.items():
                if field in ("trackId", "id"):
                    var_to_track[var] = tr
            if isinstance(args.get("id"), str):
                id_to_track[args["id"]] = tr
        elif cmd == "add_midi_clip":
            tr = resolve(args.get("trackId"))
            if tr is None and tracks:
                tr = tracks[-1]  # fall back to the most recent track
            if tr is not None:
                for var, field in cap.items():
                    if field in ("clipId", "id"):
                        var_to_track[var] = tr
        elif cmd == "add_note":
            tr = resolve(args.get("clipId")) or resolve(args.get("trackId"))
            if tr is None and tracks:
                tr = tracks[-1]
            if tr is not None:
                try:
                    tr["notes"].append({
                        "pitch": int(args["pitch"]), "start": float(args["start"]),
                        "length": float(args.get("length", 0.25)), "velocity": int(args.get("velocity", 100)),
                    })
                except (KeyError, TypeError, ValueError):
                    pass
        # ── PRODUCTION commands — the program path sees the real sound choices ──
        elif cmd == "assign_sample":
            tr = resolve(args.get("trackId"))
            if tr is not None:
                rn = classify_sample(str(args.get("file", "")))
                if str(args.get("mode", "drum")) == "melodic":
                    tr.setdefault("production", {})["instrument"] = {"name": str(args.get("name", "808")), "realness": rn}
                else:
                    try:
                        tr.setdefault("_pads", {})[int(args.get("note", 60))] = rn
                    except (TypeError, ValueError):
                        pass
        elif cmd == "load_drum_kit":
            tr = resolve(args.get("trackId"))
            if tr is not None:
                pads = tr.setdefault("_pads", {})
                for n in KIT_PAD_PITCHES:
                    pads.setdefault(n, "stock")   # never clobber a real assign_sample
        elif cmd == "load_plugin":
            tr = resolve(args.get("trackId"))
            if tr is not None:
                nm = str(args.get("pluginId", args.get("name", "")))
                tr.setdefault("production", {})["instrument"] = {"name": nm, "realness": classify_instrument(nm)}
        elif cmd == "load_builtin":
            tr = resolve(args.get("trackId"))
            if tr is not None:
                ty = str(args.get("type", ""))
                tr.setdefault("production", {})["instrument"] = {"name": ty, "realness": classify_instrument(ty)}
        elif cmd == "set_track_volume":
            tr = resolve(args.get("trackId"))
            if tr is not None:
                try:
                    tr.setdefault("production", {})["volumeDb"] = float(args.get("db", args.get("value", args.get("volumeDb", 0.0))))
                except (TypeError, ValueError):
                    pass
        elif cmd == "set_track_pan":
            tr = resolve(args.get("trackId"))
            if tr is not None:
                try:
                    tr.setdefault("production", {})["pan"] = float(args.get("pan", 0.0))
                except (TypeError, ValueError):
                    pass

    for tr in tracks:
        tr["role"] = _infer_role(tr["name"], tr.pop("type", ""), tr["notes"])
        pads = tr.pop("_pads", None)
        if pads:
            tr.setdefault("production", {})["pads"] = [{"note": n, "realness": pads[n]} for n in sorted(pads)]
        if not tr.get("production"):
            tr.pop("production", None)
    _normalize_production(tracks)
    max_beat = max([0.0] + [n["start"] + n["length"] for t in tracks for n in t["notes"]])
    return {
        "tempo": tempo, "key": key,
        "bars": bars if bars is not None else max(1, math.ceil(max_beat / 4)),
        "tracks": tracks,
        "productionObserved": True,
    }


if __name__ == "__main__":
    import json
    import sys
    data = json.load(sys.stdin)
    rec = data if "tracks" in data else recipe_from_program(data.get("commands", []))
    print(json.dumps(verify_recipe(rec), indent=2))
