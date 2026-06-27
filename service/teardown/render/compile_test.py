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

# ── graceful empty / partial ─────────────────────────────────────────────────
empty = compile_recipe(R.Recipe())
check("empty recipe → no commands, no unresolved", empty.commands == [] and empty.unresolved == [])
partial = compile_recipe(R.Recipe(elements=[R.Element(element_id="bare", role="other")]))
check("a content-less element → create_track + an unresolved", any(
    c["command"] == "create_track" for c in partial.commands) and any(
    u["element_id"] == "bare" for u in partial.unresolved))

# ── determinism ──────────────────────────────────────────────────────────────
import json  # noqa: E402
dumps = {json.dumps(compile_recipe(rec).to_dict(), sort_keys=True) for _ in range(3)}
check("compile is deterministic x3", len(dumps) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
