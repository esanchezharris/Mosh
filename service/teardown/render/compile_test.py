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
    # mix stage: static per-track headroom trim (2026-07 clipping audit)
    {"command": "set_track_volume", "args": {"trackId": "${T0}", "db": -4.5}},
    {"command": "set_track_volume", "args": {"trackId": "${T1}", "db": -4.5}},
    {"command": "set_track_volume", "args": {"trackId": "${T2}", "db": -4.5}},
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

# ── §0.1 inline notes + real sound binding (the restart's compile path) ──────
ne = R.NoteEvent
body = R.Recipe(
    meta=R.Meta(tempo_bpm=R.MetaField(value=120)),  # 120bpm → 1 beat = 0.5s
    elements=[
        # a drum kick: inline rhythm + a matched real sample → drum track, assign_sample(drum)
        R.Element(element_id="kick", role="kick", label="Kick",
                  sample_match=R.SampleMatch(status="matched", matched_path="lib/k.wav", distance=0.1),
                  midi=R.Midi(status="extracted", notes=[
                      ne(pitch=36, start_beats=0.0, duration_beats=0.25, velocity=110),
                      ne(pitch=36, start_beats=2.0, duration_beats=0.25, velocity=100)])),
        # an 808: a sustained, syncopated phrase + a matched 808 → AUDIO track, assign_sample(melodic)
        R.Element(element_id="b808", role="808", label="808",
                  sample_match=R.SampleMatch(status="matched", matched_path="lib/808.wav", distance=0.1),
                  midi=R.Midi(status="extracted", notes=[
                      ne(pitch=29, start_beats=0.0, duration_beats=1.5, velocity=110),
                      ne(pitch=36, start_beats=2.0, duration_beats=2.0, velocity=100)]),
                  bass=R.Bass(sustain_ratio=0.8, root_follows=True)),
    ],
)
bc = compile_recipe(body).commands


def _idx(pred):
    return next((i for i, c in enumerate(bc) if pred(c)), -1)


kick_tt = next(c for c in bc if c["command"] == "create_track" and c["args"]["name"] == "Kick")
b808_tt = next(c for c in bc if c["command"] == "create_track" and c["args"]["name"] == "808")
check("drum element with inline notes → DRUM track", kick_tt["args"]["type"] == "drum")
check("melodic 808 with inline notes → AUDIO track (not drum)", b808_tt["args"]["type"] == "audio")

kick_as = _idx(lambda c: c["command"] == "assign_sample" and c["args"].get("mode") == "drum")
kick_clip = _idx(lambda c: c["command"] == "add_midi_clip" and c["args"].get("name") == "Kick")
check("drum: assign_sample(mode=drum) emitted", kick_as >= 0)
check("drum: assign_sample precedes add_midi_clip (no default-kit double)", 0 <= kick_as < kick_clip)
check("drum: pad note = the pitch the hits trigger (36)",
      bc[kick_as]["args"]["note"] == 36 if kick_as >= 0 else False)

b808_as = _idx(lambda c: c["command"] == "assign_sample" and c["args"].get("mode") == "melodic")
b808_clip = _idx(lambda c: c["command"] == "add_midi_clip" and c["args"].get("name") == "808")
check("808: assign_sample(mode=melodic) emitted", b808_as >= 0)
check("808: melodic root = lowest pitch in the phrase (29)",
      bc[b808_as]["args"]["note"] == 29 if b808_as >= 0 else False)
check("808: assign_sample precedes add_midi_clip (the doubling gotcha)", 0 <= b808_as < b808_clip)
clip808 = bc[b808_clip]
check("808: notes inline on the clip (no external midi_ref round-trip)",
      len(clip808["args"].get("notes", [])) == 2)
check("808: a bass note SUSTAINS (length 1.5 beats, not a hi-hat stab)",
      any(n["length"] >= 1.5 for n in clip808["args"]["notes"]))
check("808: clip length sized to the phrase in seconds (≈ 4 beats @120 = 2.0s)",
      abs(clip808["args"]["length"] - 2.0) < 1e-6, str(clip808["args"]["length"]))
check("real-sound MIDI elements emit NO import_clip (they're triggered, not placed)",
      not any(c["command"] == "import_clip" for c in bc))
check("melodic 808 with a matched sample does NOT defer to 4OSC",
      not any("4OSC" in u.get("issue", "") for u in compile_recipe(body).unresolved))

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
    inlined, mids = inline_midi(cmds, rec_midi, asset_root=None)
    check("inline_midi resolved one clip", len(mids) == 1 and mids == ["lead"], f"resolved {mids}")
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

# ── §9 execute: _describe_params binds each plugin's param map by ID, not order ──
# describe_plugin doesn't echo back the pluginId/trackId, so association is fragile. The
# binary now echoes engine ids — load_plugin → data.{trackId,pluginId}, describe_plugin →
# data.trackId — and _describe_params chains pid→trackId→params (order-free, immune to a
# reordered/dropped describe line). When the binary echoes no ids (an OLDER /Applications
# build) it falls back to POSITIONAL association, which must still be failure-safe: a probed
# plugin whose load fails (cracked/missing VST3) still emits an ok:false describe line, so
# keeping EVERY describe (not just ok ones) preserves the 1:1 order with the sorted ids —
# filtering to ok-only would shift every later map onto the WRONG pluginId.
import teardown.render.execute as _ex  # noqa: E402
from teardown.render.execute import _describe_params  # noqa: E402

_GOOD_PARAMS = {
    "id-good": [{"name": "Cutoff", "index": 7}, {"name": "Reso", "index": 9}],
    "id-good2": [{"name": "Drive", "index": 3}],
}


def _fake_run_capture(fail_ids: set, *, echo_ids: bool = True, reorder: bool = False,
                      drop_describe: int = 0):
    """Mirror `Mosh --run-script`: one result line per command, IN ORDER, every command
    (incl. failures) carrying its own `command` name. `echo_ids=True` models the binary that
    echoes engine ids (load_plugin → data.{trackId,pluginId}, describe_plugin → data.trackId)
    enabling id-based association; `echo_ids=False` models an OLD build (no ids → positional
    fallback). `reorder` reverses the describe results among their slots (engine returned them
    out of probe order); `drop_describe` omits trailing describe lines (a truncated run). A
    load on a `fail_ids` plugin is ok:false and its describe is ok:false (cracked/missing)."""
    def fake(binp, cmds, session_dir, timeout_s):
        results, describe_slots = [], []
        cur_tid = cur_pid = None
        probe_n = described = 0
        n_describe = sum(1 for c in cmds if c.get("command") == "describe_plugin")
        for c in cmds:
            name = c.get("command")
            if name == "create_track":
                cur_tid = f"track-{probe_n}"; probe_n += 1
                results.append({"command": "create_track", "ok": True, "data": {"trackId": cur_tid}})
            elif name == "load_plugin":
                cur_pid = (c.get("args") or {}).get("pluginId")
                ok = cur_pid not in fail_ids
                r = {"command": "load_plugin", "ok": ok}
                if ok and echo_ids:
                    r["data"] = {"trackId": cur_tid, "pluginId": cur_pid}
                results.append(r)
            elif name == "describe_plugin":
                described += 1
                if drop_describe and described > n_describe - drop_describe:
                    continue  # truncated run — this describe line is never written
                if cur_pid in fail_ids:
                    r = {"command": "describe_plugin", "ok": False}
                else:
                    data = {"params": _GOOD_PARAMS[cur_pid]}
                    if echo_ids:
                        data["trackId"] = cur_tid
                    r = {"command": "describe_plugin", "ok": True, "data": data}
                describe_slots.append(len(results))
                results.append(r)
            else:
                results.append({"command": name, "ok": True})
        if reorder:  # engine returned the describes out of probe order — id-based must still bind
            vals = [results[i] for i in describe_slots][::-1]
            for i, v in zip(describe_slots, vals):
                results[i] = v
        return results
    return fake


_orig_run_capture = _ex._run_capture
try:
    # (1) the headline case: the FIRST of two probed plugins fails load+describe. The
    #     surviving plugin's map must stay keyed to ITS OWN pluginId; the failed one carries
    #     no params. (Under the old dropped-ok-filter bug the survivor's map shifted off-by-one.)
    _ex._run_capture = _fake_run_capture({"id-fail"})
    m = _describe_params("bin", {"id-fail", "id-good"}, None, 1)  # sorted → ['id-fail','id-good']
    check("partial-fail: surviving plugin's map is keyed to ITS pluginId",
          m.get("id-good") == {"cutoff": 7, "reso": 9}, str(m))
    check("partial-fail: failed plugin carries no params (not the survivor's map)",
          m.get("id-fail", {}) == {}, str(m))

    # (2) BELT-AND-SUSPENDERS: the engine returns the describe results OUT OF probe order.
    #     id-based matching (pid→trackId→params) must still bind each map to the right plugin;
    #     a pure positional zip would transpose the two maps.
    _ex._run_capture = _fake_run_capture(set(), reorder=True)
    mr = _describe_params("bin", {"id-good", "id-good2"}, None, 1)
    check("reordered describes: id-matching keeps each map on its own plugin",
          mr.get("id-good") == {"cutoff": 7, "reso": 9} and mr.get("id-good2") == {"drive": 3},
          str(mr))

    # (3) both succeed, in order → each pluginId gets its OWN distinct map.
    _ex._run_capture = _fake_run_capture(set())
    m2 = _describe_params("bin", {"id-good", "id-good2"}, None, 1)
    check("both-ok: each pluginId gets its own param map",
          m2.get("id-good") == {"cutoff": 7, "reso": 9} and m2.get("id-good2") == {"drive": 3},
          str(m2))

    # (4) BACK-COMPAT: an OLD binary echoing no ids → positional fallback, still failure-safe
    #     (first-of-two fails → survivor keyed correctly via the 1:1 order with sorted ids).
    _ex._run_capture = _fake_run_capture({"id-fail"}, echo_ids=False)
    mo = _describe_params("bin", {"id-fail", "id-good"}, None, 1)
    check("old-binary fallback: positional binding still keys the survivor correctly",
          mo.get("id-good") == {"cutoff": 7, "reso": 9} and mo.get("id-fail", {}) == {}, str(mo))

    # (5) OLD binary + truncated run (describe lines ≠ ids) → degrade to empty maps for every id.
    _ex._run_capture = _fake_run_capture(set(), echo_ids=False, drop_describe=1)
    m3 = _describe_params("bin", {"id-good", "id-good2"}, None, 1)
    check("old-binary count-mismatch: degrades to empty maps for every id (no misalignment)",
          m3 == {"id-good": {}, "id-good2": {}}, str(m3))
finally:
    _ex._run_capture = _orig_run_capture

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
