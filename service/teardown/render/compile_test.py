#!/usr/bin/env python3
"""Golden + contract test for the §9 Recipe→MoshOps compiler.

stdlib + pydantic only, no engine:  python3 service/teardown/render/compile_test.py
(exit 0 = all pass). Asserts the exact emitted command list for a representative
Recipe (the golden), the engine-deferred `unresolved` entries, key/sig parsing, the
drum-vs-audio track-type rule, graceful empty/partial handling, and determinism x3.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown import recipe as R  # noqa: E402
from teardown.render.compile import compile_recipe  # noqa: E402

fails: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── a representative recipe (sample placement + synth + MIDI) ────────────────
rec = R.Recipe(
    meta=R.Meta(
        tempo_bpm=R.MetaField(value=140, confidence=0.9),
        key=R.MetaField(value="F# minor", confidence=0.7),
        time_signature=R.MetaField(value="4/4", confidence=0.9),
    ),
    elements=[
        R.Element(element_id="kick1", role="kick", label="Kick",
                  sample_match=R.SampleMatch(status="matched", matched_path="lib/kicks/k.wav", distance=0.1)),
        R.Element(element_id="lead1", role="lead", label="Lead",
                  synth_patch=R.SynthPatch(status="params_visible",
                                           plugin=R.Plugin(name="Serum", available_locally=True),
                                           params={"cutoff": 0.4})),
        R.Element(element_id="b808", role="808", label="808",
                  midi=R.Midi(status="extracted", midi_ref="assets/midi/e2.mid", note_count=8)),
    ],
)
res = compile_recipe(rec)

expected_commands = [
    {"command": "set_tempo", "args": {"bpm": 140}},
    {"command": "set_key", "args": {"tonic": "F#", "mode": "minor"}},
    {"command": "set_time_signature", "args": {"numerator": 4, "denominator": 4}},
    {"command": "create_track", "args": {"name": "Kick", "type": "audio"}, "capture": {"T0": "trackId"}},
    {"command": "import_clip", "args": {"file": "lib/kicks/k.wav", "trackId": "${T0}", "startSeconds": 0}},
    {"command": "create_track", "args": {"name": "Lead", "type": "audio"}, "capture": {"T1": "trackId"}},
    {"command": "create_track", "args": {"name": "808", "type": "drum"}, "capture": {"T2": "trackId"}},
    {"command": "add_midi_clip", "args": {"trackId": "${T2}", "start": 0, "length": 8.0}, "capture": {"C2": "clipId"}},
]
check("golden command list matches exactly", res.commands == expected_commands,
      f"got {len(res.commands)} cmds")
check("808 (drum role + midi) → drum track", any(
    c["command"] == "create_track" and c["args"]["type"] == "drum" for c in res.commands))
check("matched sample → import_clip with captured trackId ref",
      {"command": "import_clip", "args": {"file": "lib/kicks/k.wav", "trackId": "${T0}", "startSeconds": 0}} in res.commands)

# engine-deferred work is honestly recorded, not silently dropped
issues = " | ".join(u["issue"] for u in res.unresolved)
check("synth load+params deferred to execute", "load synth 'Serum'" in issues)
check("MIDI notes deferred to execute", "MIDI notes in assets/midi/e2.mid" in issues)
check("unresolved carries the element id", any(u["element_id"] == "lead1" for u in res.unresolved))

# ── key / time-signature parsing ─────────────────────────────────────────────
ckey = compile_recipe(R.Recipe(meta=R.Meta(key=R.MetaField(value="C"))))
check("bare tonic defaults to major", {"command": "set_key", "args": {"tonic": "C", "mode": "major"}} in ckey.commands)
bad = compile_recipe(R.Recipe(meta=R.Meta(key=R.MetaField(value="???"), time_signature=R.MetaField(value="weird"))))
check("unparseable key → unresolved, no command",
      not any(c["command"] == "set_key" for c in bad.commands) and any("key" in u["issue"] for u in bad.unresolved))
check("unparseable time sig → unresolved, no command",
      not any(c["command"] == "set_time_signature" for c in bad.commands) and any("time signature" in u["issue"] for u in bad.unresolved))

# ── §9 timeline placement: onsets → one clip per fire time on ONE track ──────
tl = compile_recipe(R.Recipe(elements=[
    R.Element(element_id="hat", role="hat", label="Hat",
              sample_match=R.SampleMatch(status="matched", matched_path="lib/h.wav", distance=0.1),
              onsets=[0.0, 0.5, 1.0, 1.5])]))
hat_tracks = [c for c in tl.commands if c["command"] == "create_track"]
hat_clips = [c for c in tl.commands if c["command"] == "import_clip"]
check("onsets → exactly ONE track", len(hat_tracks) == 1, str(len(hat_tracks)))
check("onsets → one import_clip per fire time", len(hat_clips) == 4, str(len(hat_clips)))
check("onsets placed at the right start times",
      [c["args"]["startSeconds"] for c in hat_clips] == [0.0, 0.5, 1.0, 1.5],
      str([c["args"]["startSeconds"] for c in hat_clips]))
check("onset clips all reference the SAME captured track",
      len({c["args"]["trackId"] for c in hat_clips}) == 1)
# back-compat: no onsets → a single placement at 0
nob = compile_recipe(R.Recipe(elements=[R.Element(element_id="k", role="kick",
        sample_match=R.SampleMatch(status="matched", matched_path="lib/k.wav", distance=0.1))]))
check("no onsets → single clip at 0 (back-compat)",
      len([c for c in nob.commands if c["command"] == "import_clip"]) == 1)

# ── graceful empty / partial ─────────────────────────────────────────────────
empty = compile_recipe(R.Recipe())
check("empty recipe → no commands, no unresolved", empty.commands == [] and empty.unresolved == [])
partial = compile_recipe(R.Recipe(elements=[R.Element(element_id="bare", role="other")]))
check("a content-less element → create_track + an unresolved", any(
    c["command"] == "create_track" for c in partial.commands) and any(
    u["element_id"] == "bare" for u in partial.unresolved))
check("content-less element gets EXACTLY ONE unresolved (no double-defer)",
      len([u for u in partial.unresolved if u["element_id"] == "bare"]) == 1,
      str([u["issue"] for u in partial.unresolved if u["element_id"] == "bare"]))
unavail = compile_recipe(R.Recipe(elements=[R.Element(element_id="u1", role="lead",
                                                      synth_patch=R.SynthPatch(status="unavailable"))]))
check("unavailable element gets EXACTLY ONE unresolved",
      len([u for u in unavail.unresolved if u["element_id"] == "u1"]) == 1,
      str([u["issue"] for u in unavail.unresolved if u["element_id"] == "u1"]))

# ── determinism ──────────────────────────────────────────────────────────────
import json  # noqa: E402
dumps = {json.dumps(compile_recipe(rec).to_dict(), sort_keys=True) for _ in range(3)}
check("compile is deterministic x3", len(dumps) == 1)

# ── §9 execute pure helpers (engine-free): MIDI round-trip + inline + yield ──────────
import tempfile  # noqa: E402
from teardown.render.execute import inline_midi, reconstruction_class_for, yield_actual  # noqa: E402
from teardown.render.midi_read import read_midi  # noqa: E402
from teardown.midi_from_screen.export import write_midi  # noqa: E402

with tempfile.TemporaryDirectory() as td:
    mid = os.path.join(td, "e.mid")
    src_notes = [{"pitch": 60, "start": 0.0, "end": 1.0, "velocity": 100},
                 {"pitch": 64, "start": 1.0, "end": 1.5, "velocity": 90},
                 {"pitch": 67, "start": 2.0, "end": 4.0, "velocity": 110}]
    write_midi(src_notes, mid, bpm=140)
    rn = read_midi(mid)
    check("midi_read recovers note count", len(rn) == 3, f"got {len(rn)}")
    check("midi_read recovers pitches + order", [n["pitch"] for n in rn] == [60, 64, 67])
    check("midi_read recovers start/length (beats)",
          abs(rn[0]["start"]) < 1e-6 and abs(rn[2]["length"] - 2.0) < 1e-3,
          str(rn[2]))

    rec_midi = R.Recipe(elements=[
        R.Element(element_id="lead", role="lead", label="Lead",
                  midi=R.Midi(status="extracted", midi_ref=mid, note_count=3)),
        R.Element(element_id="kick", role="kick", label="Kick",
                  sample_match=R.SampleMatch(status="matched", matched_path="/x/k.wav", distance=0.1)),
    ])
    cmds = compile_recipe(rec_midi).commands
    inlined, nres = inline_midi(cmds, rec_midi, asset_root=None)
    check("inline_midi resolved one clip", nres == 1, f"resolved {nres}")
    mc = next(c for c in inlined if c["command"] == "add_midi_clip")
    check("inline_midi attached notes to the right clip", len(mc["args"].get("notes", [])) == 3)
    check("inline_midi leaves non-midi commands untouched",
          any(c["command"] == "import_clip" for c in inlined))

# ── §7→§9 bridge: recipe_from_extraction groups slices by role into timeline elements ──
from teardown.render.from_extraction import recipe_from_extraction  # noqa: E402

ex_matches = [
    {"t_s": 0.0, "role": "kick", "match": "lib/k1.wav", "distance": 0.1},
    {"t_s": 1.0, "role": "kick", "match": "lib/k2.wav", "distance": 0.2},   # same role, farther
    {"t_s": 0.5, "role": "snare", "match": "lib/s1.wav", "distance": 0.15},
    {"t_s": 1.5, "role": "snare", "match": "lib/s1.wav", "distance": 0.15},
    {"t_s": 0.25, "role": "hat", "match": None, "distance": None},          # unmatched → dropped
    {"t_s": 0.75, "role": "perc", "match": "lib/p.wav", "distance": 0.9},   # over threshold → dropped
]
exrec = recipe_from_extraction(ex_matches, meta_signals={"tempo": 140})
roles = sorted(e.role.value for e in exrec.elements)
check("extraction → one element per matched role", roles == ["kick", "snare"], str(roles))
kick_el = next(e for e in exrec.elements if e.role.value == "kick")
check("kick element collects both onsets", kick_el.onsets == [0.0, 1.0], str(kick_el.onsets))
check("kick rep sample is the CLOSEST match", kick_el.sample_match.matched_path == "lib/k1.wav",
      kick_el.sample_match.matched_path)
check("unmatched + over-threshold slices dropped", all(e.role.value != "hat" and e.role.value != "perc"
                                                       for e in exrec.elements))
check("extraction recipe carries tempo signal", exrec.meta.tempo_bpm.value == 140)
check("extraction recipe is class=inferred", exrec.reconstruction_class == R.ReconstructionClass.inferred)
check("extraction recipe round-trips", R.from_json(R.to_json(exrec)) == exrec)
# the bridged recipe compiles to a real timeline (clips per onset)
exc = compile_recipe(exrec)
check("extraction recipe compiles to per-onset clips",
      len([c for c in exc.commands if c["command"] == "import_clip"]) == 4,
      str(len([c for c in exc.commands if c["command"] == "import_clip"])))

# yield_actual is honest: silent render → 0 regardless of clean command application
ok_results = [{"ok": True, "command": "create_track"}, {"ok": True, "command": "create_track"},
              {"ok": True, "command": "import_clip"}, {"ok": True, "command": "add_midi_clip"}]
ya_silent = yield_actual(rec_midi, ok_results, notes_resolved=1, nonsilent=False)
ya_sound = yield_actual(rec_midi, ok_results, notes_resolved=1, nonsilent=True)
check("yield_actual is zero on a silent render", ya_silent["overall"] == 0.0, str(ya_silent))
check("yield_actual rewards a non-silent landed render", ya_sound["overall"] > 0.5, str(ya_sound))
check("yield_actual midi tracks resolved notes", ya_sound["midi"] == 1.0, str(ya_sound))
check("reconstruction_class downgrades with unresolved present",
      reconstruction_class_for(rec_midi, ya_sound, [{"issue": "x"}]) in ("inferred", "partial"))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
