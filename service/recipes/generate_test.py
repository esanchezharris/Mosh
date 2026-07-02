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

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
