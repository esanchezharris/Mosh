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
            by_role.setdefault(role, []).append({"path": path, "root_note": it.get("root_note"),
                                                 "root_source": it.get("root_source")})
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


def _element_key(el, fallback: str) -> str:
    """The element's key measured from ITS OWN notes (duration-weighted Krumhansl over
    pitch classes) — recipe-level source keys are inferred per PROJECT and unreliable
    per element (2026-07 factory smoke: 5/6 candidates failed the chroma key gate because
    transposition trusted the label). Falls back to the recipe key on thin/ambiguous
    material."""
    import math as _m
    notes = el.midi.notes if el and el.midi.notes else []
    if len(notes) < 6:
        return fallback
    hist = [0.0] * 12
    for n in notes:
        hist[int(n.pitch) % 12] += float(n.duration_beats)
    if sum(hist) <= 0:
        return fallback
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
    return key if score > 0.5 else fallback


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
def score_recipe(rec, request: dict) -> float:
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
    return s


def retrieve(library: list, request: dict, rng: Rng) -> list:
    """Rank the library by request fit; a tiny seeded jitter breaks ties for diversity."""
    scored = [(score_recipe(r, request) + (rng._next() % 100) / 1000.0, r) for r in library]
    scored.sort(key=lambda x: -x[0])
    return [r for _, r in scored]


def _role_pool(library: list, roles: set) -> list:
    """All (recipe, element) with a role in `roles`, across the library."""
    return [(r, e) for r in library for e in r.elements if e.role.value in roles]


# ───────────────────────────── recombination ─────────────────────────────────
@dataclass
class Provenance:
    backbone: str = ""
    sources: dict = field(default_factory=dict)   # group → source recipe id
    transpose: dict = field(default_factory=dict)  # group → semitones
    samples: dict = field(default_factory=dict)    # role → bound sample path
    key: str = ""
    tempo: float = 0.0


def _clone_element(el):
    return R.Element.model_validate(el.model_dump())


def _pick_recipe_with(role: str, ranked: list, rng: Rng):
    cands = [r for r in ranked if any(e.role.value == role for e in r.elements)]
    if not cands:
        return None
    # bias toward the better-ranked half, but allow any (cross-recipe diversity)
    top = cands[: max(1, len(cands) // 2 + 1)]
    return rng.choice(top if rng.chance(0.7) else cands)


def _element(rec, role):
    for e in rec.elements:
        if e.role.value == role:
            return e
    return None


def recombine(library: list, request: dict, rng: Rng, palette: dict) -> tuple:
    """Assemble a NEW recipe: drum-kit groove from one recipe, 808 from another, chords from a
    third, optional lead from a fourth — each transposed into one key, the 808 bound to the
    chords, and a palette sample bound per drum/808 role."""
    ranked = retrieve(library, request, rng)
    backbone = ranked[0]
    req_key = request.get("key") or backbone.meta.key.value
    req_tempo = float(request.get("tempo") or backbone.meta.tempo_bpm.value or 140)
    prov = Provenance(backbone=backbone.source.video_id, key=req_key, tempo=req_tempo)

    elements: list = []

    # 1) DRUMS — take kick+snare+hat as a coherent SET from one recipe (groove stays intact).
    drum_src = _pick_recipe_with("kick", ranked, rng) or backbone
    prov.sources["drums"] = drum_src.source.video_id
    for role in ("kick", "snare", "hat", "clap", "perc"):
        e = _element(drum_src, role)
        if e:
            elements.append(_clone_element(e))  # drums are NOT transposed (GM pad pitches)

    # 2) CHORDS — harmonic backbone (drives the 808). Pick a recipe with a pad/chords element.
    chord_src = _pick_recipe_with("pad", ranked, rng) or backbone
    chord_el = _element(chord_src, "pad")
    if chord_el:
        c = _clone_element(chord_el)
        sem = _interval(_element_key(chord_el, chord_src.meta.key.value), req_key)
        transpose_element(c, sem)
        conform_to_key(c, req_key)
        prov.sources["chords"] = chord_src.source.video_id
        prov.transpose["chords"] = sem
        elements.append(c)

    # 3) 808 — from a (possibly different) recipe; transpose, then BIND to the chord roots.
    bass_src = _pick_recipe_with("808", ranked, rng) or backbone
    bass_el = _element(bass_src, "808")
    if bass_el:
        b = _clone_element(bass_el)
        sem = _interval(_element_key(bass_el, bass_src.meta.key.value), req_key)
        transpose_element(b, sem)
        conform_to_key(b, req_key)  # binding then snaps to (already-conformed) chord roots
        prov.sources["808"] = bass_src.source.video_id
        prov.transpose["808"] = sem
        chord_now = next((e for e in elements if e.role.value == "pad"), None)
        if chord_now:
            bind_808_to_chords(b, chord_now)
        normalize_808_register(b)  # AFTER binding (pc-safe), BEFORE the sample bind below
        elements.append(b)

    # 4) LEAD — optional; include if the request asks for melody or by seeded choice.
    want_lead = request.get("lead", True) and rng.chance(0.7)
    if want_lead:
        lead_src = _pick_recipe_with("lead", ranked, rng)
        if lead_src:
            lead_el = _element(lead_src, "lead")
            le = _clone_element(lead_el)
            sem = _interval(_element_key(lead_el, lead_src.meta.key.value), req_key)
            transpose_element(le, sem)
            conform_to_key(le, req_key)
            prov.sources["lead"] = lead_src.source.video_id
            prov.transpose["lead"] = sem
            elements.append(le)

    # 5) bind a palette one-shot per role (real sounds); none → compiler falls back.
    #    pads/leads/plucks draw from the palette's 'melodic' bucket so melodies play a real
    #    repitched one-shot instead of the stock 4OSC sine patch (2026-07 "sine waves" fix).
    #    PITCH CORRECTNESS (2026-07 out-of-key audit): for pitched roles, pick the one-shot
    #    whose manifest root_note is NEAREST the phrase's center (small repitch stretch) and
    #    carry root_note on the match — the compiler MUST root the sampler at the sample's
    #    true pitch or every note renders off by the delta (measured −5..+5 st per element).
    for e in elements:
        role = e.role.value
        pool = (palette.get(role)
                or (palette.get("808") if role == "808" else None)
                or (palette.get("melodic") if role in ("pad", "lead", "pluck") else None))
        if pool:
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
                cands = [p for p in search if abs(int(p["root_note"]) - center) == best]
                pick = cands[rng._next() % len(cands)]
            else:
                pick = pool[rng._next() % len(pool)]
            e.sample_match = R.SampleMatch(status="matched", matched_path=pick["path"], distance=0.05,
                                           root_note=pick.get("root_note"))
            prov.samples[role] = pick["path"]

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
    return out, prov


def generate(request: dict, library_dir: str = LIB_DIR, seed: int = 0,
             palette: Optional[dict] = None, library: Optional[list] = None) -> tuple:
    """Top entry: request (genre/tempo/key/mood/lead) → (assembled Recipe, Provenance).
    Pass a pre-loaded `library` for batch runs — hermetic to concurrent library writes
    (a factory run died mid-batch when an ingester grew the library under it) and skips
    re-reading hundreds of files per candidate."""
    library = library if library is not None else load_library(library_dir)
    if not library:
        raise RuntimeError(f"empty recipe library at {library_dir} (run seed_authoring.py)")
    pal = palette if palette is not None else load_palette()
    rng = Rng(_seed_int(request, seed))
    return recombine(library, request, rng, pal)


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
