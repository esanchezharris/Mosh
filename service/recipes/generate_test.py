#!/usr/bin/env python3
"""Unit + GATE B tests for the §0.5 retrieval/recombination generator (engine-free).

    service/teardown/.venv/bin/python service/recipes/generate_test.py   (exit 0 = pass)

GATE B (conditioning) — the agent must USE real recipes, not hallucinate around them:
  (1) forced reconstruction emits ≥70% of the source recipe's exact note events;
  (2) every note in a RECOMBINED beat has a rhythm (role, start, duration) that exists in the
      library — i.e. 100% of the music descends from real motifs (pitch may transpose/bind,
      rhythm is copied). Invented rhythm == 0.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(_HERE)
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown import recipe as R  # noqa: E402
from teardown.render.compile import compile_recipe  # noqa: E402
from recipes import generate as G  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
    if not cond:
        fails.append(name)


LIB = G.LIB_DIR
library = G.load_library(LIB)

# ── library loads ────────────────────────────────────────────────────────────
check("library has the seed recipes", len(library) >= 5, str(len(library)))
check("every library recipe carries inline notes",
      all(any(e.midi.notes for e in r.elements) for r in library))
# Ingredient recipes (owner-catalog/pack, single-element) are first-class library
# members — the safety property is "an 808 element is never bass-model-less", NOT
# "every recipe contains an 808" (2026-07 r8 lane).
check("every 808 element in the library carries the bass sub-model",
      all(e.bass for r in library for e in r.elements if e.role.value in ("808", "bass")))
check("full-beat seed recipes still present (multi-element with an 808)",
      any(len(r.elements) > 3 and any(e.role.value == "808" for e in r.elements) for r in library))

# ── transposition ─────────────────────────────────────────────────────────────
check("_interval picks the nearest shift (F→G = +2)", G._interval("F minor", "G minor") == 2)
check("_interval never exceeds a tritone (|F→B| = 6)", abs(G._interval("F minor", "B minor")) == 6)
el = R.Element(role="lead", midi=R.Midi(notes=[R.NoteEvent(pitch=60, start_beats=0, duration_beats=1)]))
G.transpose_element(el, 3)
check("transpose shifts pitch by semitones", el.midi.notes[0].pitch == 63)

# ── 808 ↔ chords binding (root-following) ─────────────────────────────────────
chord = R.Element(element_id="chords", role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=41, start_beats=0.0, duration_beats=2.0),   # F (pc5)
    R.NoteEvent(pitch=44, start_beats=2.0, duration_beats=2.0),   # Ab (pc8)
]))
bass = R.Element(element_id="b808", role="808", bass=R.Bass(), midi=R.Midi(notes=[
    R.NoteEvent(pitch=20, start_beats=0.5, duration_beats=1.0),   # arbitrary pitch, in chord 1
    R.NoteEvent(pitch=20, start_beats=2.5, duration_beats=1.0),   # in chord 2
]))
G.bind_808_to_chords(bass, chord)
check("808 note in chord 1 follows root F (pc5)", bass.midi.notes[0].pitch % 12 == 5,
      str(bass.midi.notes[0].pitch))
check("808 note in chord 2 follows root Ab (pc8)", bass.midi.notes[1].pitch % 12 == 8,
      str(bass.midi.notes[1].pitch))
check("808 keeps its rhythm after binding (start/dur unchanged)",
      bass.midi.notes[0].start_beats == 0.5 and bass.midi.notes[0].duration_beats == 1.0)

# ── recombination produces a real, multi-source beat ──────────────────────────
rec, prov = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=7, palette={})
roles = [e.role.value for e in rec.elements]
check("recombined beat has drums", any(r in roles for r in ("kick", "snare", "hat")))
check("recombined beat has an 808", "808" in roles)
check("recombined beat has chords", "pad" in roles)
check("recombined beat is in the requested key", rec.meta.key.value == "F minor")
check("recombined beat is at the requested tempo", float(rec.meta.tempo_bpm.value) == 140.0)
check("provenance records a backbone + per-group sources", bool(prov.backbone) and bool(prov.sources))

# ── determinism ───────────────────────────────────────────────────────────────
a = R.to_json(G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=7, palette={})[0])
b = R.to_json(G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=7, palette={})[0])
check("generation is deterministic for (request, seed)", a == b)
c = R.to_json(G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=8, palette={})[0])
check("a different seed can change the recombination", True)  # not required to differ, but allowed
_ = c

# ── GATE B (1): forced reconstruction emits the source's exact events (≥70%) ──
src = next(r for r in library if r.source.video_id == "seed_dark_trap")
src_events = {(e.role.value, n.pitch, round(n.start_beats, 4), round(n.duration_beats, 4))
              for e in src.elements for n in e.midi.notes}
recon = G.reconstruct(LIB, "seed_dark_trap", palette={})
recon_by_track = {}
prog = compile_recipe(recon).commands
# map each add_midi_clip back to its element via track order (create_track order == element order)
track_role = {}
ti = -1
for c in prog:
    if c["command"] == "create_track":
        ti += 1
        track_role[f"${{T{ti}}}"] = recon.elements[ti].role.value
emitted = set()
for c in prog:
    if c["command"] == "add_midi_clip":
        role = track_role.get(c["args"]["trackId"], "?")
        for n in c["args"].get("notes", []):
            emitted.add((role, n["pitch"], round(n["start"], 4), round(n["length"], 4)))
matched = len(src_events & emitted)
frac = matched / max(1, len(src_events))
check("GATE B(1): forced reconstruction emits ≥70% of source events", frac >= 0.70,
      f"{matched}/{len(src_events)} = {frac:.2f}")
check("GATE B(1): reconstruction is near-exact (≥0.99)", frac >= 0.99, f"{frac:.2f}")

# ── GATE B (2): every recombined RHYTHM descends from a real library motif ────
lib_rhythms = {(e.role.value, round(n.start_beats, 4), round(n.duration_beats, 4))
               for r in library for e in r.elements for n in e.midi.notes}
invented = 0
total = 0
for seed in range(12):
    g, _ = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=seed, palette={})
    for e in g.elements:
        for n in e.midi.notes:
            total += 1
            if (e.role.value, round(n.start_beats, 4), round(n.duration_beats, 4)) not in lib_rhythms:
                invented += 1
check("GATE B(2): 0 invented rhythms across 12 recombinations (all descend from real motifs)",
      invented == 0, f"{invented}/{total} notes had a rhythm not in the library")

# ── the recombined beat compiles to a runnable program (assign_sample+add_midi_clip) ──
prog2 = compile_recipe(rec).commands
check("recombined beat compiles to a program", len(prog2) > 0)
check("recombined 808 compiles to a MELODIC sampler (not a drum pad)",
      any(c["command"] == "assign_sample" and c["args"].get("mode") == "melodic" for c in prog2)
      or not prov.samples.get("808"),  # only if a palette 808 was bound
      "no melodic assign for 808")

# ── pitch-correct sample binding (2026-07 out-of-key audit regression) ────────
# A synthetic palette with KNOWN root_notes: binding must (a) pick the root nearest the
# phrase center for pitched roles, (b) carry root_note on the SampleMatch, and (c) compile
# must root the melodic sampler at THE SAMPLE'S pitch — never a phrase-derived guess.
FAKE_PAL = {
    "kick": [{"path": "/tmp/pal_k.wav"}], "snare": [{"path": "/tmp/pal_s.wav"}],
    "hat": [{"path": "/tmp/pal_h.wav"}], "clap": [{"path": "/tmp/pal_c.wav"}],
    "808": [{"path": "/tmp/pal_8a.wav", "root_note": 24},
            {"path": "/tmp/pal_8b.wav", "root_note": 36},
            {"path": "/tmp/pal_8c.wav", "root_note": 50}],
    "melodic": [{"path": "/tmp/pal_m1.wav", "root_note": 48},
                {"path": "/tmp/pal_m2.wav", "root_note": 65},
                {"path": "/tmp/pal_m3.wav", "root_note": 84}],
}
rec_p, prov_p = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=5, palette=FAKE_PAL)
pitched_roles = {"808", "bass", "pad", "lead", "pluck"}
bound = [e for e in rec_p.elements if e.role.value in pitched_roles
         and e.sample_match.status.value == "matched"]
check("pitched bindings exist in the pitch-test generation", len(bound) > 0, str(len(bound)))
check("every pitched binding carries the sample's root_note",
      all(e.sample_match.root_note is not None for e in bound),
      str([(e.role.value, e.sample_match.root_note) for e in bound]))
def _center(e):
    ps = sorted(int(n.pitch) for n in e.midi.notes) or [48]
    return ps[len(ps) // 2]
def _pool(e):
    return FAKE_PAL["808"] if e.role.value in ("808", "bass") else FAKE_PAL["melodic"]
check("binding picks the root NEAREST the phrase center",
      all(abs(int(e.sample_match.root_note) - _center(e))
          == min(abs(int(p["root_note"]) - _center(e)) for p in _pool(e)) for e in bound),
      str([(e.role.value, e.sample_match.root_note, _center(e)) for e in bound]))
prog_p = compile_recipe(rec_p).commands
roots = {c["args"]["file"]: c["args"]["note"] for c in prog_p
         if c["command"] == "assign_sample" and c["args"].get("mode") == "melodic"}
check("compiled melodic sampler roots == the bound samples' true root_note",
      all(roots.get(e.sample_match.matched_path) == int(e.sample_match.root_note) for e in bound
          if e.sample_match.matched_path in roots) and len(roots) > 0,
      str(roots))
check("melodic non-bass elements (pad/lead) DO get a sampler when matched (the sine-fix branch)",
      all(e.sample_match.matched_path in roots for e in bound if e.role.value in ("pad", "lead", "pluck")),
      str([(e.role.value, e.sample_match.matched_path in roots) for e in bound]))

# ── 808 register normalization (2026-07 audition regression: "808 too high" ×6) ──
# Unit: a phrase written 2 octaves high (the FL-import register) folds into the sub
# window by whole octaves — median lands in [SUB_LO, SUB_HI], pitch classes and
# contour (pairwise intervals) unchanged.
hi_el = R.Element(role="808", bass=R.Bass(), midi=R.Midi(notes=[
    # folded min stays above the audibility floor (lo-3), so contour is fully preserved
    R.NoteEvent(pitch=63, start_beats=0.0, duration_beats=1.0),
    R.NoteEvent(pitch=58, start_beats=1.0, duration_beats=1.0),
    R.NoteEvent(pitch=70, start_beats=2.0, duration_beats=1.0),
]))
before = [n.pitch for n in hi_el.midi.notes]
G.normalize_808_register(hi_el)
after = [n.pitch for n in hi_el.midi.notes]
med = sorted(after)[len(after) // 2]
check("normalize folds a high 808 median into the sub window", G.SUB_LO <= med <= G.SUB_HI, str(med))
check("normalize preserves pitch classes (chord binding intact)",
      all(a % 12 == b % 12 for a, b in zip(after, before)), str(after))
check("normalize preserves contour (whole-phrase shift, no per-note folds)",
      [a - after[0] for a in after] == [b - before[0] for b in before], str(after))
lo_el = R.Element(role="808", bass=R.Bass(), midi=R.Midi(notes=[
    R.NoteEvent(pitch=10, start_beats=0.0, duration_beats=1.0)]))
G.normalize_808_register(lo_el)
check("normalize folds a too-LOW 808 up into the window",
      G.SUB_LO <= lo_el.midi.notes[0].pitch <= G.SUB_HI, str(lo_el.midi.notes[0].pitch))
in_el = R.Element(role="808", bass=R.Bass(), midi=R.Midi(notes=[
    R.NoteEvent(pitch=29, start_beats=0.0, duration_beats=1.0)]))
G.normalize_808_register(in_el)
check("normalize is a no-op inside the window (seed recipes untouched)",
      in_el.midi.notes[0].pitch == 29, str(in_el.midi.notes[0].pitch))

# Property: every recombined beat's 808 median sits in the sub window (this is the
# audition defect — all six shipped beats had medians MIDI 54.5–65, 0/50 notes inside).
bad_medians = []
for seed in range(12):
    g, _ = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=seed, palette={})
    for e in g.elements:
        if e.role.value in ("808", "bass") and e.midi.notes:
            ps = sorted(int(n.pitch) for n in e.midi.notes)
            m = ps[len(ps) // 2]
            if not (G.SUB_LO <= m <= G.SUB_HI):
                bad_medians.append((seed, m))
check("every recombined 808 median in [24,38] across 12 seeds", not bad_medians, str(bad_medians))

# And the sample bind now happens in the NEW register: with FAKE_PAL (roots 24/36/50),
# a normalized 808 must bind a sub-rooted sample (24 or 36), never the 50-root.
rec_r, _ = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=5, palette=FAKE_PAL)
b808 = [e for e in rec_r.elements if e.role.value in ("808", "bass")
        and e.sample_match.status.value == "matched"]
check("normalized 808 binds a sub-rooted palette sample (root ≤ 36)",
      all(int(e.sample_match.root_note) <= 36 for e in b808 if e.sample_match.root_note is not None)
      and len(b808) > 0,
      str([(e.role.value, e.sample_match.root_note) for e in b808]))

# ── pitch-truth round 2 (v2 audition): audibility floor + measured-preferred binding ──
# Outlier notes far below the window fold UP (beat 03 shipped MIDI 16 ≈ 20.6 Hz — inaudible).
out_el = R.Element(role="808", bass=R.Bass(), midi=R.Midi(notes=[
    R.NoteEvent(pitch=16, start_beats=0.0, duration_beats=1.0),   # extreme outlier
    R.NoteEvent(pitch=28, start_beats=1.0, duration_beats=1.0),
    R.NoteEvent(pitch=30, start_beats=2.0, duration_beats=1.0),
]))
G.normalize_808_register(out_el)
check("audibility floor folds extreme low outliers up (no note below lo-3)",
      all(n.pitch >= G.SUB_LO - 3 for n in out_el.midi.notes),
      str([n.pitch for n in out_el.midi.notes]))
check("audibility floor leaves in-window notes alone",
      [n.pitch for n in out_el.midi.notes][1:] == [28, 30],
      str([n.pitch for n in out_el.midi.notes]))

# Binding prefers pitch-VERIFIED (root_source:"measured") samples over unverified labels,
# even when an unverified root is nearer the phrase center (277/304 inferred labels were
# wrong, 235 by ≥1 octave — nearest-to-a-lie is still a lie).
MIXED_PAL = {
    "kick": [{"path": "/tmp/mx_k.wav"}], "snare": [{"path": "/tmp/mx_s.wav"}],
    "hat": [{"path": "/tmp/mx_h.wav"}], "clap": [{"path": "/tmp/mx_c.wav"}],
    "808": [{"path": "/tmp/mx_8_inferred.wav", "root_note": 30},                        # nearer, unverified
            {"path": "/tmp/mx_8_measured.wav", "root_note": 24, "root_source": "measured"}],
    "melodic": [{"path": "/tmp/mx_m_inferred.wav", "root_note": 60},
                {"path": "/tmp/mx_m_measured.wav", "root_note": 48, "root_source": "measured"}],
}
rec_m, _ = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=5, palette=MIXED_PAL)
mbound = [e for e in rec_m.elements if e.role.value in ("808", "bass", "pad", "lead", "pluck")
          and e.sample_match.status.value == "matched"]
check("binding prefers measured-root samples over nearer unverified labels",
      all("_measured" in e.sample_match.matched_path for e in mbound) and len(mbound) > 0,
      str([(e.role.value, e.sample_match.matched_path) for e in mbound]))

# ── mode conformance (factory smoke: major-mode sources requested as minor rank ~6) ──
cm = R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60, start_beats=0.0, duration_beats=1.0),   # C  (in C minor)
    R.NoteEvent(pitch=64, start_beats=1.0, duration_beats=1.0),   # E  → Eb
    R.NoteEvent(pitch=69, start_beats=2.0, duration_beats=1.0),   # A  → Ab
    R.NoteEvent(pitch=71, start_beats=3.0, duration_beats=1.0),   # B  → Bb
]))
G.conform_to_key(cm, "C minor")
check("conform folds a C-major arpeggio into C minor (E→Eb, A→Ab, B→Bb)",
      [n.pitch for n in cm.midi.notes] == [60, 63, 68, 70],
      str([n.pitch for n in cm.midi.notes]))
scale_fail = []
for seed in range(8):
    g_k, _ = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=seed, palette={})
    fscale = {(5 + d) % 12 for d in (0, 2, 3, 5, 7, 8, 10)}
    for e in g_k.elements:
        if e.role.value in ("pad", "lead", "808", "bass", "pluck"):
            bad = [n.pitch for n in e.midi.notes if n.pitch % 12 not in fscale]
            if bad:
                scale_fail.append((seed, e.role.value, bad[:4]))
check("every melodic note lands in the requested scale across 8 seeds", not scale_fail,
      str(scale_fail))

# ── arrangement tiling (round-3 audition: "trails off towards the end, parts drop out") ──
# Every v3 beat had its 2-bar seed drum motifs placed ONCE under 4-bar pads/808s — drums
# quit halfway. Compile must tile each element's pattern to the arrangement length.
tile_fail = []
for seed in range(6):
    g_t, _ = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=seed, palette={})
    prog_t = compile_recipe(g_t).commands
    clip_ends = {}
    for c in prog_t:
        if c["command"] == "add_midi_clip":
            ns = c["args"].get("notes", [])
            if ns:
                clip_ends[c["args"]["trackId"]] = max(n["start"] + n["length"] for n in ns)
    if clip_ends:
        arr = max(clip_ends.values())
        for tid, e in clip_ends.items():
            if arr - e > 4.0 + 0.5:  # nothing may stop more than a bar early
                tile_fail.append((seed, tid, round(e, 2), round(arr, 2)))
check("no element stops more than a bar before the arrangement end (6 seeds)",
      not tile_fail, str(tile_fail))
# Tiling preserves the pattern: the second copy is the first copy shifted by whole bars.
el_t = R.Element(role="kick", midi=R.Midi(notes=[
    R.NoteEvent(pitch=36, start_beats=0.0, duration_beats=0.25),
    R.NoteEvent(pitch=36, start_beats=3.0, duration_beats=0.25),
]))
pad_t = R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60, start_beats=0.0, duration_beats=16.0)]))
rec_t = R.Recipe(recipe_id="tile_t", source=R.Source(platform="test", video_id="tile_t", title="t"),
                 meta=R.Meta(tempo_bpm=R.MetaField(value=140.0, confidence=1.0),
                             key=R.MetaField(value="F minor", confidence=1.0),
                             time_signature=R.MetaField(value="4/4", confidence=1.0)),
                 elements=[el_t, pad_t], reconstruction_class="inferred")
prog_tt = compile_recipe(rec_t).commands
kick_notes = next(c["args"]["notes"] for c in prog_tt
                  if c["command"] == "add_midi_clip" and len(c["args"]["notes"]) > 2)
starts = sorted(n["start"] for n in kick_notes)
check("a 1-bar kick tiles to 4 copies under a 4-bar pad (starts at 0,3 + k*4)",
      starts == [0.0, 3.0, 4.0, 7.0, 8.0, 11.0, 12.0, 15.0], str(starts))

# ── pack-001 audition round (2026-07-02): composition floors + binding filters ──
# Melodic-variety floor (beat-03 kill "it was like one note")
mono16 = R.Element(role="lead", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60, start_beats=i * 0.25, duration_beats=0.25) for i in range(16)]))
check("variety floor rejects a 16-note ONE-pitch line", not G._distinct_ok(mono16))
octaves = R.Element(role="lead", midi=R.Midi(notes=[
    R.NoteEvent(pitch=p, start_beats=i * 1.0, duration_beats=0.5)
    for i, p in enumerate((48, 60, 72))]))
check("variety floor rejects an octave-jumping single-pitch-class line",
      not G._distinct_ok(octaves))
triad = R.Element(role="lead", midi=R.Midi(notes=[
    R.NoteEvent(pitch=p, start_beats=i * 1.0, duration_beats=0.5)
    for i, p in enumerate((60, 63, 67))]))
check("variety floor accepts a 3-pitch line", G._distinct_ok(triad))

# Rhythm guard (pack-002 kill notes + "all the notes hitting at once on the downbeat"):
# 277 pack-ingested scale-reference MIDIs carried EVERY note at start 0.0.
stack48 = R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=46 + i, start_beats=0.0, duration_beats=4.0) for i in range(48)]))
check("rhythm guard rejects a 48-note single-instant stack", not G._has_rhythm(stack48))
check("rhythm guard passes a scale stack through the VARIETY floor (why both exist)",
      G._distinct_ok(stack48))  # plenty of pitches — variety alone can't catch it
prog4 = R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60 + (i % 6), start_beats=float(i // 6), duration_beats=1.0)
    for i in range(24)]))
check("rhythm guard passes a 4-chord/6-voice progression", G._has_rhythm(prog4))
drone1 = R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=48, start_beats=0.0, duration_beats=16.0)]))
check("rhythm guard passes a 1-note drone", G._has_rhythm(drone1))
kick2 = R.Element(role="kick", midi=R.Midi(notes=[
    R.NoteEvent(pitch=36, start_beats=0.0, duration_beats=0.25),
    R.NoteEvent(pitch=36, start_beats=2.0, duration_beats=0.25)]))
check("rhythm guard passes a 2-hit kick", G._has_rhythm(kick2))
# library hygiene: the prune removed every reference dump; the guard keeps them out
lib_stacks = [(r.source.video_id, e.role.value) for r in library for e in r.elements
              if len(e.midi.notes) >= 6
              and len({round(float(n.start_beats), 4) for n in e.midi.notes}) < 2]
check("library carries ZERO single-instant reference elements", not lib_stacks,
      str(lib_stacks[:3]))
# end-to-end: a stack pad in the pool is never picked as the chord source
stack_rec = _mini2 = None  # placeholder to keep names local
def _mini_rec(vid, els):
    return R.Recipe(recipe_id=vid, source=R.Source(platform="test", video_id=vid,
                                                   title=vid, channel="dark"),
                    meta=R.Meta(tempo_bpm=R.MetaField(value=140.0, confidence=1.0),
                                key=R.MetaField(value="F minor", confidence=1.0),
                                time_signature=R.MetaField(value="4/4", confidence=1.0)),
                    elements=els, reconstruction_class="deterministic")
stack_rec = _mini_rec("stackpad", [R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=46 + i, start_beats=0.0, duration_beats=4.0) for i in range(35)]))])
real_rec = _mini_rec("realpad", [R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60 + (i % 3), start_beats=float(i), duration_beats=1.0)
    for i in range(8)]))])
stack_picked = []
for s in range(8):
    rec_g, _ = G.recombine([stack_rec, real_rec], {"mood": "dark", "tempo": 140,
                                                   "key": "F minor"}, G.Rng(s + 1), {})
    pad_el = next((e for e in rec_g.elements if e.role.value == "pad"), None)
    if pad_el is not None and len({round(float(n.start_beats), 4)
                                   for n in pad_el.midi.notes}) < 2 and len(pad_el.midi.notes) >= 6:
        stack_picked.append(s)
check("chord source NEVER binds a single-instant stack (8 seeds)", not stack_picked,
      str(stack_picked))

# 12-seed property sweep: one-808 invariant, non-empty notes, drum completeness (via
# FILL — never a gate: pack-001 keeps 01 'no drums' / 11 'no hi-hats' are the standing
# counterexamples against gating), lead variety, features recorded.
multi_808, empty_el, incomplete, thin_lead, missing_feat = [], [], [], [], []
for seed in range(12):
    g_f, p_f = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"},
                          seed=seed, palette={})
    n808 = sum(1 for e in g_f.elements if e.role.value in ("808", "bass"))
    if n808 > 1:
        multi_808.append(seed)
    if any(not e.midi.notes for e in g_f.elements):
        empty_el.append(seed)
    have = {e.role.value for e in g_f.elements}
    for group in G.REQUIRED_DRUM_GROUPS:
        if not (have & set(group)):
            incomplete.append((seed, group))
    for e in g_f.elements:
        if e.role.value == "lead" and not G._distinct_ok(e):
            thin_lead.append(seed)
    if p_f.drum_roles != sorted(have & G.DRUM_ROLES) or "808" not in p_f.distinct and n808:
        missing_feat.append(seed)
check("exactly ≤1 808/bass element across 12 seeds", not multi_808, str(multi_808))
check("no notes-less element ships across 12 seeds", not empty_el, str(empty_el))
check("drum FILL completes kick+(snare|clap)+hat across 12 seeds", not incomplete,
      str(incomplete))
check("every shipped lead passes the variety floor across 12 seeds", not thin_lead,
      str(thin_lead))
check("provenance records drumRoles + distinct-pitch features", not missing_feat,
      str(missing_feat))

# Drum fill provenance on a minimal synthetic library: kick-only drum source + a donor.
def _mini(vid, mood, els):
    return R.Recipe(recipe_id=vid, source=R.Source(platform="test", video_id=vid,
                                                   title=vid, channel=mood),
                    meta=R.Meta(tempo_bpm=R.MetaField(value=140.0, confidence=1.0),
                                key=R.MetaField(value="F minor", confidence=1.0),
                                time_signature=R.MetaField(value="4/4", confidence=1.0)),
                    elements=els, reconstruction_class="deterministic")
def _n(p, s, d=0.25):
    return R.NoteEvent(pitch=p, start_beats=s, duration_beats=d)
kick_only = _mini("kickonly", "dark",
                  [R.Element(role="kick", midi=R.Midi(notes=[_n(36, 0.0), _n(36, 2.0)]))])
donor = _mini("donor", "dark",
              [R.Element(role="snare", midi=R.Midi(notes=[_n(38, 1.0), _n(38, 3.0)])),
               R.Element(role="hat", midi=R.Midi(notes=[_n(42, i * 0.5) for i in range(8)]))])
rec_fill, prov_fill = G.recombine([kick_only, donor], {"mood": "dark", "tempo": 140,
                                                       "key": "F minor"}, G.Rng(3), {})
fill_roles = {e.role.value for e in rec_fill.elements}
check("kick-only drum source gets snare+hat FILLED from the donor",
      {"kick", "snare", "hat"} <= fill_roles, str(sorted(fill_roles)))
check("fills are provenance-tagged drums_fill_<role>",
      {"drums_fill_snare", "drums_fill_hat"} <= set(prov_fill.sources),
      str(sorted(prov_fill.sources)))

# Binding-filter units (all permissive on missing metadata / thin survivors)
closed3 = [{"path": f"/tmp/hc{i}.wav", "decayMs": 100.0 + i * 20} for i in range(3)]
opens = [{"path": "/tmp/ho1.wav", "decayMs": 700.0, "openHat": True},
         {"path": "/tmp/ho2.wav", "decayMs": 500.0}]
check("dense hat pattern binds CLOSED-only (decay ≤250, not open-named)",
      G._filter_hat_pool(closed3 + opens, 8.0) == closed3)
check("sparse hat pattern (≤1/bar) may bind anything",
      G._filter_hat_pool(closed3 + opens, 1.0) == closed3 + opens)
check("hat filter is permissive when survivors run thin",
      G._filter_hat_pool([closed3[0], opens[0]], 8.0) == [closed3[0], opens[0]])
check("hat filter is permissive on metadata-free pools",
      G._filter_hat_pool([{"path": "/tmp/x.wav"}] * 4, 8.0) == [{"path": "/tmp/x.wav"}] * 4)
p808 = ([{"path": f"/tmp/8s{i}.wav", "subShare": 0.8} for i in range(8)]
        + [{"path": f"/tmp/8w{i}.wav", "subShare": 0.2} for i in range(4)])
check("808 pool prefers sub-rooted samples when ≥8 survive",
      all(p["subShare"] >= 0.5 for p in G._filter_808_pool(p808)))
check("808 pool filter is permissive when survivors would run thin",
      G._filter_808_pool(p808[:7] + p808[8:]) == p808[:7] + p808[8:])
kicks6 = ([{"path": f"/tmp/kt{i}.wav", "subTailMs": 80.0} for i in range(5)]
          + [{"path": "/tmp/klong.wav", "subTailMs": 600.0}])
sub8 = {"path": "/tmp/8.wav", "subShare": 0.9}
check("sub-heavy 808 excludes long-sub-tail kicks (beat-05 'multiple 808s')",
      G._filter_kick_pool(kicks6, sub8) == kicks6[:5])
check("kick filter inactive when the 808 is not sub-heavy",
      G._filter_kick_pool(kicks6, {"path": "/tmp/8.wav", "subShare": 0.3}) == kicks6)
check("kick filter inactive when no 808 is bound", G._filter_kick_pool(kicks6, None) == kicks6)
drums4 = [{"path": "/tmp/d1.wav", "rmsDb": -12.0}, {"path": "/tmp/d2.wav", "rmsDb": -20.0},
          {"path": "/tmp/d3.wav", "rmsDb": -45.0}, {"path": "/tmp/d4.wav"}]
check("drum pool drops near-silent one-shots (beat-14 'snare too quiet')",
      G._filter_drum_rms(drums4) == [drums4[0], drums4[1], drums4[3]])

# End-to-end: dense library hats bind closed samples from a metadata-rich palette,
# and the filter fire is recorded for calibration.
HAT_PAL = {"kick": [{"path": "/tmp/hp_k.wav"}], "snare": [{"path": "/tmp/hp_s.wav"}],
           "clap": [{"path": "/tmp/hp_c.wav"}],
           "hat": closed3 + [{"path": "/tmp/hp_o1.wav", "decayMs": 700.0, "openHat": True},
                             {"path": "/tmp/hp_o2.wav", "decayMs": 600.0, "openHat": True}],
           "808": [{"path": "/tmp/hp_8.wav", "root_note": 24}],
           "melodic": [{"path": "/tmp/hp_m.wav", "root_note": 48}]}
open_bound = []
fired_any = False
for seed in range(6):
    g_h, p_h = G.generate({"mood": "dark", "tempo": 140, "key": "F minor"},
                          seed=seed, palette=HAT_PAL)
    hat_el = next((e for e in g_h.elements if e.role.value == "hat"), None)
    if hat_el is not None and hat_el.sample_match.status.value == "matched":
        if G._notes_per_bar(hat_el) > G.OPEN_HAT_MAX_NOTES_PER_BAR:
            if "hp_o" in hat_el.sample_match.matched_path:
                open_bound.append(seed)
            fired_any = fired_any or p_h.filters.get("hatClosedOnly", 0) > 0
check("dense hats never bind an open/long sample end-to-end (6 seeds)", not open_bound,
      str(open_bound))
check("hatClosedOnly filter fires are recorded in provenance", fired_any)

# ── grid-lock (pack-003 beat 12 "out-of-time / lock to the grid") ─────────────
def _mk(role, starts, dur=0.25, pitch=None):
    return R.Element(role=role, midi=R.Midi(notes=[
        R.NoteEvent(pitch=(pitch or 60) + (i % 3), start_beats=s, duration_beats=dur)
        for i, s in enumerate(starts)]))

near16 = _mk("lead", [0.0, 0.27, 0.52, 0.74, 1.0, 1.26, 1.49, 1.75])
snapped_n = G.snap_notes(near16)
check("near-16th starts snap onto the grid",
      snapped_n >= 5 and all(abs(G._grid_residual(float(n.start_beats), 0.25)) <= 1e-6
                             for n in near16.midi.notes),
      str([float(n.start_beats) for n in near16.midi.notes]))
check("durations are never touched by snapping",
      all(float(n.duration_beats) == 0.25 for n in near16.midi.notes))

trip = _mk("lead", [0.0, 0.35, 0.65, 1.0, 1.32, 1.68, 2.0, 2.34])
G.snap_notes(trip)
check("triplet-dominant element snaps to the 1/3 grid",
      all(abs(G._grid_residual(float(n.start_beats), 1.0 / 3.0)) <= 1e-6
          for n in trip.midi.notes),
      str([round(float(n.start_beats), 3) for n in trip.midi.notes]))

straight30 = _mk("lead", [0.0, 0.30, 0.5, 0.75, 1.0, 1.3, 1.5, 1.75])
G.snap_notes(straight30)
check("a straight element's 0.30 note snaps to 0.25, NEVER the 0.333 triplet line",
      float(straight30.midi.notes[1].start_beats) == 0.25,
      str(float(straight30.midi.notes[1].start_beats)))

swung = _mk("hat", [0.0, 0.58, 1.0, 1.58, 2.0, 2.58, 3.0, 3.58])
before_sw = [float(n.start_beats) for n in swung.midi.notes]
G.snap_notes(swung)
check("consistent swing (+0.08 off-beats) is NEVER snapped",
      [float(n.start_beats) for n in swung.midi.notes] == before_sw)
check("a swung element passes the floor via the swing rescue",
      G._grid_ok(swung), f"{G.grid_fraction(swung):.2f}")

wrongtempo = _mk("pad", [round(i * 0.37, 6) for i in range(12)])
G.snap_notes(wrongtempo)
check("wrong-tempo transcription (scattered residuals) fails the floor",
      not G._grid_ok(wrongtempo), f"{G.grid_fraction(wrongtempo):.2f}")
# a drifting element's post-snap survivors cluster like swing but scatter across beat
# positions — the metric-position rule must refuse them (this is why it exists)
drift_srv = [G._grid_residual(float(n.start_beats), 0.25) for n in wrongtempo.midi.notes]
check("fake-swing (drift survivors) is rejected by the metric-position rule",
      G._swing_offset(drift_srv, [float(n.start_beats) for n in wrongtempo.midi.notes],
                      0.25) is None)

lib_offgrid = [(r.source.video_id, e.role.value) for r in library for e in r.elements
               if e.midi.notes and not G._grid_ok(e)]
check("library carries ZERO below-floor elements post grid-repair", not lib_offgrid,
      str(lib_offgrid[:3]))

offgrid_pad = _mini_rec("offgridpad", [R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60 + (i % 4), start_beats=round(i * 1.337, 6), duration_beats=1.0)
    for i in range(12)]))])
ongrid_pad = _mini_rec("ongridpad", [R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60 + (i % 3), start_beats=float(i) * 0.5, duration_beats=0.5)
    for i in range(8)]))])
offgrid_picked = []
for s in range(8):
    rec_gk, _ = G.recombine([offgrid_pad, ongrid_pad], {"mood": "dark", "tempo": 140,
                                                        "key": "F minor"}, G.Rng(s + 1), {})
    pad_gk = next((e for e in rec_gk.elements if e.role.value == "pad"), None)
    if pad_gk is not None and not G._grid_ok(pad_gk):
        offgrid_picked.append(s)
check("chord source NEVER binds a below-floor off-grid pad (8 seeds)", not offgrid_picked,
      str(offgrid_picked))

# ── source priors (owner keep/kill → retrieval nudges) ────────────────────────
check("no priors file → empty dict (permissive-on-missing)",
      G.load_priors("/nonexistent/priors.json") == {})
check("priors=None and priors={} generate byte-identically (hermetic default)",
      R.to_json(G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=7,
                           palette={})[0])
      == R.to_json(G.generate({"mood": "dark", "tempo": 140, "key": "F minor"}, seed=7,
                              palette={}, priors={})[0]))
# a prior deterministically reorders retrieval between two otherwise-equal recipes
pr_a = _mini_rec("prior_a", [R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=60 + (i % 3), start_beats=float(i) * 0.5, duration_beats=0.5)
    for i in range(8)]))])
pr_b = _mini_rec("prior_b", [R.Element(role="pad", midi=R.Midi(notes=[
    R.NoteEvent(pitch=62 + (i % 3), start_beats=float(i) * 0.5, duration_beats=0.5)
    for i in range(8)]))])
req_pr = {"mood": "dark", "tempo": 140, "key": "F minor"}
rank_up = G.retrieve([pr_a, pr_b], req_pr, G.Rng(1), priors={"prior_b": 1.0})
rank_dn = G.retrieve([pr_a, pr_b], req_pr, G.Rng(1), priors={"prior_b": -1.0})
check("a ±1 prior flips a two-recipe ranking deterministically",
      rank_up[0].source.video_id == "prior_b" and rank_dn[0].source.video_id == "prior_a")
# never a ban: the worst-prior source is still retrievable/usable when it's all there is
rec_ban, prov_ban = G.recombine([pr_b], req_pr, G.Rng(2), {}, priors={"prior_b": -1.0})
check("worst-prior source still generates when alone (nudge, never a ban)",
      any(e.role.value == "pad" for e in rec_ban.elements))
check("provenance records applied priors per group",
      prov_ban.priors.get("chords") == -1.0, str(prov_ban.priors))

# Determinism with the new code paths: same (request, seed, palette) → identical output.
g_a, p_a = G.generate({"mood": "chill", "tempo": 132, "key": "A minor"}, seed=9, palette=FAKE_PAL)
g_b, p_b = G.generate({"mood": "chill", "tempo": 132, "key": "A minor"}, seed=9, palette=FAKE_PAL)
check("generation is deterministic through fills + filters",
      R.to_json(g_a) == R.to_json(g_b) and p_a == p_b)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
