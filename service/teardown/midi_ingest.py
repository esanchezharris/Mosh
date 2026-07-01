from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from statistics import median
from typing import Any

from teardown import recipe as R
from teardown.render.compile import compile_recipe
from teardown.render.midi_read import read_midi


_DRUM_PITCH_ROLES = {
    35: R.Role.kick,
    36: R.Role.kick,
    38: R.Role.snare,
    40: R.Role.snare,
    42: R.Role.hat,
    44: R.Role.hat,
    46: R.Role.hat,
    39: R.Role.clap,
}

_DRUM_SPLIT_PITCHES = {
    R.Role.kick: {35, 36},
    R.Role.snare: {38, 40},
    R.Role.clap: {39},
    R.Role.hat: {42, 44, 46},
}


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug or "midi"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _role_from_name(path: Path) -> R.Role | None:
    nearby = " ".join(part.lower() for part in (*path.parts[-4:-1], path.stem))
    name = nearby
    if "808" in name or "sub" in name or "bass" in name:
        return R.Role.r808
    if "kick" in name:
        return R.Role.kick
    if "snare" in name:
        return R.Role.snare
    if "clap" in name:
        return R.Role.clap
    if "hat" in name or "hihat" in name or "hi_hat" in name or "hi-hat" in name:
        return R.Role.hat
    if "perc" in name or "rim" in name or "shaker" in name or "stomp" in name:
        return R.Role.perc
    if "chord" in name or "progression" in name or "pad" in name:
        return R.Role.pad
    if "lead" in name or "melody" in name or "melodic" in name or "pluck" in name or "arp" in name:
        return R.Role.lead
    return None


def _looks_like_drum_source(path: Path) -> bool:
    nearby = " ".join(part.lower() for part in (*path.parts[-4:-1], path.stem))
    return any(word in nearby for word in ("drum", "groove", "kick", "snare", "clap", "hat", "perc"))


def classify_role(path: Path, notes: list[dict[str, Any]]) -> R.Role:
    named = _role_from_name(path)
    if named is not None:
        return named
    pitches = [int(n["pitch"]) for n in notes]
    if not pitches:
        return R.Role.other
    common_pitch = max(sorted(set(pitches)), key=pitches.count)
    if common_pitch in _DRUM_PITCH_ROLES and len(set(pitches)) <= 3:
        return _DRUM_PITCH_ROLES[common_pitch]
    short_mean = sum(float(n["length"]) for n in notes) / max(1, len(notes))
    if max(pitches) <= 51 and short_mean <= 0.75:
        return R.Role.perc
    if median(pitches) <= 45:
        return R.Role.r808
    if _has_chords(notes):
        return R.Role.pad
    return R.Role.lead


def _has_chords(notes: list[dict[str, Any]]) -> bool:
    starts: dict[float, set[int]] = {}
    for note in notes:
        starts.setdefault(round(float(note["start"]), 3), set()).add(int(note["pitch"]))
    return any(len(pitches) >= 3 for pitches in starts.values())


def _bars(notes: list[dict[str, Any]]) -> float:
    if not notes:
        return 0.0
    end = max(float(n["start"]) + float(n["length"]) for n in notes)
    return float(max(1, math.ceil(end / 4.0)))


def _onset_grid(notes: list[dict[str, Any]]) -> str:
    starts = sorted({round(float(n["start"]), 6) for n in notes})
    gaps = [b - a for a, b in zip(starts, starts[1:]) if b - a > 1e-6]
    if not gaps:
        return "single"
    smallest = min(gaps)
    if abs(smallest - (1.0 / 3.0)) < 0.04 or abs(smallest - (2.0 / 3.0)) < 0.04:
        return "triplet"
    if smallest <= 0.25 + 1e-6:
        return "16th"
    if smallest <= 0.5 + 1e-6:
        return "8th"
    if smallest <= 1.0 + 1e-6:
        return "4th"
    if smallest <= 2.0 + 1e-6:
        return "half"
    return "whole"


def _register_band(notes: list[dict[str, Any]]) -> str:
    if not notes:
        return ""
    mid = median(int(n["pitch"]) for n in notes)
    if mid <= 43:
        return "sub"
    if mid <= 55:
        return "low"
    if mid <= 72:
        return "mid"
    return "high"


def _contour(notes: list[dict[str, Any]]) -> list[int]:
    ordered = sorted(notes, key=lambda n: (float(n["start"]), int(n["pitch"])))
    return [
        1 if int(b["pitch"]) > int(a["pitch"]) else (-1 if int(b["pitch"]) < int(a["pitch"]) else 0)
        for a, b in zip(ordered, ordered[1:33])
    ]


def _syncopation(notes: list[dict[str, Any]]) -> float:
    if not notes:
        return 0.0
    off = 0
    for note in notes:
        beat = float(note["start"])
        if abs(beat - round(beat)) > 0.05:
            off += 1
    return round(off / len(notes), 4)


def _bass_model(notes: list[dict[str, Any]]) -> R.Bass:
    starts = sorted(float(n["start"]) for n in notes)
    gaps = [b - a for a, b in zip(starts, starts[1:])] or [1.0]
    mean_gap = sum(gaps) / len(gaps)
    mean_len = sum(float(n["length"]) for n in notes) / max(1, len(notes))
    return R.Bass(sustain_ratio=round(min(1.0, mean_len / max(0.25, mean_gap)), 4), root_follows=False)


def _note_events(notes: list[dict[str, Any]]) -> list[R.NoteEvent]:
    return [
        R.NoteEvent(
            pitch=int(note["pitch"]),
            start_beats=round(float(note["start"]), 6),
            duration_beats=round(max(float(note["length"]), 0.001), 6),
            velocity=int(note.get("velocity", 100)),
        )
        for note in notes
    ]


def _notes_for_role(notes: list[dict[str, Any]], role: R.Role) -> list[dict[str, Any]]:
    pitches = _DRUM_SPLIT_PITCHES.get(role)
    if not pitches:
        return []
    return [note for note in notes if int(note["pitch"]) in pitches]


def recipe_from_midi(
    path: str | Path,
    *,
    bpm: float = 140.0,
    key: str = "",
    role_override: R.Role | None = None,
    notes_override: list[dict[str, Any]] | None = None,
    recipe_id_suffix: str = "",
) -> R.Recipe:
    midi_path = Path(path)
    notes = notes_override if notes_override is not None else read_midi(midi_path)
    role = role_override or classify_role(midi_path, notes)
    events = _note_events(notes)
    slug = _safe_slug(f"{midi_path.stem}_{recipe_id_suffix}" if recipe_id_suffix else midi_path.stem)
    label = f"{midi_path.stem} {role.value}" if recipe_id_suffix else midi_path.stem
    motif = R.Motif(
        bars=_bars(notes),
        onset_grid=_onset_grid(notes),
        density=round(len(notes) / max(1.0, _bars(notes)), 4),
        syncopation=_syncopation(notes),
        contour=_contour(notes),
        register_band="perc" if role in {R.Role.kick, R.Role.snare, R.Role.hat, R.Role.clap, R.Role.perc} else _register_band(notes),
        harmonic_function="progression" if role == R.Role.pad else ("root-candidate" if role == R.Role.r808 else ""),
    )
    element = R.Element(
        element_id=slug,
        role=role,
        label=label,
        midi=R.Midi(status=R.MidiStatus.extracted, notes=events, note_count=len(events), confidence=1.0),
        motif=motif,
        bass=_bass_model(notes) if role == R.Role.r808 else None,
        confidence=1.0,
    )
    return R.Recipe(
        recipe_id=slug,
        source=R.Source(platform="local-midi", video_id=slug, title=midi_path.stem, content_hash=_sha256(midi_path)),
        meta=R.Meta(
            tempo_bpm=R.MetaField(value=round(float(bpm), 4), confidence=0.75, evidence=["ingest-midi --bpm"]),
            key=R.MetaField(value=key or None, confidence=0.5 if key else 0.0, evidence=["ingest-midi --key"] if key else []),
            time_signature=R.MetaField(value="4/4", confidence=0.6),
        ),
        arrangement=R.Arrangement(sections=[R.Section(name="loop", start_s=0.0, end_s=_bars(notes) * 4.0 * 60.0 / max(1.0, bpm), confidence=0.5)]),
        elements=[element],
        reconstruction_class=R.ReconstructionClass.deterministic,
        yield_=R.YieldBlock(predicted=R.YieldScores(midi=1.0, arrangement=0.5, overall=0.65)),
    )


def ingest_directory(
    root: str | Path,
    out_dir: str | Path,
    *,
    bpm: float = 140.0,
    key: str = "",
    limit: int = 0,
    library_out: str | Path | None = None,
    split_drum_roles: tuple[R.Role, ...] = (),
) -> dict[str, Any]:
    root_path = Path(root)
    out_path = Path(out_dir)
    library_path = Path(library_out) if library_out else None
    midi_files = sorted(path for path in root_path.rglob("*") if path.suffix.lower() in {".mid", ".midi"})
    if limit:
        midi_files = midi_files[:limit]
    recipes = []
    for index, midi_path in enumerate(midi_files):
        source_notes = read_midi(midi_path)
        if split_drum_roles:
            if not _looks_like_drum_source(midi_path):
                continue
            recipe_specs = []
            for role in split_drum_roles:
                role_notes = _notes_for_role(source_notes, role)
                if role_notes:
                    recipe_specs.append((role, role_notes, role.value))
        else:
            recipe_specs = [(None, source_notes, "")]

        for role, notes, suffix in recipe_specs:
            rec = recipe_from_midi(
                midi_path,
                bpm=bpm,
                key=key,
                role_override=role,
                notes_override=notes,
                recipe_id_suffix=suffix,
            )
            folder = out_path / f"{len(recipes) + 1:03d}_{rec.recipe_id}"
            folder.mkdir(parents=True, exist_ok=True)
            recipe_json = folder / "recipe.json"
            recipe_json.write_text(R.to_json(rec) + "\n", encoding="utf-8")
            library_recipe = ""
            if library_path is not None:
                library_path.mkdir(parents=True, exist_ok=True)
                digest = (rec.source.content_hash or "")[:8]
                library_recipe_path = library_path / f"{rec.recipe_id}_{digest}.json"
                library_recipe_path.write_text(R.to_json(rec) + "\n", encoding="utf-8")
                library_recipe = str(library_recipe_path)
            compiled = compile_recipe(rec)
            item = {
                "input": str(midi_path),
                "recipe": str(recipe_json),
                "library_recipe": library_recipe,
                "recipe_id": rec.recipe_id,
                "role": rec.elements[0].role.value if rec.elements else "other",
                "notes": rec.elements[0].midi.note_count if rec.elements else 0,
                "commands": len(compiled.commands),
                "unresolved": len(compiled.unresolved),
            }
            if role is not None:
                item["source_role_filter"] = role.value
            recipes.append(item)
    summary = {"input_dir": str(root_path), "out_dir": str(out_path), "recipe_count": len(recipes), "recipes": recipes}
    out_path.mkdir(parents=True, exist_ok=True)
    (out_path / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary
