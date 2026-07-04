#!/usr/bin/env python3
"""Contract + schema-lint guard for the §0 Recipe model.

stdlib + pydantic only, no engine/audio:  python3 service/teardown/recipe_test.py
(exit 0 = all pass). Mirrors the discipline of ui's commands.contract.test.ts —
pins the data contract so downstream agents (§1–§12) can trust each field, and
fails loudly if recipe.schema.json drifts from the model.

Guards:
- partial recipes are first-class (every field defaults; empty Recipe() validates);
- the controlled vocabularies (role / statuses / reconstruction_class / license)
  actually reject garbage, and confidence/distance bounds are enforced;
- extra='forbid' catches typo'd / drifted keys;
- the 'yield' JSON key (Python-keyword field) round-trips;
- serialization is deterministic (schema + dump byte-stable x3);
- the committed recipe.schema.json equals the model's current schema.
"""
import sys
from pathlib import Path

from pydantic import ValidationError

import recipe as R  # service/teardown is sys.path[0] when run as a script

fails: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def raises(fn) -> bool:
    try:
        fn()
        return False
    except ValidationError:
        return True


# ── 1. partial-first-class: empty + skeleton recipes validate ────────────────
empty = R.Recipe()
check("empty Recipe() validates (partial is first-class)", isinstance(empty, R.Recipe))
check("default reconstruction_class is 'partial'", empty.reconstruction_class is R.ReconstructionClass.partial)
check("default schema_version is 2.0", empty.schema_version == "2.0")
check("auto recipe_id is a non-empty uuid str", isinstance(empty.recipe_id, str) and len(empty.recipe_id) >= 32)

skel = R.new_skeleton("dQw4w9WgXcQ", title="x")
check("new_skeleton sets source.video_id", skel.source.video_id == "dQw4w9WgXcQ")
check("new_skeleton defaults license unknown", skel.source.license is R.License.unknown)

# minimal external JSON (just a video id) validates — missing fields → defaults
minimal = R.from_json('{"source": {"video_id": "abc"}}')
check("minimal {'source':{'video_id'}} JSON validates", minimal.source.video_id == "abc")
check("minimal recipe got a generated recipe_id", len(minimal.recipe_id) >= 32)

# ── 2. controlled vocabularies reject garbage ────────────────────────────────
check("invalid role rejected", raises(lambda: R.Element(role="frobnicate")))
check("invalid midi status rejected", raises(lambda: R.Midi(status="halfway")))
check("invalid synth status rejected", raises(lambda: R.SynthPatch(status="visible-ish")))
check("invalid reconstruction_class rejected", raises(lambda: R.Recipe(reconstruction_class="goldish")))
check("invalid license rejected", raises(lambda: R.Source(license="public-domain")))
check("valid '808' role accepted", R.Element(role="808").role is R.Role.r808)
check("valid params_visible status accepted", R.SynthPatch(status="params_visible").status is R.SynthStatus.params_visible)

# ── 3. numeric bounds enforced ───────────────────────────────────────────────
check("confidence > 1 rejected", raises(lambda: R.MetaField(confidence=1.5)))
check("confidence < 0 rejected", raises(lambda: R.Element(confidence=-0.1)))
check("negative distance rejected", raises(lambda: R.SampleMatch(distance=-1.0)))
check("negative note_count rejected", raises(lambda: R.Midi(note_count=-1)))
check("yield score > 1 rejected", raises(lambda: R.YieldScores(overall=2.0)))
check("wrong schema_version rejected", raises(lambda: R.Recipe(schema_version="1.0")))

# ── 4. extra='forbid' catches drift ──────────────────────────────────────────
check("unknown top-level key rejected", raises(lambda: R.from_json('{"souce": {}}')))
check("unknown nested key rejected", raises(lambda: R.Source(vidd_id="x")))

# ── 5. a richly-populated recipe round-trips exactly ─────────────────────────
full = R.Recipe(
    recipe_id="fixed-id-0001",
    source=R.Source(video_id="vid42", url="https://x", title="Trap from scratch",
                    channel="beatlab", duration_s=612.0, license="creativeCommon",
                    content_hash="deadbeef"),
    meta=R.Meta(
        daw=R.MetaField(value="fl_studio", confidence=0.9),
        tempo_bpm=R.MetaField(value=140, confidence=0.95, evidence=["shot_07@73.4"]),
        key=R.MetaField(value="F# minor", confidence=0.6),
        time_signature=R.MetaField(value="4/4", confidence=0.99),
    ),
    arrangement=R.Arrangement(sections=[R.Section(name="intro", start_s=0, end_s=8, confidence=0.8)]),
    elements=[
        R.Element(
            element_id="el1", role="808", label="sub 808", audio_ref="assets/stems/el1.wav",
            midi=R.Midi(status="extracted", midi_ref="assets/midi/el1.mid", note_count=16, confidence=0.9),
            sample_match=R.SampleMatch(status="matched", matched_path="lib/808/x.wav", distance=0.12,
                                       alternates=[R.Alternate(path="lib/808/y.wav", distance=0.2)]),
            synth_patch=R.SynthPatch(
                status="params_visible",
                plugin=R.Plugin(name="Serum", available_locally=True),
                params={"osc_a_level": 0.8, "cutoff": 0.42, "unison": 7},
                match=R.SynthMatch(target_audio_ref="assets/stems/el1.wav", confidence=0.55),
            ),
            evidence=[R.Evidence(type="screenshot", ref="assets/shots/el1.png", t_s=73.4, ocr_text="140 BPM")],
            confidence=0.85,
        )
    ],
    unresolved=[R.Unresolved(issue="velocity lane occluded", element_id="el1", suggested_action="re-OCR @74s")],
    reconstruction_class="deterministic",
    **{"yield": R.YieldBlock(predicted=R.YieldScores(overall=0.7), actual=R.YieldScores(overall=0.65))},
)
s = R.to_json(full)
back = R.from_json(s)
check("rich recipe round-trips to an equal model", back == full)
check("'yield' is the JSON key (alias), not 'yield_'", '"yield"' in s and '"yield_"' not in s)
check("free-form synth params survive round-trip", back.elements[0].synth_patch.params == full.elements[0].synth_patch.params)
check("nested evidence objects survive round-trip", back.elements[0].evidence[0].ocr_text == "140 BPM")
check("enum field serializes to its string value", '"role": "808"' in s)

# ── 5b. §0.1 musical body: inline notes + motif + bass round-trip & bounds ───
body = R.Recipe(
    recipe_id="fixed-id-0002",
    meta=R.Meta(tempo_bpm=R.MetaField(value=140), key=R.MetaField(value="F minor")),
    elements=[
        R.Element(
            element_id="b1", role="808", label="808 bass",
            midi=R.Midi(status="extracted", note_count=3, notes=[
                R.NoteEvent(pitch=29, start_beats=0.0, duration_beats=1.5, velocity=110),
                R.NoteEvent(pitch=29, start_beats=2.0, duration_beats=1.0, velocity=96),
                R.NoteEvent(pitch=36, start_beats=3.0, duration_beats=0.5, velocity=100),
            ]),
            motif=R.Motif(bars=1.0, onset_grid="8th", density=3.0, syncopation=0.33,
                          contour=[0, 1], register_band="sub", harmonic_function="root-following"),
            bass=R.Bass(sustain_ratio=0.75, glides=[0], kick_alignment=0.66, root_follows=True,
                        root_element_id="chords1"),
        ),
    ],
)
bs = R.to_json(body)
bback = R.from_json(bs)
check("inline NoteEvents round-trip", bback == body)
check("NoteEvent carries beat-relative timing + duration",
      bback.elements[0].midi.notes[0].duration_beats == 1.5 and bback.elements[0].midi.notes[0].pitch == 29)
check("Motif + Bass sub-models survive round-trip",
      bback.elements[0].bass.root_follows is True and bback.elements[0].motif.harmonic_function == "root-following")
check("a bass note can sustain >1 beat (not a hi-hat stab)", bback.elements[0].midi.notes[0].duration_beats > 1.0)
check("NoteEvent pitch > 127 rejected", raises(lambda: R.NoteEvent(pitch=200)))
check("NoteEvent zero duration rejected", raises(lambda: R.NoteEvent(duration_beats=0.0)))
check("NoteEvent velocity 0 rejected", raises(lambda: R.NoteEvent(velocity=0)))
check("Bass sustain_ratio > 1 rejected", raises(lambda: R.Bass(sustain_ratio=1.5)))
check("element with no notes is still first-class (partial)", R.Element(role="lead").midi.notes == [])

# ── 6. determinism (the repo's x3-stable bar) ────────────────────────────────
schemas = {R.emit_schema_json() for _ in range(3)}
check("emit_schema_json() is byte-stable x3", len(schemas) == 1)
dumps = {R.to_json(full) for _ in range(3)}
check("to_json(fixed recipe) is byte-stable x3", len(dumps) == 1)

# ── 7. committed schema artifact matches the model (drift guard) ─────────────
committed = (Path(__file__).resolve().parent / "recipe.schema.json").read_text()
check("recipe.schema.json matches the model",
      committed == R.emit_schema_json(),
      "regenerate: python3 service/teardown/recipe.py --emit-schema > service/teardown/recipe.schema.json")

# ── 8. asset-layout helper is pure + well-shaped ─────────────────────────────
paths = R.recipe_paths("/tmp/anchors", "el-recipe")
check("recipe_paths returns the documented layout",
      paths["recipe_json"].name == "recipe.json" and paths["stems"].name == "stems"
      and paths["transcript"].name == "transcript.json")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
