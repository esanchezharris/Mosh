#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from teardown import recipe as R  # noqa: E402
from teardown.render.compile import compile_recipe  # noqa: E402
from teardown.render.midi_read import read_midi  # noqa: E402


def _note_matches(src: dict[str, Any], got: R.NoteEvent) -> bool:
    return (
        int(src["pitch"]) == int(got.pitch)
        and abs(float(src["start"]) - float(got.start_beats)) <= 1e-6
        and abs(float(src["length"]) - float(got.duration_beats)) <= 1e-6
        and int(src.get("velocity", 100)) == int(got.velocity)
    )


def _summary_paths(root: Path) -> list[Path]:
    return sorted(
        path for path in root.glob("*/summary.json")
        if path.parent.name != "library"
    )


def run_gate(root: Path, *, min_recipes: int) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    warnings: list[str] = []
    roles: dict[str, int] = {}
    note_counts: dict[str, int] = {}
    checked = 0

    summaries = _summary_paths(root)
    if not summaries:
        failures.append({"error": "no summary.json files", "root": str(root)})

    for summary_path in summaries:
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            failures.append({"summary": str(summary_path), "error": str(e)})
            continue

        for item in summary.get("recipes", []):
            checked += 1
            input_path = Path(item.get("input", ""))
            recipe_path = Path(item.get("recipe", ""))
            library_recipe = Path(item.get("library_recipe", ""))

            if not input_path.exists():
                failures.append({"recipe": str(recipe_path), "error": "missing source MIDI", "input": str(input_path)})
                continue
            if not recipe_path.exists():
                failures.append({"recipe": str(recipe_path), "error": "missing recipe"})
                continue
            if str(library_recipe) and not library_recipe.exists():
                failures.append({"recipe": str(recipe_path), "error": "missing library copy", "library_recipe": str(library_recipe)})
                continue

            try:
                rec = R.from_json(recipe_path.read_text(encoding="utf-8"))
                compiled = compile_recipe(rec)
                source_notes = read_midi(input_path)
            except Exception as e:  # noqa: BLE001
                failures.append({"recipe": str(recipe_path), "error": str(e)})
                continue

            if not rec.elements:
                failures.append({"recipe": str(recipe_path), "error": "recipe has no elements"})
                continue
            element = rec.elements[0]
            role = element.role.value
            roles[role] = roles.get(role, 0) + 1
            recipe_notes = element.midi.notes if element.midi else []
            note_counts[role] = note_counts.get(role, 0) + len(recipe_notes)

            if not recipe_notes:
                failures.append({"recipe": str(recipe_path), "error": "recipe has no inline MIDI notes"})
                continue
            if len(source_notes) != len(recipe_notes):
                failures.append({
                    "recipe": str(recipe_path),
                    "error": "source/recipe note count mismatch",
                    "source_notes": len(source_notes),
                    "recipe_notes": len(recipe_notes),
                })
                continue
            for index, (src_note, got_note) in enumerate(zip(source_notes, recipe_notes)):
                if not _note_matches(src_note, got_note):
                    failures.append({
                        "recipe": str(recipe_path),
                        "error": "source/recipe note mismatch",
                        "note_index": index,
                        "source": src_note,
                        "recipe": got_note.model_dump(),
                    })
                    break

            if len(compiled.commands) == 0:
                failures.append({"recipe": str(recipe_path), "error": "compiled program is empty"})

    if checked < min_recipes:
        failures.append({"error": "not enough recipes", "checked": checked, "min_recipes": min_recipes})
    for role in ("808", "kick", "hat", "pad"):
        if roles.get(role, 0) == 0:
            failures.append({"error": "missing required generator role", "role": role})
    for role in ("snare", "clap", "lead"):
        if roles.get(role, 0) == 0:
            warnings.append(f"no {role} ingredients in corpus")

    return {
        "ok": not failures,
        "root": str(root),
        "summary_files": [str(path) for path in summaries],
        "checked": checked,
        "min_recipes": min_recipes,
        "roles": dict(sorted(roles.items())),
        "noteCountsByRole": dict(sorted(note_counts.items())),
        "warnings": warnings,
        "failures": failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gate local MIDI ingredients against their source .mid files")
    parser.add_argument("--root", required=True, help="midi-ingredients run directory containing */summary.json")
    parser.add_argument("--min-recipes", type=int, default=30)
    args = parser.parse_args(argv)

    result = run_gate(Path(args.root), min_recipes=args.min_recipes)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
