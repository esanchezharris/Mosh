#!/usr/bin/env python3
"""§0 Recipe contract — the spine of the teardown pipeline.

Every agent (§1–§12) reads/writes a subset of this model; it is shaped to *compile
to MoshOps* (each element → create_track + content + plugin commands), so field
names stay role-oriented, never DAW-specific.

pydantic v2 model. Regenerate the committed contract artifact with:

    python3 service/teardown/recipe.py --emit-schema > service/teardown/recipe.schema.json

The round-trip + schema-lint guard is service/teardown/recipe_test.py (run it after
any change — it fails if recipe.schema.json drifts from the model).

Invariants baked in (spec §Invariants):
- A missing field is null/unknown, never a failure: every field has a safe default,
  so a partial recipe is first-class and degrades gracefully.
- Confidence + evidence travel with every inferred value.
- extra='forbid' on every model catches schema drift / typo'd keys the way
  commands.contract.test.ts pins the command catalog.

`reconstruction_class` (the one schema change vs the draft) gates §11's anchor
corpus: `deterministic` = screen-read MIDI (§5) + screen-read params (§5b) at high
confidence (gold anchor); `inferred` = leaned on §7 extraction or §8
refinement/substitution; `partial` = holes. The flywheel trusts only `deterministic`.
"""
from __future__ import annotations

import json
from enum import Enum
from pathlib import Path
from typing import Any, Literal, Optional, Union
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "2.0"

#: Asset folder layout per recipe: <recipe_id>/recipe.json + assets/{stems,midi,shots}/
#: plus assets/transcript.json. Pure convention here; §4/§9 create the dirs.
ASSET_SUBDIRS = ("stems", "midi", "shots")


# ── controlled vocabularies (the contract's teeth) ───────────────────────────
class License(str, Enum):
    youtube = "youtube"
    creative_common = "creativeCommon"
    owner = "owner"  # the producer's own works — rights-clean by definition (2026-07 r8 lane)
    licensed_pack = "licensedPack"  # purchased/royalty-free packs, owner-confirmed 2026-07-02
    unknown = "unknown"


class Role(str, Enum):
    kick = "kick"
    snare = "snare"
    hat = "hat"
    clap = "clap"
    perc = "perc"
    r808 = "808"
    bass = "bass"
    lead = "lead"
    pad = "pad"
    pluck = "pluck"
    fx = "fx"
    vocal = "vocal"
    other = "other"


class MidiStatus(str, Enum):
    extracted = "extracted"
    partial = "partial"
    absent = "absent"
    unknown = "unknown"


class SampleStatus(str, Enum):
    matched = "matched"
    candidate = "candidate"
    none = "none"


class SynthStatus(str, Enum):
    params_visible = "params_visible"  # §5b read the GUI
    matched = "matched"                # §8 closed the loop
    substituted = "substituted"        # §8 substitute path
    unavailable = "unavailable"
    unknown = "unknown"


class ReconstructionClass(str, Enum):
    deterministic = "deterministic"
    inferred = "inferred"
    partial = "partial"


# ── base: forbid unknown keys, accept field-name or alias ────────────────────
class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# ── building blocks ──────────────────────────────────────────────────────────
class MetaField(_Base):
    """An inferred scalar that carries its own confidence + evidence (shot@t)."""

    value: Optional[Union[str, int]] = None
    confidence: float = Field(0.0, ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)


class Source(_Base):
    platform: str = "youtube"
    video_id: str = ""
    url: str = ""
    title: str = ""
    channel: str = ""
    duration_s: float = Field(0.0, ge=0.0)
    license: License = License.unknown
    retrieved_at: Optional[str] = None  # iso8601, set by §3/§4
    content_hash: Optional[str] = None  # sha256, provenance + dedup


class Meta(_Base):
    daw: MetaField = Field(default_factory=MetaField)
    tempo_bpm: MetaField = Field(default_factory=MetaField)
    key: MetaField = Field(default_factory=MetaField)
    time_signature: MetaField = Field(default_factory=MetaField)


class Section(_Base):
    name: str = ""
    start_s: float = Field(0.0, ge=0.0)
    end_s: float = Field(0.0, ge=0.0)
    confidence: float = Field(0.0, ge=0.0, le=1.0)


class Arrangement(_Base):
    sections: list[Section] = Field(default_factory=list)


class NoteEvent(_Base):
    """One inline MIDI note — the musical *body* of an element (§0.1).

    Absolute pitch + beat-relative timing so §9 emits `add_note` directly (no external
    .mid round-trip) and the generator can transpose by an interval without re-parsing.
    `midi_ref` stays on `Midi` as optional provenance; `notes` is the load-bearing data."""

    pitch: int = Field(60, ge=0, le=127)
    start_beats: float = Field(0.0, ge=0.0)
    duration_beats: float = Field(0.25, gt=0.0)
    velocity: int = Field(100, ge=1, le=127)


class Midi(_Base):
    status: MidiStatus = MidiStatus.unknown
    midi_ref: Optional[str] = None  # optional provenance pointer to an external .mid
    notes: list[NoteEvent] = Field(default_factory=list)  # §0.1 inline note events (the body)
    note_count: int = Field(0, ge=0)
    confidence: float = Field(0.0, ge=0.0, le=1.0)


class Alternate(_Base):
    path: str = ""
    distance: float = Field(0.0, ge=0.0)


class SampleMatch(_Base):
    status: SampleStatus = SampleStatus.none
    matched_path: Optional[str] = None
    distance: float = Field(0.0, ge=0.0)
    alternates: list[Alternate] = Field(default_factory=list)
    #: The matched one-shot's TRUE pitch (MIDI). The melodic sampler's `note` must be
    #: this — not a phrase-derived guess — or every rendered note is off by the
    #: sample-vs-root delta (the 2026-07 out-of-key audit finding: −5..+5 st per element).
    root_note: Optional[int] = Field(None, ge=0, le=127)


class Plugin(_Base):
    name: Optional[str] = None
    available_locally: bool = False


class SynthMatch(_Base):
    target_audio_ref: Optional[str] = None
    method: str = "sound_match"
    confidence: float = Field(0.0, ge=0.0, le=1.0)


class Substitute(_Base):
    plugin: Optional[str] = None
    preset_ref: Optional[str] = None
    note: str = "approximation"


class SynthPatch(_Base):
    status: SynthStatus = SynthStatus.unknown
    plugin: Plugin = Field(default_factory=Plugin)
    params: dict[str, Any] = Field(default_factory=dict)  # when readable/recovered (§5b/§8)
    match: Optional[SynthMatch] = None
    substitute: Optional[Substitute] = None


class Evidence(_Base):
    type: str = "screenshot"
    ref: str = ""
    t_s: float = Field(0.0, ge=0.0)
    ocr_text: Optional[str] = None


class Motif(_Base):
    """Derived per-element musical features (§0.1) — the retrieval/recombination handle.

    Descriptive + transposable: §9 compiles the literal `Midi.notes`, while the generator
    matches on these (so it picks a 'syncopated trap hat' vs a 'four-on-the-floor kick'
    rather than an undifferentiated note stream). All optional; absent → not yet analyzed."""

    bars: float = Field(0.0, ge=0.0)
    onset_grid: str = ""  # dominant subdivision: "4th" / "8th" / "16th" / "triplet"
    density: float = Field(0.0, ge=0.0)  # notes per bar
    syncopation: float = Field(0.0, ge=0.0, le=1.0)  # off-beat onset ratio
    contour: list[int] = Field(default_factory=list)  # sign of successive pitch deltas (-1/0/+1)
    register_band: str = ""  # "sub" / "low" / "mid" / "high"
    harmonic_function: str = ""  # e.g. "root-following" / "tonic-pedal" / "i-VI-III-VII"


class Bass(_Base):
    """The 808/bass sub-model (§0.1) — rhythm × pitch-function stored *separately* so a
    bassline can never be authored as a hi-hat-like even grid (the panel's structural fix).

    Present for `808`/`bass` roles. The grid lives in `Midi.notes` durations; this records
    the relationships that make it a bass voice, not a pulse generator."""

    sustain_ratio: float = Field(0.0, ge=0.0, le=1.0)  # mean note_dur / inter-onset interval
    glides: list[int] = Field(default_factory=list)  # note indices that slide into the next
    kick_alignment: float = Field(0.0, ge=0.0, le=1.0)  # fraction of bass onsets on kick hits
    root_follows: bool = False  # pitch tracks the chord roots
    root_element_id: Optional[str] = None  # the harmony element this bass follows


class Element(_Base):
    element_id: str = Field(default_factory=lambda: str(uuid4()))
    role: Role = Role.other
    label: str = ""
    audio_ref: Optional[str] = None
    midi: Midi = Field(default_factory=Midi)
    sample_match: SampleMatch = Field(default_factory=SampleMatch)
    synth_patch: SynthPatch = Field(default_factory=SynthPatch)
    # Onset times (seconds) where this element fires. Empty → a single placement at 0
    # (back-compat). Non-empty → §9 sequences one clip per onset on ONE track, so a §7
    # drum-slice group reconstructs faithfully on the timeline instead of stacking at 0.
    onsets: list[float] = Field(default_factory=list)
    motif: Optional[Motif] = None  # §0.1 derived musical features (retrieval handle)
    bass: Optional[Bass] = None    # §0.1 set for 808/bass roles (rhythm × pitch-function)
    evidence: list[Evidence] = Field(default_factory=list)
    confidence: float = Field(0.0, ge=0.0, le=1.0)


class Unresolved(_Base):
    issue: str = ""
    element_id: Optional[str] = None
    suggested_action: str = ""


class YieldScores(_Base):
    drums: float = Field(0.0, ge=0.0, le=1.0)
    midi: float = Field(0.0, ge=0.0, le=1.0)
    synth: float = Field(0.0, ge=0.0, le=1.0)
    arrangement: float = Field(0.0, ge=0.0, le=1.0)
    overall: float = Field(0.0, ge=0.0, le=1.0)


class YieldBlock(_Base):
    predicted: YieldScores = Field(default_factory=YieldScores)  # §3 writes
    actual: YieldScores = Field(default_factory=YieldScores)     # §9 writes


# ── the spine ────────────────────────────────────────────────────────────────
class Recipe(_Base):
    recipe_id: str = Field(default_factory=lambda: str(uuid4()))
    schema_version: Literal["2.0"] = SCHEMA_VERSION
    source: Source = Field(default_factory=Source)
    meta: Meta = Field(default_factory=Meta)
    arrangement: Arrangement = Field(default_factory=Arrangement)
    elements: list[Element] = Field(default_factory=list)
    unresolved: list[Unresolved] = Field(default_factory=list)
    reconstruction_class: ReconstructionClass = ReconstructionClass.partial
    # 'yield' is a Python keyword → field name is yield_, JSON key is "yield".
    yield_: YieldBlock = Field(default_factory=YieldBlock, alias="yield")


# ── helpers (the only surfaces other modules + the CLI import) ────────────────
def emit_schema_json() -> str:
    """Deterministic JSON Schema for the contract test + the committed artifact.

    sort_keys=True makes it byte-stable across runs/processes."""
    return json.dumps(Recipe.model_json_schema(by_alias=True), indent=2, sort_keys=True) + "\n"


def to_json(recipe: Recipe) -> str:
    """Canonical serialization: alias keys ("yield"), stable field order."""
    return recipe.model_dump_json(by_alias=True, indent=2)


def from_json(text: str) -> Recipe:
    return Recipe.model_validate_json(text)


def new_skeleton(video_id: str, platform: str = "youtube", **source_fields: Any) -> Recipe:
    """A first-class empty recipe — just the source identity; everything else null."""
    return Recipe(source=Source(video_id=video_id, platform=platform, **source_fields))


def recipe_paths(root: Union[str, Path], recipe_id: str) -> dict[str, Path]:
    """Expected on-disk layout for a recipe (pure — creates nothing)."""
    base = Path(root) / recipe_id
    assets = base / "assets"
    paths = {"dir": base, "recipe_json": base / "recipe.json", "assets": assets,
             "transcript": assets / "transcript.json"}
    for sub in ASSET_SUBDIRS:
        paths[sub] = assets / sub
    return paths


def _main(argv: Optional[list[str]] = None) -> int:
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Recipe contract (§0) tools")
    ap.add_argument("--emit-schema", action="store_true", help="print recipe.schema.json to stdout")
    ap.add_argument("--validate", metavar="FILE", help="validate a recipe JSON file; exit 0 if valid")
    ns = ap.parse_args(argv)

    if ns.emit_schema:
        sys.stdout.write(emit_schema_json())
        return 0
    if ns.validate:
        from_json(Path(ns.validate).read_text())
        print("valid")
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(_main())
