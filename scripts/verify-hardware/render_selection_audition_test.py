#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "service"
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

from teardown import recipe as R  # noqa: E402

MODULE = Path(__file__).with_name("render_selection_audition.py")
spec = importlib.util.spec_from_file_location("render_selection_audition", MODULE)
assert spec and spec.loader
audition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audition)

fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name} {detail}")
        fails.append(name)


def ne(pitch: int, start: float, dur: float = 1.0, velocity: int = 100) -> R.NoteEvent:
    return R.NoteEvent(pitch=pitch, start_beats=start, duration_beats=dur, velocity=velocity)


def element(role: str, notes: list[R.NoteEvent], *, sample: str = "") -> R.Element:
    match = R.SampleMatch(status="matched", matched_path=sample, distance=0.05) if sample else R.SampleMatch()
    return R.Element(
        element_id=role,
        role=role,
        label=role,
        midi=R.Midi(status="extracted", notes=notes, note_count=len(notes)),
        sample_match=match,
        motif=R.Motif(bars=4.0),
    )


source = R.Recipe(
    recipe_id="test",
    meta=R.Meta(
        tempo_bpm=R.MetaField(value=140, confidence=1.0),
        key=R.MetaField(value="F minor", confidence=1.0),
        time_signature=R.MetaField(value="4/4", confidence=1.0),
    ),
    elements=[
        element("pad", [ne(53, 0, 4), ne(56, 4, 4)]),
        element("lead", [ne(65, 0, 1), ne(68, 2, 1)]),
        element("808", [ne(29, 0, 2), ne(32, 3, 1)], sample="sample://808"),
        element("kick", [ne(36, 0, 0.25), ne(36, 2, 0.25)], sample="sample://kick"),
    ],
)

profiled = audition.apply_production_profile(source, "r7-drop")
check("profile clones recipe", profiled is not source)
check("source recipe not mutated", source.elements[0].midi.notes[0].start_beats == 0)
check("sections present", [s.name for s in profiled.arrangement.sections] == ["intro", "drop", "outro"])

notes_by_role = {el.role.value: el.midi.notes for el in profiled.elements}
check("intro has pad", any(n.start_beats < 16 for n in notes_by_role["pad"]))
check("intro omits 808", not any(n.start_beats < 16 for n in notes_by_role["808"]))
check("intro omits kick", not any(n.start_beats < 16 for n in notes_by_role["kick"]))
check("drop has 808", any(16 <= n.start_beats < 48 for n in notes_by_role["808"]))
check("drop has kick", any(16 <= n.start_beats < 48 for n in notes_by_role["kick"]))
check("outro keeps 808", any(48 <= n.start_beats < 64 for n in notes_by_role["808"]))
check("outro drops lead", not any(n.start_beats >= 48 for n in notes_by_role["lead"]))

summary = audition.compile_summary(profiled)
check("compile summary sees melodic 808", summary["has_melodic_808"], str(summary))
check("compile summary records sections", summary["section_names"] == ["intro", "drop", "outro"], str(summary))
check("arrangement expands beyond loop", summary["max_note_end_beats"] > 48, str(summary))

if fails:
    raise SystemExit(f"{len(fails)} failed: {', '.join(fails)}")
print("ALL PASS")
