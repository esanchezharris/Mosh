#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
sys.path.insert(0, str(SERVICE))

from teardown import recipe as R  # noqa: E402
from teardown.cli import main as cli_main  # noqa: E402
from teardown.midi_corpus_gate import run_gate  # noqa: E402
from teardown.midi_from_screen.export import write_midi  # noqa: E402
from teardown.midi_ingest import ingest_directory, recipe_from_midi  # noqa: E402
from teardown.render.compile import compile_recipe  # noqa: E402
from recipes import generate as G  # noqa: E402


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        raise AssertionError(name)


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "midi"
        out = Path(td) / "recipes"
        root.mkdir()
        bass_path = root / "Dark 808 Loop.mid"
        melody_path = root / "Trap Melody.mid"
        chord_path = root / "Sad Chords.mid"
        neutral_808_dir = root / "808,,/midis"
        neutral_808_dir.mkdir(parents=True)
        neutral_808_path = neutral_808_dir / "beat.mid"
        perc_dir = root / "Percussion"
        perc_dir.mkdir()
        stomp_path = perc_dir / "West Coast Stomps.mid"
        drum_path = root / "Full Drum Groove.mid"
        write_midi([
            {"pitch": 29, "start": 0.0, "end": 1.5, "velocity": 112},
            {"pitch": 36, "start": 2.0, "end": 4.0, "velocity": 105},
        ], bass_path, bpm=140)
        write_midi([
            {"pitch": 72, "start": 0.0, "end": 0.5, "velocity": 90},
            {"pitch": 75, "start": 0.5, "end": 1.0, "velocity": 88},
            {"pitch": 79, "start": 1.0, "end": 2.0, "velocity": 92},
        ], melody_path, bpm=140)
        write_midi([
            {"pitch": 48, "start": 0.0, "end": 2.0, "velocity": 70},
            {"pitch": 52, "start": 0.0, "end": 2.0, "velocity": 70},
            {"pitch": 55, "start": 0.0, "end": 2.0, "velocity": 70},
        ], chord_path, bpm=140)
        write_midi([
            {"pitch": 31, "start": 0.0, "end": 1.0, "velocity": 110},
            {"pitch": 31, "start": 2.0, "end": 3.0, "velocity": 104},
        ], neutral_808_path, bpm=140)
        write_midi([
            {"pitch": 43, "start": 0.0, "end": 0.25, "velocity": 100},
            {"pitch": 43, "start": 1.0, "end": 1.25, "velocity": 100},
        ], stomp_path, bpm=140)
        write_midi([
            {"pitch": 36, "start": 0.0, "end": 0.125, "velocity": 110},
            {"pitch": 42, "start": 0.5, "end": 0.625, "velocity": 82},
            {"pitch": 38, "start": 1.0, "end": 1.125, "velocity": 104},
            {"pitch": 40, "start": 3.0, "end": 3.125, "velocity": 101},
        ], drum_path, bpm=140)

        rec = recipe_from_midi(bass_path, bpm=140, key="F minor")
        check("808 filename maps to generator-consumable 808 role", rec.elements[0].role == R.Role.r808, rec.elements[0].role.value)
        check("MIDI notes are inline recipe body", rec.elements[0].midi.note_count == 2 and len(rec.elements[0].midi.notes) == 2)
        check("808 ingest adds bass model", rec.elements[0].bass is not None and rec.elements[0].bass.sustain_ratio > 0.5)
        check("recipe is deterministic direct-MIDI provenance", rec.reconstruction_class == R.ReconstructionClass.deterministic)
        check("recipe stays portable without local source URL", rec.source.url == "" and rec.source.content_hash is not None)
        check("808 parent folder maps neutral filenames to 808", recipe_from_midi(neutral_808_path).elements[0].role == R.Role.r808)
        check("percussion parent folder maps stomps to perc", recipe_from_midi(stomp_path).elements[0].role == R.Role.perc)

        compiled = compile_recipe(rec)
        clip = next(c for c in compiled.commands if c["command"] == "add_midi_clip")
        check("compiled ingredient emits inline add_midi_clip notes", len(clip["args"].get("notes", [])) == 2)
        check("808 ingredient creates audio track", any(c["command"] == "create_track" and c["args"]["type"] == "audio" for c in compiled.commands))

        library_out = Path(td) / "library"
        summary = ingest_directory(root, out, bpm=140, key="F minor", library_out=library_out)
        roles = {item["role"] for item in summary["recipes"]}
        check("directory ingest writes six recipes", summary["recipe_count"] == 6, json.dumps(summary, sort_keys=True))
        check("directory ingest classifies 808, lead, and pad", {"808", "lead", "pad"}.issubset(roles), str(roles))
        check("directory ingest writes flat generator library", len(list(library_out.glob("*.json"))) == 6)
        generated, _ = G.generate({"tempo": 140, "key": "F minor", "lead": True}, library_dir=str(library_out), seed=4, palette={})
        generated_roles = {element.role.value for element in generated.elements}
        check("flat ingested library is loadable by generator", {"808", "pad"}.issubset(generated_roles), str(generated_roles))
        check("summary.json written", (out / "summary.json").is_file())
        written = sorted(out.glob("*/recipe.json"))
        check("each ingested recipe validates", len(written) == 6 and all(R.from_json(path.read_text()) for path in written))

        split_out = Path(td) / "split-recipes"
        split_library = Path(td) / "split-library"
        split_summary = ingest_directory(root, split_out, bpm=140, key="F minor",
                                         library_out=split_library,
                                         split_drum_roles=(R.Role.kick, R.Role.snare, R.Role.hat))
        split_roles = [item["role"] for item in split_summary["recipes"]]
        check("split-drum ingest writes per-role drum ingredients", split_roles == ["kick", "snare", "hat"], str(split_roles))
        snare_item = next(item for item in split_summary["recipes"] if item["role"] == "snare")
        check("split-drum summary records source role filter",
              snare_item.get("source_role_filter") == "snare",
              json.dumps(snare_item, sort_keys=True))
        split_recipe = R.from_json(Path(snare_item["recipe"]).read_text())
        split_notes = split_recipe.elements[0].midi.notes
        check("split snare recipe keeps only GM snare notes",
              [note.pitch for note in split_notes] == [38, 40],
              str([note.pitch for note in split_notes]))
        gate = run_gate(Path(td), min_recipes=1)
        check("midi corpus gate verifies split snare against filtered source", gate["ok"], json.dumps(gate, sort_keys=True))

        cli_out = Path(td) / "cli-recipes"
        cli_library = Path(td) / "cli-library"
        rc = cli_main(["ingest-midi", "--dir", str(root), "--out", str(cli_out),
                       "--library-out", str(cli_library), "--bpm", "140", "--key", "F minor"])
        check("CLI ingest-midi exits 0", rc == 0)
        cli_summary = json.loads((cli_out / "summary.json").read_text())
        check("CLI ingest writes summary", cli_summary["recipe_count"] == 6, json.dumps(cli_summary, sort_keys=True))
        check("CLI ingest writes flat library", len(list(cli_library.glob("*.json"))) == 6)

        cli_split_out = Path(td) / "cli-split-recipes"
        cli_split_library = Path(td) / "cli-split-library"
        rc = cli_main(["ingest-midi", "--dir", str(root), "--out", str(cli_split_out),
                       "--library-out", str(cli_split_library), "--bpm", "140", "--key", "F minor",
                       "--split-drum-roles", "snare"])
        check("CLI split-drum ingest exits 0", rc == 0)
        cli_split_summary = json.loads((cli_split_out / "summary.json").read_text())
        check("CLI split-drum ingest writes snare only",
              [item["role"] for item in cli_split_summary["recipes"]] == ["snare"],
              json.dumps(cli_split_summary, sort_keys=True))
        check("CLI split-drum ingest records source role filter",
              cli_split_summary["recipes"][0].get("source_role_filter") == "snare",
              json.dumps(cli_split_summary["recipes"][0], sort_keys=True))

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
