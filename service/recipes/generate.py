#!/usr/bin/env python3
"""§0.5 retrieval + recombination generator — the restart's generation path.

NOT template-fill. Given a request, it RETRIEVES real recipes from the library (§0.3),
RECOMBINES per-element motifs across them (drums from one, 808 from another, chords from a
third — the panel's prescription), TRANSPOSES the melodic voices into one key, BINDS the 808
to the chord roots (root-following, so a bassline can never drift into a hi-hat-like grid),
BINDS a palette one-shot per drum/808 role, and emits a §0 Recipe → MoshOps program via the
compiler. The only "generative" freedom in v1 is recombination + transposition, never free
invention — every note descends from a real recipe motif.

Deterministic given (request, seed): a tiny LCG drives every choice (no Math.random/Date).

    from recipes.generate import generate, load_library
    rec, prov = generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=7)
"""
from __future__ import annotations

import glob
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(_HERE)
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown import recipe as R  # noqa: E402

LIB_DIR = os.path.join(_HERE, "library")
# Canonical palette manifest = the DURABLE home copy (worktree copies go stale: the
# 2026-07 pitch-truth pass corrected ~/Library/Mosh/palette-v1/manifest.json while a
# gitignored repo-local duplicate silently kept serving the old labels — renders were
# byte-identical to pre-fix). Env override first, then home, then the repo-local file.
_PALETTE_HOME = os.path.expanduser("~/Library/Mosh/palette-v1/manifest.json")
_PALETTE_REPO = os.path.join(_SERVICE, "palette", "palette", "manifest.json")
PALETTE_MANIFEST = (os.environ.get("MOSH_PALETTE_MANIFEST")
                    or (_PALETTE_HOME if os.path.isfile(_PALETTE_HOME) else _PALETTE_REPO))
DRUM_ROLES = {"kick", "snare", "hat", "clap", "perc"}
MELODIC_ROLES = {"808", "bass", "lead", "pad", "pluck"}  # transposed; drums are not
BEATS_PER_BAR = 4.0

PC = {"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "F": 5, "F#": 6, "GB": 6,
      "G": 7, "G#": 8, "AB": 8, "A": 9, "A#": 10, "BB": 10, "B": 11}


# ───────────────────────────── deterministic RNG ─────────────────────────────
class Rng:
    """A small LCG so generation is reproducible from (request, seed) with no Math.random."""

    def __init__(self, seed: int):
        self.s = (seed & 0x7FFFFFFF) or 1

    def _next(self) -> int:
        self.s = (1103515245 * self.s + 12345) & 0x7FFFFFFF
        return self.s

    def choice(self, seq):
        return seq[self._next() % len(seq)] if seq else None

    def chance(self, p: float) -> bool:
        return (self._next() % 1000) < int(p * 1000)


def _seed_int(request: dict, seed: int) -> int:
    h = 2166136261
    for ch in json.dumps(request, sort_keys=True) + f"|{seed}":
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h


# ───────────────────────────── library + palette ─────────────────────────────
def load_library(lib_dir: str = LIB_DIR) -> list:
    out = []
    for p in sorted(glob.glob(os.path.join(lib_dir, "*.json"))):
        # macOS/iCloud sync-conflict copies ("x 2.json") double-load recipes and bias
        # retrieval — seen in three checkouts now (2026-07 audit). Never load them.
        if os.path.basename(p).split(".")[0].endswith(" 2"):
            continue
        out.append(R.from_json(open(p).read()))
    return out


def _mood_of(rec) -> str:
    return (rec.source.channel or "").lower()


def _key_pc_mode(key_str: str):
    parts = str(key_str or "").strip().split()
    if not parts:
        return None, "minor"
    pc = PC.get(parts[0].upper())
    mode = parts[1].lower() if len(parts) > 1 else "major"
    return pc, mode


def load_palette(manifest: str = PALETTE_MANIFEST) -> dict:
    """role → list of {path, root_note} for 44.1k palette one-shots. {} if absent (→ stock)."""
    if not os.path.isfile(manifest):
        return {}
    items = json.load(open(manifest))
    items = items["items"] if isinstance(items, dict) and "items" in items else items
    by_role: dict[str, list] = {}
    missing = 0
    for it in items:
        role = (it.get("role_guess") or it.get("role") or "").lower()
        path = it.get("path")
        if role and path and os.path.isfile(path):
            entry = {"path": path, "root_note": it.get("root_note"),
                     "root_source": it.get("root_source")}
            # sample-truth metadata (measure_palette_samples.py) — optional by design:
            # every downstream filter treats an absent field as "allowed" so a
            # pre-measure-pass manifest keeps working unchanged.
            for k in ("decayMs", "subShare", "subTailMs", "rmsDb", "openHat"):
                if k in it:
                    entry[k] = it[k]
            by_role.setdefault(role, []).append(entry)
        elif role and path:
            missing += 1
    if missing:
        # LOUD, never silent: dropped one-shots regress renders to the stock synth — the
        # owner-audible "sine waves" failure (2026-07 audit: the whole palette lived in a
        # disposable worktree; a cleanup would have silently reverted everything).
        print(f"⚠ palette: {missing} manifest one-shot(s) MISSING on disk (renders degrade "
              f"toward the stock synth) — re-run build_palette or fix asset paths: {manifest}",
              file=sys.stderr)
    return by_role


# ───────────────────────────── feature derivation ────────────────────────────
def element_bars(el) -> float:
    if el.motif and el.motif.bars:
        return el.motif.bars
    if not el.midi.notes:
        return 4.0
    end = max(n.start_beats + n.duration_beats for n in el.midi.notes)
    return max(1.0, round(end / BEATS_PER_BAR) * BEATS_PER_BAR / BEATS_PER_BAR * BEATS_PER_BAR) / BEATS_PER_BAR or 4.0


# ───────────────────────────── transposition ─────────────────────────────────
_KRUM_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KRUM_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
_PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _krumhansl_key(notes) -> tuple:
    """(key string, correlation score) from a note list via duration-weighted Krumhansl —
    ("", 0.0) on thin/silent material. The shared core of _element_key and
    measured_key_of."""
    import math as _m
    if len(notes) < 6:
        return "", 0.0
    hist = [0.0] * 12
    for n in notes:
        hist[int(n.pitch) % 12] += float(n.duration_beats)
    if sum(hist) <= 0:
        return "", 0.0
    mh = sum(hist) / 12

    def corr(profile, rot):
        p = profile[-rot:] + profile[:-rot]
        mp = sum(p) / 12
        num = sum((p[i] - mp) * (hist[i] - mh) for i in range(12))
        den = _m.sqrt(sum((x - mp) ** 2 for x in p) * sum((x - mh) ** 2 for x in hist))
        return num / den if den else 0.0

    score, key = max([(corr(_KRUM_MIN, r), f"{_PC_NAMES[r]} minor") for r in range(12)]
                     + [(corr(_KRUM_MAJ, r), f"{_PC_NAMES[r]} major") for r in range(12)],
                     key=lambda t: t[0])
    return key, score


def _element_key(el, fallback: str) -> str:
    """The element's key measured from ITS OWN notes (duration-weighted Krumhansl over
    pitch classes) — recipe-level source keys are inferred per PROJECT and unreliable
    per element (2026-07 factory smoke: 5/6 candidates failed the chroma key gate because
    transposition trusted the label). Falls back to the recipe key on thin/ambiguous
    material."""
    notes = el.midi.notes if el and el.midi.notes else []
    key, score = _krumhansl_key(notes)
    return key if score > 0.5 else fallback


def measured_key_of(rec) -> str:
    """The RECIPE's key measured from its melodic content (pad+lead+808 notes pooled).
    Used by the factory's key tripwire when a style skips conform_to_key ('disrespectful'
    = deliberately weird key): the tripwire's job is heard==written render-smear
    catching, so the reference must be what was WRITTEN, not what was requested.
    "" on thin/ambiguous content (the factory falls back to the requested key)."""
    notes = [n for e in rec.elements if e.role.value in ("pad", "lead", "808", "bass")
             for n in e.midi.notes]
    key, score = _krumhansl_key(notes)
    return key if score > 0.5 else ""


def conform_to_key(el, req_key: str):
    """Fold out-of-scale pitches into the requested key's scale (nearest scale tone,
    flatten-first). Transposition maps the TONIC but not the MODE — an F-major source
    motif requested as F minor stays major and blows the chroma key gate (factory smoke:
    rank ~6). Rhythm/octaves untouched; a semitone fold to the parallel scale is the
    standard producer move. Mutates + returns."""
    pc_root, mode = _key_pc_mode(req_key)
    if pc_root is None or not (el and el.midi.notes):
        return el
    scale = {0, 2, 3, 5, 7, 8, 10} if mode == "minor" else {0, 2, 4, 5, 7, 9, 11}
    for n in el.midi.notes:
        rel = (int(n.pitch) - pc_root) % 12
        if rel not in scale:
            for d in (1, -1, 2, -2):  # prefer flattening
                if (rel - d) % 12 in scale:
                    n.pitch = max(0, min(127, int(n.pitch) - d))
                    break
    return el


def _interval(src_key: str, req_key: str) -> int:
    """Nearest semitone shift mapping src tonic → req tonic, in [-6, 6]."""
    sp, _ = _key_pc_mode(src_key)
    rp, _ = _key_pc_mode(req_key)
    if sp is None or rp is None:
        return 0
    d = (rp - sp) % 12
    return d - 12 if d > 6 else d


def transpose_element(el, semitones: int):
    """Shift every note by `semitones`, keeping notes in 0..127 (octave-fold extremes)."""
    if semitones == 0 or not el.midi.notes:
        return el
    new = []
    for n in el.midi.notes:
        p = n.pitch + semitones
        while p > 127:
            p -= 12
        while p < 0:
            p += 12
        new.append(R.NoteEvent(pitch=p, start_beats=n.start_beats,
                               duration_beats=n.duration_beats, velocity=n.velocity))
    el.midi.notes = new
    return el


# ───────────────────────── 808 ↔ chord binding rule ──────────────────────────
def _chord_root_at(chord_notes, t: float) -> Optional[int]:
    """Root pitch of the chord active at beat t (latest chord onset ≤ t; its lowest note)."""
    active = [n for n in chord_notes if n.start_beats <= t + 1e-6]
    if not active:
        active = chord_notes
    if not active:
        return None
    last_start = max(n.start_beats for n in active)
    simultaneous = [n.pitch for n in chord_notes if abs(n.start_beats - last_start) < 1e-6]
    return min(simultaneous) if simultaneous else None


def _octave_nearest(target_pc: int, ref_pitch: int) -> int:
    """The pitch with pitch-class target_pc closest to ref_pitch (keeps the bass in register)."""
    base = ref_pitch - (ref_pitch % 12) + target_pc
    best = base
    for cand in (base - 12, base, base + 12):
        if abs(cand - ref_pitch) < abs(best - ref_pitch):
            best = cand
    return max(0, min(127, best))


def bind_808_to_chords(bass_el, chord_el):
    """Re-pitch the 808 to follow the chord roots (keeps its rhythm + register). This is the
    structural fix: the bass tracks harmony, never an undifferentiated grid. Mutates + returns."""
    if not (bass_el and chord_el and bass_el.midi.notes and chord_el.midi.notes):
        return bass_el
    croot_pc = {}
    for n in bass_el.midi.notes:
        root = _chord_root_at(chord_el.midi.notes, n.start_beats)
        if root is not None:
            n.pitch = _octave_nearest(root % 12, n.pitch)
    if bass_el.bass:
        bass_el.bass.root_follows = True
        bass_el.bass.root_element_id = chord_el.element_id
    return bass_el


# ─────────────────────── 808 register normalization ──────────────────────────
SUB_LO, SUB_HI = 24, 38  # canonical 808 sub window, C1–D2 (fundamental ~32–73 Hz)


def normalize_808_register(el, lo: int = SUB_LO, hi: int = SUB_HI):
    """Fold the whole 808/bass phrase by whole octaves (k*12) so its MEDIAN pitch lands
    in [lo, hi]. Whole-phrase shift: contour and pitch classes are preserved exactly, so
    chord-root binding stays correct and the nearest-root sample pick then searches in
    the sub register. Needed because owner-catalog 808 motifs import ~2 octaves high
    (FL piano-roll 808 patterns sit near C5 against a sub-rooted channel the importer
    never sees) and nothing downstream ever chose an absolute register — the 2026-07
    audition rated all six beats "808 too high" (medians MIDI 54.5–65, 0/50 notes in
    window). Mutates + returns."""
    if not (el and el.midi.notes):
        return el
    pitches = sorted(int(n.pitch) for n in el.midi.notes)
    med = pitches[len(pitches) // 2]
    shift = 0
    while med + shift > hi:   # window spans ≥12 semitones, so a fold never overshoots it
        shift -= 12
    while med + shift < lo:
        shift += 12
    if shift:
        for n in el.midi.notes:
            n.pitch = max(0, min(127, n.pitch + shift))
    # Audibility floor: outlier notes far below the window are inaudible-sub on most
    # systems (v2 audition beat 03 carried notes at MIDI 16 ≈ 20.6 Hz — "can't even
    # rlly hear 808"). Fold extreme outliers up an octave; the small contour break on
    # a >15 st-deep outlier beats an inaudible bass note (usually transcription noise).
    floor = lo - 3
    for n in el.midi.notes:
        while n.pitch < floor:
            n.pitch += 12
    return el


# ───────────────────────────── retrieval ─────────────────────────────────────
# Owner keep/kill priors (built by merge_labels.py from the label ledger). Same
# resolution precedent as the palette manifest: env override → durable home path → {}.
PRIORS_PATH = (os.environ.get("MOSH_SOURCE_PRIORS")
               or os.path.expanduser("~/mosh-beats/labels/source_priors.json"))


def load_priors(path: str = PRIORS_PATH) -> dict:
    """{source video_id: prior in [-1, 1]} — {} when absent (permissive-on-missing).
    NOT loaded by default in generate(): hermetic-by-default, the factory/CLI opt in."""
    if not os.path.isfile(path):
        return {}
    doc = json.load(open(path))
    return {k: float(v.get("prior", 0.0)) for k, v in (doc.get("priors") or {}).items()}


def score_recipe(rec, request: dict, priors: Optional[dict] = None) -> float:
    s = 0.0
    mood = (request.get("mood") or "").lower()
    if mood and _mood_of(rec) == mood:
        s += 3.0
    elif mood and _mood_of(rec):
        s += 0.0  # different mood, no bonus (still eligible)
    if request.get("tempo"):
        dt = abs(float(request["tempo"]) - float(rec.meta.tempo_bpm.value or 0))
        s += max(0.0, 1.0 - dt / 40.0)
    if request.get("key"):
        _, rmode = _key_pc_mode(request["key"])
        _, smode = _key_pc_mode(rec.meta.key.value)
        if rmode == smode:
            s += 0.5
    # owner keep/kill prior: ±1.0 max vs mood's +3.0 — a nudge inside a band, never a
    # ban (every recipe stays eligible, same posture as the mood scorer above)
    if priors:
        s += priors.get(rec.source.video_id, 0.0)
    return s


def retrieve(library: list, request: dict, rng: Rng, priors: Optional[dict] = None) -> list:
    """Rank the library by request fit; a tiny seeded jitter breaks ties for diversity."""
    scored = [(score_recipe(r, request, priors) + (rng._next() % 100) / 1000.0, r)
              for r in library]
    scored.sort(key=lambda x: -x[0])
    return [r for _, r in scored]


def _role_pool(library: list, roles: set) -> list:
    """All (recipe, element) with a role in `roles`, across the library."""
    return [(r, e) for r in library for e in r.elements if e.role.value in roles]


# ─────────────────────── composition floors + binding filters ─────────────────
# Pack-001 audition rules (2026-07-02). ONLY owner-dictated rules are hard here;
# everything else is a pool PREFERENCE that keeps the unfiltered pool when metadata
# is absent or survivors run thin (a stacked hard filter can silently empty the pool).

HAT_CLOSED_DECAY_MS = 250.0   # calibrated from the live palette (measure pass dry-run):
#   named-CLOSED hats all decay <150 ms (median 50); named-OPEN median 340 ms; and at
#   dense trap spacing (~200 ms between hits at 8/bar, 140 BPM) a hat ringing past
#   ~250 ms overlaps the next hit — which is exactly the beat-04 kill.
OPEN_HAT_MAX_NOTES_PER_BAR = 1.0   # owner rule: open hats ≤ ~1 per 4 beats (1/bar in 4/4)
DRUM_RMS_FLOOR_DB = -30.0     # beat-14 "snare too quiet": drop near-silent drum one-shots
KICK_SUB_TAIL_MAX_MS = 250.0  # beat-05 "multiple 808s": a kick whose 25–80 Hz tail rings
#   past ~250 ms occupies most of the inter-hit window and reads as a second 808
SUB808_MIN_SHARE = 0.5        # prefer genuinely sub-rooted 808 samples (beat-01 class)


def _notes_per_bar(el) -> float:
    if not (el and el.midi.notes):
        return 0.0
    end = max(float(n.start_beats) + float(n.duration_beats) for n in el.midi.notes)
    return len(el.midi.notes) / max(1.0, end / BEATS_PER_BAR)


# ─────────────────────────── grid-lock (pack-003 beat 12) ─────────────────────
# "out-of-time elements... make sure that everything is locked to the grid": ~21% of
# owner-catalog transcriptions carry off-grid timing (wrong-BPM transcription class;
# worst element 20% on-grid). Policy (owner-ratified): SNAP within a tight tolerance,
# EXCLUDE the unsalvageable, and NEVER snap intentional swing.
GRID_TOL = 0.06        # beats (25.7 ms @140) — inside is transcription noise, beyond is intent
GRID_FLOOR = 0.8       # post-snap on-grid fraction below this ⇒ wrong-tempo class, excluded
SWING_MAX = 0.12       # a consistent off-grid offset up to this is groove, not error
SWING_MAD = 0.02       # ...but only when the offsets cluster tightly (median abs deviation)
_GRID_STEPS = (0.25, 1.0 / 3.0)   # 1/16 grid and 1/12 triplet grid


def _grid_residual(start: float, step: float) -> float:
    g = round(start / step) * step
    return start - g


def _element_grid_step(notes) -> float:
    """The grid (straight 1/16 vs triplet 1/12) that fits the element best. Per-element
    choice, never a union: the two grids interleave within 0.083 beats, so union-snapping
    would pull a straight 0.30 note onto the 0.333 triplet line."""
    best_step, best_frac = _GRID_STEPS[0], -1.0
    for step in _GRID_STEPS:
        frac = sum(1 for n in notes if abs(_grid_residual(float(n.start_beats), step)) <= GRID_TOL) / len(notes)
        if frac > best_frac:
            best_step, best_frac = step, frac
    return best_step


def _swing_offset(residuals: list, starts: list, step: float) -> Optional[float]:
    """A tight cluster of consistent off-grid residuals AT A CONSISTENT METRIC POSITION
    = intentional swing. Returns the median offset, or None. Detected swing is PRESERVED
    (counted on-grid, never snapped).

    The metric-position test is load-bearing: a wrong-tempo drift's post-snap survivors
    also form a tight offset cluster, but they scatter across beat positions (and land
    on downbeats) — real swing delays ONE position class (e.g. every off-8th) and never
    the downbeat."""
    off = [(r, s) for r, s in zip(residuals, starts) if abs(r) > 0.02]
    if len(off) < 3:
        return None
    off_r = sorted(r for r, _ in off)
    m = off_r[len(off_r) // 2]
    if not (0.0 < abs(m) <= SWING_MAX):
        return None
    mad = sorted(abs(r - m) for r, _ in off)[len(off) // 2]
    if mad > SWING_MAD:
        return None
    per_beat = 4 if abs(step - 0.25) < 1e-9 else 3
    classes = [round((s - r) / step) % per_beat for r, s in off]
    top = max(set(classes), key=classes.count)
    if top == 0 or classes.count(top) / len(classes) < 0.8:
        return None
    return m


def snap_notes(el, tol: float = GRID_TOL, step: Optional[float] = None) -> int:
    """Snap note STARTS to the element's chosen grid when within tol; swung notes and
    durations are untouched (durations have no owner chip and zero-length risk). Mutates;
    returns the snapped count. Used by the library repair + ingest, NOT per-generation
    (generation relies on the repaired library so Gate B rhythm identity holds).

    Pass an explicit `step` when iterating to a fixed point: a ~50/50 straight/triplet
    element's argmax grid choice can flip after a snap pass and oscillate forever —
    pin the grid once, and repeated passes are monotone (notes only ever land ON grid)."""
    if not (el and el.midi.notes):
        return 0
    if step is None:
        step = _element_grid_step(el.midi.notes)
    starts = [float(n.start_beats) for n in el.midi.notes]
    residuals = [_grid_residual(s, step) for s in starts]
    swing = _swing_offset(residuals, starts, step)
    snapped = 0
    for n, r in zip(el.midi.notes, residuals):
        if abs(r) <= 1e-6:
            continue                     # already on grid (1/3 lines never hit 0.0 exactly)
        if swing is not None and abs(r - swing) <= tol:
            continue                     # groove — leave it alone
        if abs(r) <= tol:
            new = round(float(n.start_beats) - r, 6)
            if new != float(n.start_beats):
                n.start_beats = new
                snapped += 1
    return snapped


def grid_fraction(el, tol: float = GRID_TOL) -> float:
    """Fraction of notes on the element's chosen grid (exactly, within tol, or within tol
    of the detected swing offset). The exclusion floor reads this POST-snap."""
    if not (el and el.midi.notes):
        return 0.0
    step = _element_grid_step(el.midi.notes)
    starts = [float(n.start_beats) for n in el.midi.notes]
    residuals = [_grid_residual(s, step) for s in starts]
    swing = _swing_offset(residuals, starts, step)
    ok = 0
    for r in residuals:
        if abs(r) <= tol or (swing is not None and abs(r - swing) <= tol):
            ok += 1
    return ok / len(residuals)


def _grid_ok(el) -> bool:
    """Exclusion floor for the wrong-tempo transcription class. Library-calibrated:
    97 elements fail (52 pad, 35 lead, 9 hat, 1 perc — ZERO 808/kick/snare/clap), so
    the drum and bass pools are never starved by this pred."""
    return grid_fraction(el) >= GRID_FLOOR


def _has_rhythm(el) -> bool:
    """Reject chord/scale REFERENCE dumps (pack-002 audition: 'all the notes hitting at
    once on the downbeat'). 277 pack-ingested 'MIDI Scales Reference' files carry every
    note at start 0.0 — 35–48-note stacks with NO rhythm to copy, which violates the
    system's premise (every note descends from a real motif's rhythm). Rule calibrated
    on the library: ≥6 notes all at ONE instant = reference dump (the only borderline,
    a 26-note/4-start chord progression, stays legal). 1-note drones and 2-hit kicks
    are untouched."""
    if not (el and el.midi.notes):
        return False
    if len(el.midi.notes) < 6:
        return True
    return len({round(float(n.start_beats), 4) for n in el.midi.notes}) >= 2


def _rhythm_grid_ok(el) -> bool:
    """The standard melodic-element pred: has a real rhythm AND is grid-locked."""
    return _has_rhythm(el) and _grid_ok(el)


# ───────────────────────── styles (owner vocabulary, v0) ──────────────────────
# DATA not code: styles.json carries four generic knobs (retrieval bias, groove
# constraint, key policy, lead policy). The owner's encyclopedic vocabulary (the
# FX-KB pipeline) drops in later as JSON — no new code paths per style.
STYLES_PATH = os.path.join(_HERE, "styles.json")


def load_styles(path: str = STYLES_PATH) -> dict:
    """{style name: spec} — {} when absent (permissive-on-missing, the house invariant)."""
    if not os.path.isfile(path):
        return {}
    doc = json.load(open(path))
    return {k: v for k, v in doc.items() if not k.startswith("_")}


def _groove_ok(el, spec: dict) -> bool:
    """Generic groove checker: the fraction of bars containing an onset within tol of
    EVERY beatsInBar entry must reach minBarFrac. club-swag ('clap on 2 and 4') =
    beatsInBar [1.0, 3.0]."""
    if not (el and el.midi.notes):
        return False
    beats = spec.get("beatsInBar", [])
    tol = float(spec.get("tol", 0.1))
    min_frac = float(spec.get("minBarFrac", 0.75))
    if not beats:
        return True
    end = max(float(n.start_beats) for n in el.midi.notes)
    n_bars = max(1, int(end // BEATS_PER_BAR) + 1)
    starts = [float(n.start_beats) for n in el.midi.notes]
    hit_bars = 0
    for b in range(n_bars):
        if all(any(abs(s - (b * BEATS_PER_BAR + t)) <= tol for s in starts) for t in beats):
            hit_bars += 1
    return hit_bars / n_bars >= min_frac


def _distinct_ok(el, min_pitches: int = 3, min_pcs: int = 2) -> bool:
    """Melodic-variety floor (beat-03 kill: 'it was like one note'): a lead needs ≥3
    distinct pitches AND ≥2 pitch classes (an octave-jumping single-pc line still reads
    as one note). Pads are exempt by design — drones are legitimate texture."""
    if not (el and el.midi.notes):
        return False
    pitches = {int(n.pitch) for n in el.midi.notes}
    return len(pitches) >= min_pitches and len({p % 12 for p in pitches}) >= min_pcs


def distinct_pitches(el) -> int:
    return len({int(n.pitch) for n in el.midi.notes}) if el and el.midi.notes else 0


def _filter_hat_pool(pool: list, notes_per_bar: float, min_keep: int = 3) -> list:
    """Dense hat patterns must bind a CLOSED hat: not open-named AND decay ≤ threshold.
    Names certify open only (84 open-named vs 4 closed-named of 357 hats), so measured
    decay is the primary discriminator. Sparse patterns (≤1/bar) may bind anything."""
    if notes_per_bar <= OPEN_HAT_MAX_NOTES_PER_BAR:
        return pool
    kept = [p for p in pool
            if not p.get("openHat")
            and (p.get("decayMs") is None or p["decayMs"] <= HAT_CLOSED_DECAY_MS)]
    return kept if len(kept) >= min_keep else pool


def _filter_808_pool(pool: list, min_keep: int = 8) -> list:
    """Prefer 808 samples whose low end is genuinely sub-rooted."""
    kept = [p for p in pool
            if p.get("subShare") is None or p["subShare"] >= SUB808_MIN_SHARE]
    return kept if len(kept) >= min_keep else pool


def _filter_kick_pool(pool: list, bound_808: Optional[dict], min_keep: int = 5) -> list:
    """When the bound 808 is sub-heavy, avoid kicks with a long sub tail (they stack
    into a phantom second 808 — the beat-05 kill). No 808 bound → no constraint."""
    if not bound_808 or (bound_808.get("subShare") or 0.0) < 0.6:
        return pool
    kept = [p for p in pool
            if p.get("subTailMs") is None or p["subTailMs"] <= KICK_SUB_TAIL_MAX_MS]
    return kept if len(kept) >= min_keep else pool


def _filter_drum_rms(pool: list, min_keep: int = 3) -> list:
    """Drop near-silent drum one-shots (beat-14 'snare too quiet' — cheaper than any
    stem render: the level defect lives in the sample)."""
    kept = [p for p in pool
            if p.get("rmsDb") is None or p["rmsDb"] >= DRUM_RMS_FLOOR_DB]
    return kept if len(kept) >= min_keep else pool


# ───────────────────────────── song form (v0) ─────────────────────────────────
# A A′ B A, owner-chosen shape (~32 bars from an 8-bar loop). Variation is ONLY
# cloning + THINNING (removing notes) + whole-section octave shifts — no invented
# rhythm, so Gate B(2) descent holds by construction (checked modulo loopBeats).
# v2 (owner pack-005, dictated: "drum sounds seemed to trail off before the pattern
# loops. Let's fix that."): A2's tail-thin dropped kick+snare+clap for 2-4 bars — with
# a 4-bar loop that could silence EVERY backbeat in the section. Now: kick only, final
# bar only — the standard turnaround (snare/clap backbeat + hats keep time; dropping
# clap would also kill club-swag's dictated 2&4). nbars [1,1] keeps the rng draw so
# the seed stream is unchanged elsewhere.
FORM_AABA32 = {
    "name": "AABA32v2",
    "sections": [
        {"name": "A",  "ops": {}},
        {"name": "A2", "ops": {"thin": {"roles": ["kick"],
                                        "where": "tail", "nbars": [1, 1]}}},
        {"name": "B",  "ops": {"mute": ["lead"], "octave": {"808": "auto"}}},
        {"name": "A3", "ops": {}},
    ],
}


def _b_octave_shift(min_pitch: int) -> int:
    """Direction-conditional whole-section 808 shift for the B flip. −12 (the owner's
    literal octave-DROP idea) only when every post-drop fundamental stays ≥ MIDI 21
    (27.5 Hz — the established audibility floor; post-normalize library 808 minimums
    sit at p25=24/med=29, so a blanket −12 would land 16–26 Hz: below the 25–80 Hz
    sub band AND below hearing — the known 'can't even rlly hear 808' kill class).
    Otherwise flip UP an octave — the audible register flip on every system. Direction
    is logged so the next pack's chips adjudicate which flip the owner likes."""
    return -12 if min_pitch - 12 >= SUB_LO - 3 else 12


def apply_form(elements: list, plan: dict, rng: Rng, prov: "Provenance") -> None:
    """Expand the loop into the plan's sections at generate time — zero compile/schema
    change. Every element first tiles to the LOOP length (compile's own helpers = one
    source of truth), then sections clone at whole-loop offsets, so every element ends
    exactly at the arrangement end and compile._tile_notes passes notes through
    verbatim (the provable no-op). Must run BEFORE palette binding and AFTER
    normalize_808_register — the audibility-floor loop would silently undo a B-drop
    if it ran later. Mutates elements + prov (recipe.arrangement is set by recombine
    from prov.form after assembly)."""
    from teardown.render.compile import _tile_notes, _whole_bars

    note_bearing = [e for e in elements if e.midi.notes]
    if not note_bearing:
        return
    # _whole_bars returns BEATS rounded up to whole bars (not a bar count)
    loop_beats = max(_whole_bars(max(float(n.start_beats) + float(n.duration_beats)
                                     for n in e.midi.notes))
                     for e in note_bearing)
    thin_spec = next((s["ops"].get("thin") for s in plan["sections"]
                      if s["ops"].get("thin")), None)
    thin_bars = rng.choice(list(range(thin_spec["nbars"][0], thin_spec["nbars"][1] + 1))) \
        if thin_spec else 0
    b_shift = 0
    for el in note_bearing:
        base = _tile_notes(list(el.midi.notes), loop_beats)
        out = []
        for si, sec in enumerate(plan["sections"]):
            ops = sec["ops"]
            off = si * loop_beats
            if el.role.value in (ops.get("mute") or []):
                continue
            notes = base
            octv = (ops.get("octave") or {}).get(el.role.value)
            shift = 0
            if octv == "auto":
                shift = _b_octave_shift(min(int(n.pitch) for n in base))
                b_shift = shift
            thin = ops.get("thin")
            for n in notes:
                s = float(n.start_beats)
                if (thin and el.role.value in thin["roles"]
                        and s >= loop_beats - thin_bars * BEATS_PER_BAR):
                    continue        # the drums drop out for the section's tail bars
                out.append(R.NoteEvent(pitch=max(0, min(127, int(n.pitch) + shift)),
                                       start_beats=round(off + s, 6),
                                       duration_beats=n.duration_beats,
                                       velocity=n.velocity))
        el.midi.notes = out
        el.midi.note_count = len(out)
    prov.form = {"plan": plan["name"], "loopBeats": loop_beats, "thinBars": thin_bars,
                 "b808Shift": b_shift,
                 "sections": [s["name"] for s in plan["sections"]],
                 "muted": sorted({r for s in plan["sections"]
                                  for r in (s["ops"].get("mute") or [])})}


def _form_arrangement(prov: "Provenance") -> "R.Arrangement":
    """Section spans (seconds) from the applied form — the factory slices the WAV at
    these boundaries for per-section ADVISORY metrics (never a gate this pack)."""
    spb = 60.0 / max(1.0, float(prov.tempo or 140))
    lb = prov.form["loopBeats"]
    return R.Arrangement(sections=[
        R.Section(name=nm, start_s=round(i * lb * spb, 4),
                  end_s=round((i + 1) * lb * spb, 4), confidence=1.0)
        for i, nm in enumerate(prov.form["sections"])])


# ───────────────────────────── recombination ─────────────────────────────────
@dataclass
class Provenance:
    backbone: str = ""
    sources: dict = field(default_factory=dict)   # group → source recipe id
    transpose: dict = field(default_factory=dict)  # group → semitones
    samples: dict = field(default_factory=dict)    # role → bound sample path
    key: str = ""
    tempo: float = 0.0
    filters: dict = field(default_factory=dict)    # filter name → fire count (calibration!)
    priors: dict = field(default_factory=dict)     # group → applied owner keep/kill prior
    style: str = ""                                # resolved style name ("" = vanilla)
    form: dict = field(default_factory=dict)       # section plan applied ({} = plain loop)
    drum_roles: list = field(default_factory=list)  # bound drum roles (FEATURE, never a gate)
    distinct: dict = field(default_factory=dict)   # melodic role → distinct pitch count
    sub_overlap: dict = field(default_factory=dict)  # kick subTailMs × 808 subShare (logged)

    def fired(self, name: str):
        self.filters[name] = self.filters.get(name, 0) + 1


def _clone_element(el):
    return R.Element.model_validate(el.model_dump())


def _pick_recipe_with(role: str, ranked: list, rng: Rng, pred=None):
    """Pick a recipe carrying `role`; optional pred pre-filters the candidate ELEMENTS
    (e.g. the melodic-variety floor) so a doomed pick never has to be repaired later."""
    cands = [r for r in ranked
             if any(e.role.value == role and (pred is None or pred(e)) for e in r.elements)]
    if not cands:
        return None
    # bias toward the better-ranked half, but allow any (cross-recipe diversity)
    top = cands[: max(1, len(cands) // 2 + 1)]
    return rng.choice(top if rng.chance(0.7) else cands)


def _element(rec, role, pred=None):
    for e in rec.elements:
        if e.role.value == role and (pred is None or pred(e)):
            return e
    return None


REQUIRED_DRUM_GROUPS = (("kick",), ("snare", "clap"), ("hat",))


def _fill_missing_drums(elements: list, ranked: list, rng: Rng, prov: Provenance,
                        groove: Optional[dict] = None):
    """Complete a partial drum kit from per-role pools. NOT a completeness GATE and not
    a re-pick: pack-001 keeps 01 ('no drums') and 11 ('no hi-hats') prove partial kits
    can be keeps, and only 5 of 930 library recipes carry a full kick+snare+hat kit —
    a re-pick would collapse every beat onto those 5 grooves. Filling only ADDS missing
    role-groups (the picked groove is preserved), and each fill is provenance-tagged so
    the next pack's defect chips can adjudicate the distribution shift.

    `groove` (style knob): the matching role-group's pool is groove-filtered HARD, with
    a loud relax when it empties (only ~5 library snare/claps hit 2&4 today — the relax
    path is the honest one)."""
    have = {e.role.value for e in elements}
    for group in REQUIRED_DRUM_GROUPS:
        if have & set(group):
            continue
        pool = [(r, e) for r, e in _role_pool(ranked, set(group))
                if e.midi.notes and _has_rhythm(e) and _grid_ok(e)]
        if groove and set(groove.get("roles", [])) & set(group):
            grooved = [(r, e) for r, e in pool if _groove_ok(e, groove)]
            if grooved:
                pool = grooved
            else:
                prov.fired("styleGrooveRelaxed")
        if not pool:
            continue
        top = pool[: max(1, len(pool) // 2 + 1)]
        r, e = rng.choice(top if rng.chance(0.7) else pool)
        el = _clone_element(e)
        elements.append(el)
        prov.sources[f"drums_fill_{el.role.value}"] = r.source.video_id
        prov.fired(f"drumFill_{el.role.value}")


def recombine(library: list, request: dict, rng: Rng, palette: dict,
              priors: Optional[dict] = None, form: Optional[dict] = None) -> tuple:
    """Assemble a NEW recipe: drum-kit groove from one recipe, 808 from another, chords from a
    third, optional lead from a fourth — each transposed into one key, the 808 bound to the
    chords, and a palette sample bound per drum/808 role. `request["style"]` resolves an
    owner-vocabulary style (styles.json): four data knobs — retrieval bias, groove
    constraint, key policy, lead policy. Unknown/absent style ⇒ vanilla."""
    style_name = (request.get("style") or "").lower()
    style = load_styles().get(style_name) or {}
    eff_req = request
    if style.get("retrieval"):
        # inject the style's mood/tempo into a COPY for scoring only — the existing
        # mood prior does the work (no parallel retrieval mechanism)
        eff_req = dict(request)
        rb = style["retrieval"]
        if not eff_req.get("mood") and rb.get("mood"):
            eff_req["mood"] = rb["mood"]
        if not eff_req.get("tempo") and rb.get("tempoRange"):
            eff_req["tempo"] = sum(rb["tempoRange"]) / 2.0
    conform = (style.get("key") or {}).get("conform", True)
    groove = style.get("groove")
    ranked = retrieve(library, eff_req, rng, priors)
    backbone = ranked[0]
    req_key = eff_req.get("key") or backbone.meta.key.value
    req_tempo = float(eff_req.get("tempo") or backbone.meta.tempo_bpm.value or 140)
    prov = Provenance(backbone=backbone.source.video_id, key=req_key, tempo=req_tempo,
                      style=style_name if style else "")

    elements: list = []

    # 1) DRUMS — take kick+snare+hat as a coherent SET from one recipe (groove stays intact).
    drum_src = _pick_recipe_with("kick", ranked, rng, pred=_grid_ok) or backbone
    prov.sources["drums"] = drum_src.source.video_id
    for role in ("kick", "snare", "hat", "clap", "perc"):
        e = _element(drum_src, role)
        if e and e.midi.notes:  # a notes-less element would compile as a bare one-shot drop
            elements.append(_clone_element(e))  # drums are NOT transposed (GM pad pitches)
    if groove:
        # style groove (club-swag "clap on 2 and 4"): the source's own snare/clap must
        # hit the pattern or it's dropped — the FILL below replaces it from the
        # groove-filtered pool
        for e in list(elements):
            if e.role.value in set(groove.get("roles", [])) and not _groove_ok(e, groove):
                elements.remove(e)
                prov.fired("styleGrooveDrop")
    # complete a partial kit from per-role pools (a FILL, never a gate — see the helper)
    _fill_missing_drums(elements, ranked, rng, prov, groove=groove)

    # 2) CHORDS — harmonic backbone (drives the 808). Pick a recipe with a pad/chords element.
    chord_src = _pick_recipe_with("pad", ranked, rng, pred=_rhythm_grid_ok) or backbone
    chord_el = _element(chord_src, "pad", pred=_rhythm_grid_ok)
    if chord_el and chord_el.midi.notes:
        c = _clone_element(chord_el)
        sem = _interval(_element_key(chord_el, chord_src.meta.key.value), req_key)
        transpose_element(c, sem)
        if conform:  # style key policy: 'disrespectful' keeps the weird notes on purpose
            conform_to_key(c, req_key)
        prov.sources["chords"] = chord_src.source.video_id
        prov.transpose["chords"] = sem
        elements.append(c)

    # 3) 808 — from a (possibly different) recipe; transpose, then BIND to the chord roots.
    bass_src = _pick_recipe_with("808", ranked, rng, pred=_rhythm_grid_ok) or backbone
    bass_el = _element(bass_src, "808", pred=_rhythm_grid_ok)
    if bass_el and bass_el.midi.notes:
        b = _clone_element(bass_el)
        sem = _interval(_element_key(bass_el, bass_src.meta.key.value), req_key)
        transpose_element(b, sem)
        conform_to_key(b, req_key)  # the 808 ALWAYS conforms (see below)
        prov.sources["808"] = bass_src.source.video_id
        prov.transpose["808"] = sem
        chord_now = next((e for e in elements if e.role.value == "pad"), None)
        if chord_now:
            bind_808_to_chords(b, chord_now)
        if not conform:
            # OWNER RULE (pack-004 beat 02): "the wrong note is usually a note the 808
            # plays — weird notes belong in the melody, the 808 must stay in key."
            # Under conform:false the pad keeps its out-of-scale notes ON PURPOSE, and
            # bind_808_to_chords just snapped the 808 onto those weird roots — so fold
            # the 808 back into the requested scale AFTER binding.
            conform_to_key(b, req_key)
            prov.fired("bass808PostBindConform")
        normalize_808_register(b)  # AFTER binding (pc-safe), BEFORE the sample bind below
        elements.append(b)

    # 4) LEAD — optional; include if the request asks for melody or by seeded choice.
    #    Variety floor (beat-03 kill "it was like one note"): pre-filter the candidate
    #    pool — 98/296 library leads have <3 distinct pitches (90 have exactly 1);
    #    transposition preserves distinct counts so filtering raw elements is safe.
    lead_policy = style.get("lead")
    want_lead = (True if lead_policy == "require"
                 else False if lead_policy == "forbid"
                 else request.get("lead", True) and rng.chance(0.7))
    if want_lead:
        # variety AND rhythm AND grid: a scale-reference stack has plenty of distinct
        # pitches but zero rhythm (pack-002 beat 05's lead); an off-grid lead is the
        # pack-003 beat-12 "out-of-time" class
        lead_ok = lambda e: _distinct_ok(e) and _rhythm_grid_ok(e)  # noqa: E731
        lead_src = _pick_recipe_with("lead", ranked, rng, pred=lead_ok)
        if lead_src:
            lead_el = _element(lead_src, "lead", pred=lead_ok)
            le = _clone_element(lead_el)
            sem = _interval(_element_key(lead_el, lead_src.meta.key.value), req_key)
            transpose_element(le, sem)
            if conform:
                conform_to_key(le, req_key)
            # re-verify AFTER conform: folding to the parallel scale can merge two
            # source pitches onto one tone. A degraded lead is dropped, not shipped —
            # the lead is optional by design.
            if _distinct_ok(le):
                prov.sources["lead"] = lead_src.source.video_id
                prov.transpose["lead"] = sem
                elements.append(le)
            else:
                prov.fired("leadVarietyDropPostConform")

    # 4.5) SONG FORM (owner-chosen A A′ B A): expand the loop into sections BEFORE
    #      palette binding (phrase medians stay in-window) and AFTER the 808 normalize
    #      (whose audibility floor would undo a B-drop if it ran later).
    if form:
        apply_form(elements, form, rng, prov)

    # 5) bind a palette one-shot per role (real sounds); none → compiler falls back.
    #    pads/leads/plucks draw from the palette's 'melodic' bucket so melodies play a real
    #    repitched one-shot instead of the stock 4OSC sine patch (2026-07 "sine waves" fix).
    #    PITCH CORRECTNESS (2026-07 out-of-key audit): for pitched roles, pick the one-shot
    #    whose manifest root_note is NEAREST the phrase's center (small repitch stretch) and
    #    carry root_note on the match — the compiler MUST root the sampler at the sample's
    #    true pitch or every note renders off by the delta (measured −5..+5 st per element).
    #    KICK BINDS LAST: the beat-05 pairing rule ("multiple 808s" = a long-sub-tail
    #    kick stacking with the 808) needs to know which 808 sample was chosen first.
    bound_808: Optional[dict] = None
    for e in sorted(elements, key=lambda el: el.role.value == "kick"):
        role = e.role.value
        if not e.midi.notes:
            continue
        pool = (palette.get(role)
                or (palette.get("808") if role == "808" else None)
                or (palette.get("melodic") if role in ("pad", "lead", "pluck") else None))
        if pool:
            before = len(pool)
            if role in DRUM_ROLES:
                pool = _filter_drum_rms(pool)
                if len(pool) != before:
                    prov.fired("drumRmsFloor")
            if role == "hat":
                n0 = len(pool)
                pool = _filter_hat_pool(pool, _notes_per_bar(e))
                if len(pool) != n0:
                    prov.fired("hatClosedOnly")
            if role == "kick":
                n0 = len(pool)
                pool = _filter_kick_pool(pool, bound_808)
                if len(pool) != n0:
                    prov.fired("kickSubTail")
            if role == "808":
                n0 = len(pool)
                pool = _filter_808_pool(pool)
                if len(pool) != n0:
                    prov.fired("sub808Pool")
            pitched = role in ("808", "bass", "pad", "lead", "pluck")
            rooted = [p for p in pool if p.get("root_note") is not None] if pitched else []
            if pitched and rooted:
                # Prefer pitch-VERIFIED samples: the 2026-07 pitch-truth pass found 277/304
                # inferred root labels wrong (235 by ≥1 octave) — a nearest-root pick against
                # an unverified label lands the element in a random octave.
                measured = [p for p in rooted if p.get("root_source") == "measured"]
                search = measured or rooted
                pitches = sorted(int(n.pitch) for n in e.midi.notes) or [48]
                center = pitches[len(pitches) // 2]
                best = min(abs(int(p["root_note"]) - center) for p in search)
                # ±2 st window then seeded pick (not exact-tie only): a deterministic
                # nearest-root funnel put ONE pad sample in 7/14 pack-001 beats; a ±2 st
                # repitch-stretch difference is inaudible, the diversity is not.
                cands = [p for p in search if abs(int(p["root_note"]) - center) <= best + 2]
                pick = cands[rng._next() % len(cands)]
            else:
                pick = pool[rng._next() % len(pool)]
            if role == "808":
                bound_808 = pick
            e.sample_match = R.SampleMatch(status="matched", matched_path=pick["path"], distance=0.05,
                                           root_note=pick.get("root_note"))
            prov.samples[role] = pick["path"]
            if role == "kick" and bound_808 is not None:
                # logged FEATURE, not a gate: awaiting a second pack of chip evidence
                prov.sub_overlap = {"kickSubTailMs": pick.get("subTailMs"),
                                    "sub808Share": bound_808.get("subShare")}

    prov.drum_roles = sorted({e.role.value for e in elements if e.role.value in DRUM_ROLES})
    prov.distinct = {e.role.value: distinct_pitches(e)
                     for e in elements if e.role.value in ("pad", "lead", "pluck", "808")}
    if priors:
        prov.priors = {g: priors[vid] for g, vid in prov.sources.items() if vid in priors}

    out = R.Recipe(
        recipe_id=f"gen_{rng.s}",  # deterministic from (request, seed) — no uuid4 nondeterminism
        source=R.Source(platform="generated", video_id=f"gen_{rng.s}",
                        title=f"recombined: drums={prov.sources.get('drums')} "
                              f"808={prov.sources.get('808')} chords={prov.sources.get('chords')}"),
        meta=R.Meta(tempo_bpm=R.MetaField(value=req_tempo, confidence=1.0),
                    key=R.MetaField(value=req_key, confidence=1.0),
                    time_signature=R.MetaField(value="4/4", confidence=1.0)),
        elements=elements,
        reconstruction_class="inferred",
    )
    if prov.form:
        out.arrangement = _form_arrangement(prov)
    return out, prov


def generate(request: dict, library_dir: str = LIB_DIR, seed: int = 0,
             palette: Optional[dict] = None, library: Optional[list] = None,
             priors: Optional[dict] = None, form: Optional[dict] = None) -> tuple:
    """Top entry: request (genre/tempo/key/mood/lead) → (assembled Recipe, Provenance).
    Pass a pre-loaded `library` for batch runs — hermetic to concurrent library writes
    (a factory run died mid-batch when an ingester grew the library under it) and skips
    re-reading hundreds of files per candidate. `priors` (owner keep/kill nudges) are
    OPT-IN — None means none, so generation is hermetic by default; the factory/CLI
    pass load_priors() explicitly and snapshot the file per run.

    `form` is a KWARG, not a request key: _seed_int(request, seed) is unchanged, so a
    formed beat and its formless sibling share the IDENTICAL loop (free A/Bs, and the
    future cheap-balance-on-the-loop optimization)."""
    library = library if library is not None else load_library(library_dir)
    if not library:
        raise RuntimeError(f"empty recipe library at {library_dir} (run seed_authoring.py)")
    pal = palette if palette is not None else load_palette()
    rng = Rng(_seed_int(request, seed))
    return recombine(library, request, rng, pal, priors=priors, form=form)


def reconstruct(library_dir: str, recipe_id: str, palette: Optional[dict] = None):
    """Forced single-recipe reconstruction (Gate B): load ONE library recipe verbatim, bind
    palette samples, return it. No retrieval/recombination/transpose — the conditioning floor."""
    rec = next((r for r in load_library(library_dir) if r.source.video_id == recipe_id), None)
    if rec is None:
        raise KeyError(recipe_id)
    pal = palette if palette is not None else load_palette()
    rng = Rng(_seed_int({"reconstruct": recipe_id}, 0))
    for e in rec.elements:
        pool = pal.get(e.role.value)
        if pool:
            pick = pool[rng._next() % len(pool)]
            e.sample_match = R.SampleMatch(status="matched", matched_path=pick["path"], distance=0.05)
    return rec


def _main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="§0.5 retrieval+recombination generator")
    ap.add_argument("--mood", default="")
    ap.add_argument("--tempo", type=float, default=0.0)
    ap.add_argument("--key", default="")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--emit", choices=["recipe", "program"], default="recipe")
    ns = ap.parse_args(argv)
    req = {k: v for k, v in (("mood", ns.mood), ("tempo", ns.tempo or None), ("key", ns.key or None))
           if v}
    rec, prov = generate(req, seed=ns.seed)
    if ns.emit == "program":
        from teardown.render.compile import compile_recipe
        print(json.dumps(compile_recipe(rec).to_dict(), indent=2))
    else:
        print(R.to_json(rec))
    print(f"\n# provenance: {prov}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
