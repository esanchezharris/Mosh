#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "service"
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

DEFAULT_ROOT = REPO / ".cache" / "mosh-teardown" / "midi-ingredients" / "2026-07-01-r2"
DEFAULT_BIN = REPO / "build-macos-arm64" / "Mosh_artefacts" / "Debug" / "Mosh.app" / "Contents" / "MacOS" / "Mosh"

REQUESTS = [
    ({"mood": "dark", "tempo": 140, "key": "F minor"}, 3),
    ({"mood": "emotional", "tempo": 146, "key": "C# minor"}, 5),
    ({"mood": "aggressive", "tempo": 150, "key": "D minor"}, 9),
]


def _jsonable_provenance(prov: Any) -> dict[str, Any]:
    return {
        "backbone": prov.backbone,
        "sources": dict(prov.sources),
        "transpose": dict(prov.transpose),
        "samples": dict(prov.samples),
        "key": prov.key,
        "tempo": prov.tempo,
    }


def _render_rows(root: Path, bin_path: Path, palette_manifest: str) -> tuple[list[dict[str, Any]], list[str]]:
    from recipes import generate as G
    from teardown.render.compile import compile_recipe
    from teardown.render.execute import execute_recipe

    failures: list[str] = []
    rows: list[dict[str, Any]] = []
    library_dir = root / "library"
    palette = G.load_palette(palette_manifest) if palette_manifest else G.load_palette()
    if not bin_path.is_file():
        return [], [f"missing Mosh binary: {bin_path}"]
    if not palette:
        return [], ["missing palette manifest or no palette entries"]

    with tempfile.TemporaryDirectory(prefix="gate-a-midi-") as td:
        tmp = Path(td)
        for index, (request, seed) in enumerate(REQUESTS):
            rec, prov = G.generate(request, library_dir=str(library_dir), seed=seed, palette=palette)
            compiled = compile_recipe(rec)
            wav = tmp / f"render-{index}.wav"
            res = execute_recipe(
                rec,
                bin_path=str(bin_path),
                out_wav=str(wav),
                session_dir=str(tmp / f"s{index}"),
                timeout_s=180,
                write_back=False,
                resolve_synth_patches=False,
            )
            has_melodic_808 = any(
                command.get("command") == "assign_sample"
                and command.get("args", {}).get("mode") == "melodic"
                for command in compiled.commands
            )
            distinct_sources = sorted(set(prov.sources.values()))
            row_failures = []
            if not res.nonsilent:
                row_failures.append("render silent")
            if res.error is not None:
                row_failures.append(f"render error: {res.error}")
            if not has_melodic_808:
                row_failures.append("808 not compiled as melodic sampler")
            if len(distinct_sources) <= 1:
                row_failures.append("no cross-source recombination")
            failures.extend(f"{request}: {failure}" for failure in row_failures)
            rows.append(
                {
                    "request": request,
                    "seed": seed,
                    "recipe_id": rec.recipe_id,
                    "provenance": _jsonable_provenance(prov),
                    "distinct_sources": distinct_sources,
                    "command_count": len(compiled.commands),
                    "unresolved_count": len(compiled.unresolved),
                    "has_melodic_808": has_melodic_808,
                    "render": {
                        "ran": res.ran,
                        "nonsilent": res.nonsilent,
                        "audio_rms": round(float(res.audio_rms), 8),
                        "error": res.error,
                        "yield_actual": res.yield_actual,
                    },
                    "ok": not row_failures,
                    "failures": row_failures,
                }
            )
    return rows, failures


def _requirements(corpus_gate: dict[str, Any], render_rows: list[dict[str, Any]], render_failures: list[str]) -> list[dict[str, Any]]:
    roles = corpus_gate.get("roles", {})
    return [
        {
            "name": "source_midi_note_fidelity",
            "ok": bool(corpus_gate.get("ok")),
            "evidence": "midi_corpus_gate matched every recipe note to its source MIDI, including source_role_filter splits",
        },
        {
            "name": "minimum_corpus_size",
            "ok": int(corpus_gate.get("checked", 0)) >= int(corpus_gate.get("min_recipes", 0)),
            "evidence": {"checked": corpus_gate.get("checked"), "min_recipes": corpus_gate.get("min_recipes")},
        },
        {
            "name": "required_generator_roles",
            "ok": all(int(roles.get(role, 0)) > 0 for role in ("808", "kick", "hat", "pad")),
            "evidence": roles,
        },
        {
            "name": "all_current_drum_roles_covered",
            "ok": all(int(roles.get(role, 0)) > 0 for role in ("kick", "snare", "hat", "clap", "perc")),
            "evidence": roles,
        },
        {
            "name": "generated_renders_non_silent",
            "ok": bool(render_rows) and all(row["render"]["nonsilent"] and row["render"]["error"] is None for row in render_rows),
            "evidence": [{"request": row["request"], "rms": row["render"]["audio_rms"], "error": row["render"]["error"]} for row in render_rows],
        },
        {
            "name": "melodic_808_sampler",
            "ok": bool(render_rows) and all(row["has_melodic_808"] for row in render_rows),
            "evidence": [{"request": row["request"], "has_melodic_808": row["has_melodic_808"]} for row in render_rows],
        },
        {
            "name": "cross_source_recombination",
            "ok": bool(render_rows) and all(len(row["distinct_sources"]) > 1 for row in render_rows),
            "evidence": [{"request": row["request"], "sources": row["provenance"]["sources"]} for row in render_rows],
        },
        {
            "name": "render_failures_absent",
            "ok": not render_failures,
            "evidence": render_failures,
        },
    ]


def main(argv: list[str] | None = None) -> int:
    from teardown.midi_corpus_gate import run_gate

    parser = argparse.ArgumentParser(description="Write a Gate-A-style JSON audit for a local MIDI ingredient corpus")
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="midi ingredient run directory")
    parser.add_argument("--min-recipes", type=int, default=30)
    parser.add_argument("--bin", default=os.environ.get("MOSH_BIN", str(DEFAULT_BIN)))
    parser.add_argument("--palette-manifest", default=os.environ.get("MOSH_PALETTE_MANIFEST", ""))
    parser.add_argument("--out", default="", help="optional JSON report path")
    args = parser.parse_args(argv)

    root = Path(args.root)
    corpus_gate = run_gate(root, min_recipes=args.min_recipes)
    render_rows, render_failures = _render_rows(root, Path(args.bin), args.palette_manifest)
    requirements = _requirements(corpus_gate, render_rows, render_failures)
    report = {
        "ok": all(item["ok"] for item in requirements),
        "root": str(root),
        "bin": str(Path(args.bin)),
        "palette_manifest": args.palette_manifest,
        "corpus_gate": corpus_gate,
        "render_rows": render_rows,
        "requirements": requirements,
        "scope_note": (
            "MIDI-native Gate A: source audio A/B is not applicable to local .mid packs; "
            "fidelity is exact source MIDI note match plus real render proof."
        ),
    }

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
