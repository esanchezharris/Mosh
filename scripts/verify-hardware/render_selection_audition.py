#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "service"
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

DEFAULT_BIN = REPO / "build-macos-arm64" / "Mosh_artefacts" / "Debug" / "Mosh.app" / "Contents" / "MacOS" / "Mosh"
DEFAULT_OUT = Path("~/mosh-beats/r7-selection").expanduser()
BASE_SEED_STEP = 97

BEATS = [
    ({"mood": "dark", "tempo": 140, "key": "F minor"}, 3),
    ({"mood": "dark", "tempo": 140, "key": "F minor"}, 11),
    ({"mood": "emotional", "tempo": 146, "key": "C# minor"}, 5),
    ({"mood": "emotional", "tempo": 150, "key": "G minor"}, 21),
    ({"mood": "aggressive", "tempo": 150, "key": "D minor"}, 9),
    ({"mood": "chill", "tempo": 132, "key": "A minor"}, 4),
]

SCORE_FIELDS = [
    "group",
    "candidate",
    "file",
    "prompt",
    "seed",
    "musically_distinct_1_5",
    "would_keep_1_5",
    "keep",
    "notes",
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


def _slug_key(key: str) -> str:
    return key.replace(" ", "").replace("#", "s")


def _score(raw: str) -> float | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if 1 <= value <= 5 else None


def _keep(raw: str) -> bool:
    return str(raw or "").strip().lower() in {"1", "true", "yes", "y", "keep", "x"}


def render_pack(out_dir: Path, *, candidates_per_prompt: int) -> int:
    from recipes import generate as G
    from teardown.render.execute import execute_recipe

    binp = Path(os.environ.get("MOSH_BIN", "").strip() or str(DEFAULT_BIN))
    if not binp.is_file():
        print(f"SKIP: no Mosh binary at {binp!s}")
        return 0
    library_dir = Path(os.environ.get("MOSH_RECIPE_LIBRARY", "").strip() or G.LIB_DIR)
    palette_manifest = os.environ.get("MOSH_PALETTE_MANIFEST", "").strip()
    palette = G.load_palette(palette_manifest) if palette_manifest else G.load_palette()
    if not palette:
        print("SKIP: no palette manifest (owner-private)")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    score_rows: list[dict[str, Any]] = []
    readme_lines = [
        "# r7 generate-N selection pack",
        "",
        "This is a pre-Gate-C selection pass: score several candidates per prompt, then run `select` to copy the best few into `selected/`.",
        f"Library: {library_dir}",
        "",
    ]

    ok_count = 0
    total = 0
    for group_index, (request, base_seed) in enumerate(BEATS, start=1):
        prompt_label = f"{request['mood']} {int(request['tempo'])}bpm {request['key']}"
        readme_lines.append(f"## Group {group_index:02d} - {prompt_label}")
        for candidate_index in range(candidates_per_prompt):
            label = chr(ord("A") + candidate_index)
            seed = base_seed + candidate_index * BASE_SEED_STEP
            rec, prov = G.generate(request, library_dir=str(library_dir), seed=seed, palette=palette)
            filename = (
                f"g{group_index:02d}_{label}_{request['mood']}_"
                f"{int(request['tempo'])}_{_slug_key(request['key'])}_seed{seed}.wav"
            )
            wav = out_dir / filename
            session_dir = out_dir / f".s{group_index:02d}_{label}"
            res = execute_recipe(
                rec,
                bin_path=str(binp),
                out_wav=str(wav),
                session_dir=str(session_dir),
                timeout_s=180,
                write_back=False,
                resolve_synth_patches=False,
            )
            total += 1
            ok = bool(res.nonsilent and res.error is None)
            ok_count += 1 if ok else 0
            status = "OK " if ok else "BAD"
            print(f"  {status} {filename} rms={res.audio_rms:.4f} seed={seed}")
            readme_lines.append(f"- `{filename}`")
            score_rows.append(
                {
                    "group": f"{group_index:02d}",
                    "candidate": label,
                    "file": filename,
                    "prompt": prompt_label,
                    "seed": seed,
                    "musically_distinct_1_5": "",
                    "would_keep_1_5": "",
                    "keep": "",
                    "notes": "",
                }
            )
            manifest.append(
                {
                    "group": group_index,
                    "candidate": label,
                    "file": filename,
                    "request": request,
                    "seed": seed,
                    "recipe_id": rec.recipe_id,
                    "provenance": _jsonable_provenance(prov),
                    "render": {
                        "nonsilent": res.nonsilent,
                        "audio_rms": round(float(res.audio_rms), 8),
                        "error": res.error,
                    },
                }
            )
        readme_lines.append("")

    (out_dir / "README.md").write_text("\n".join(readme_lines) + "\n", encoding="utf-8")
    (out_dir / "selection_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with (out_dir / "scorecard.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=SCORE_FIELDS)
        writer.writeheader()
        writer.writerows(score_rows)
    print(f"\n{ok_count}/{total} rendered -> {out_dir}")
    return 0 if ok_count == total else 1


def select_pack(out_dir: Path, *, selected_dir: Path | None = None, top_k: int = 1) -> int:
    scorecard_path = out_dir / "scorecard.csv"
    manifest_path = out_dir / "selection_manifest.json"
    if not scorecard_path.is_file():
        print(f"FAIL: missing scorecard {scorecard_path}")
        return 1
    if not manifest_path.is_file():
        print(f"FAIL: missing selection manifest {manifest_path}")
        return 1

    with scorecard_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_by_file = {str(item.get("file")): item for item in manifest}
    by_group: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        distinct = _score(row.get("musically_distinct_1_5", ""))
        would_keep = _score(row.get("would_keep_1_5", ""))
        if distinct is None or would_keep is None:
            continue
        row = dict(row)
        row["_selection_score"] = (distinct + would_keep) / 2.0
        row["_explicit_keep"] = _keep(row.get("keep", ""))
        by_group.setdefault(str(row.get("group", "")), []).append(row)

    selected_rows: list[dict[str, Any]] = []
    for group, candidates in sorted(by_group.items()):
        explicit = [row for row in candidates if row["_explicit_keep"]]
        if explicit:
            selected_rows.extend(sorted(explicit, key=lambda row: (-row["_selection_score"], str(row.get("candidate", "")))))
            continue
        selected_rows.extend(sorted(candidates, key=lambda row: (-row["_selection_score"], str(row.get("candidate", ""))))[:top_k])

    if not selected_rows:
        print("FAIL: no scored rows selected; fill musically_distinct_1_5 and would_keep_1_5 first")
        return 1

    selected_dir = selected_dir or (out_dir / "selected")
    selected_dir.mkdir(parents=True, exist_ok=True)
    selected_manifest: list[dict[str, Any]] = []
    readme_lines = ["# selected r7 audition candidates", ""]
    for row in selected_rows:
        filename = str(row["file"])
        source = out_dir / filename
        dest = selected_dir / filename
        if not source.is_file():
            print(f"FAIL: missing selected WAV {source}")
            return 1
        shutil.copy2(source, dest)
        item = dict(manifest_by_file.get(filename) or {})
        item["selection"] = {
            "musically_distinct_1_5": row.get("musically_distinct_1_5", ""),
            "would_keep_1_5": row.get("would_keep_1_5", ""),
            "selection_score": round(float(row["_selection_score"]), 3),
            "explicit_keep": bool(row["_explicit_keep"]),
            "notes": row.get("notes", ""),
        }
        selected_manifest.append(item)
        readme_lines.append(
            f"- `{filename}` - group {row.get('group')} candidate {row.get('candidate')} score {item['selection']['selection_score']}"
        )

    (selected_dir / "selected_manifest.json").write_text(
        json.dumps(selected_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (selected_dir / "README.md").write_text("\n".join(readme_lines) + "\n", encoding="utf-8")
    print(f"selected {len(selected_rows)} candidate(s) -> {selected_dir}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render or select a generate-N r7 audition pack")
    sub = parser.add_subparsers(dest="mode", required=True)
    render = sub.add_parser("render", help="render multiple candidates per prompt")
    render.add_argument("out_dir", nargs="?", default=str(DEFAULT_OUT))
    render.add_argument("--candidates-per-prompt", type=int, default=4)
    select = sub.add_parser("select", help="copy the best scored candidates into selected/")
    select.add_argument("out_dir", nargs="?", default=str(DEFAULT_OUT))
    select.add_argument("--selected-dir", default="")
    select.add_argument("--top-k", type=int, default=1)
    args = parser.parse_args(argv)

    if args.mode == "render":
        if args.candidates_per_prompt < 1 or args.candidates_per_prompt > 26:
            parser.error("--candidates-per-prompt must be between 1 and 26")
        return render_pack(Path(args.out_dir).expanduser(), candidates_per_prompt=args.candidates_per_prompt)
    selected_dir = Path(args.selected_dir).expanduser() if args.selected_dir else None
    if args.top_k < 1:
        parser.error("--top-k must be >= 1")
    return select_pack(Path(args.out_dir).expanduser(), selected_dir=selected_dir, top_k=args.top_k)


if __name__ == "__main__":
    raise SystemExit(main())
