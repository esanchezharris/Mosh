#!/usr/bin/env python3
"""Hermetic test for §4's pure cores — OCR text parsing + Recipe-skeleton assembly.

stdlib + pydantic only (no CV/network):  python3 service/teardown/video2recipe/video2recipe_test.py

Guards: tempo/key/plugin parsing from messy frame text, and that assemble_skeleton always
produces a schema-valid §0 Recipe (meta from signals, skeleton elements, never crashes,
nulls + unresolved on sparse input), with deterministic output.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown import recipe as R  # noqa: E402
from teardown.video2recipe import assemble_skeleton, parse_key, parse_plugins, parse_tempo  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── parsing ──────────────────────────────────────────────────────────────────
check("tempo from 'Tempo: 140 BPM'", parse_tempo("Tempo: 140 BPM") == 140)
check("tempo from lowercase '95bpm'", parse_tempo("the beat is 95bpm here") == 95)
check("tempo rejects out-of-range", parse_tempo("year 1999 bpm") is None or parse_tempo("year 1999 bpm") <= 300)
check("no tempo → None", parse_tempo("no numbers here") is None)
check("key 'F# Minor'", parse_key("Key: F# Minor") == "F# minor")
check("key 'C maj'", parse_key("in C maj") == "C major")
check("key 'Am' (bare minor)", parse_key("A m vibe") == "A minor" or parse_key("Am") == "A minor")
check("no key → None", parse_key("just text") is None)
check("plugins finds Serum + Vital", set(parse_plugins("loaded Serum then VITAL")) == {"Serum", "Vital"})
check("plugins empty when none", parse_plugins("no synths named") == [])

# ── assemble: full signal set → schema-valid Recipe ──────────────────────────
src = {"video_id": "vid9", "url": "u/vid9", "title": "Trap from scratch", "duration_s": 600, "content_hash": "abc"}
meta = {"daw": "fl_studio", "daw_conf": 0.8, "tempo": 140, "tempo_conf": 0.7,
        "tempo_evidence": ["frame@12.0s"], "key": "F# minor", "key_conf": 0.5,
        "plugins": ["Serum", "Vital"], "pianoroll": True}
sections = [{"name": "intro", "start_s": 0, "end_s": 8, "confidence": 0.2}]
rec = assemble_skeleton(source=src, meta_signals=meta, sections=sections)
check("source video_id set", rec.source.video_id == "vid9")
check("meta.daw set from signal", rec.meta.daw.value == "fl_studio")
check("meta.tempo set with evidence", rec.meta.tempo_bpm.value == 140 and rec.meta.tempo_bpm.evidence == ["frame@12.0s"])
check("meta.key set", rec.meta.key.value == "F# minor")
check("sections carried", len(rec.arrangement.sections) == 1 and rec.arrangement.sections[0].name == "intro")
check("a synth element per plugin", sum(1 for e in rec.elements if e.synth_patch.plugin.name) == 2)
check("piano-roll → a midi element + unresolved", any(e.element_id == "midi_0" for e in rec.elements)
      and any(u.element_id == "midi_0" for u in rec.unresolved))
check("reconstruction_class is partial (skeleton)", rec.reconstruction_class == R.ReconstructionClass.partial)
check("skeleton is schema-valid (round-trips)", R.from_json(R.to_json(rec)) == rec)

# ── assemble: sparse input still valid + honest ──────────────────────────────
bare = assemble_skeleton(source={"video_id": "v0"}, meta_signals={}, sections=None)
check("empty signals → valid recipe, no elements, an unresolved", bare.elements == []
      and len(bare.unresolved) == 1 and R.from_json(R.to_json(bare)) == bare)
check("empty-signals meta stays null", bare.meta.tempo_bpm.value is None and bare.meta.daw.value is None)

# ── determinism (modulo the per-instance recipe_id, which is uuid by design) ──
def _stable(r):
    r.recipe_id = "fixed"
    return R.to_json(r)
dumps = {_stable(assemble_skeleton(source=src, meta_signals=meta, sections=sections)) for _ in range(3)}
check("assemble deterministic x3 (modulo recipe_id)", len(dumps) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
