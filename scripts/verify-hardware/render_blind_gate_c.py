#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "service"
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

DEFAULT_BIN = REPO / "build-macos-arm64" / "Mosh_artefacts" / "Debug" / "Mosh.app" / "Contents" / "MacOS" / "Mosh"
BASELINE_LIBRARY = SERVICE / "recipes" / "library"

BEATS = [
    ({"mood": "dark", "tempo": 140, "key": "F minor"}, 3),
    ({"mood": "dark", "tempo": 140, "key": "F minor"}, 11),
    ({"mood": "emotional", "tempo": 146, "key": "C# minor"}, 5),
    ({"mood": "emotional", "tempo": 150, "key": "G minor"}, 21),
    ({"mood": "aggressive", "tempo": 150, "key": "D minor"}, 9),
    ({"mood": "chill", "tempo": 132, "key": "A minor"}, 4),
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


def _blind_order(group_index: int, count: int) -> list[int]:
    values = []
    for index in range(count):
        digest = hashlib.sha256(f"gate-c:{group_index}:{index}".encode("utf-8")).hexdigest()
        values.append((digest, index))
    return [index for _, index in sorted(values)]


def _slug_key(key: str) -> str:
    return key.replace(" ", "").replace("#", "s")


def main() -> int:
    from recipes import generate as G
    from teardown.render.execute import execute_recipe

    binp = Path(os.environ.get("MOSH_BIN", "").strip() or str(DEFAULT_BIN))
    if not binp.is_file():
        print(f"SKIP: no Mosh binary at {binp!s}")
        return 0

    current_library = Path(os.environ.get("MOSH_RECIPE_LIBRARY", "").strip() or G.LIB_DIR)
    baseline_library = Path(os.environ.get("MOSH_BASELINE_RECIPE_LIBRARY", "").strip() or BASELINE_LIBRARY)
    palette_manifest = os.environ.get("MOSH_PALETTE_MANIFEST", "").strip()
    palette = G.load_palette(palette_manifest) if palette_manifest else G.load_palette()
    if not palette:
        print("SKIP: no palette manifest (owner-private)")
        return 0

    out_dir = Path(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/mosh-beats/gate-c-blind"))
    out_dir.mkdir(parents=True, exist_ok=True)

    answer_key: list[dict[str, Any]] = []
    score_rows: list[dict[str, Any]] = []
    score_fields = [
        "group",
        "blind_label",
        "file",
        "prompt",
        "musically_distinct_1_5",
        "would_keep_1_5",
        "notes",
    ]
    readme_lines = [
        "# Gate C blind listening pack",
        "",
        "Listen by group. Do not open `answer_key.json` until after scoring.",
        "Each group contains the current r7 beat, a seed-library baseline, and an exact r7 source anchor in blind order.",
        "Some exact source anchors are sparse because the local MIDI corpus is ingredient-level.",
        "Suggested score per file: musically distinct, would keep, notes.",
        "",
    ]

    ok_count = 0
    total = 0
    for group_index, (request, seed) in enumerate(BEATS, start=1):
        current, current_prov = G.generate(request, library_dir=str(current_library), seed=seed, palette=palette)
        baseline, baseline_prov = G.generate(request, library_dir=str(baseline_library), seed=seed, palette=palette)
        exact = G.reconstruct(str(current_library), current_prov.backbone, palette=palette)

        variants = [
            ("retrieved_adapted_r7", current, _jsonable_provenance(current_prov)),
            ("seed_baseline", baseline, _jsonable_provenance(baseline_prov)),
            ("exact_r7_backbone", exact, {"backbone": current_prov.backbone, "sources": {"exact": current_prov.backbone}}),
        ]
        order = _blind_order(group_index, len(variants))
        prompt_label = f"{request['mood']} {int(request['tempo'])}bpm {request['key']}"
        readme_lines.append(f"## Group {group_index:02d} - {prompt_label}")

        for blind_index, variant_index in enumerate(order):
            label = chr(ord("A") + blind_index)
            kind, rec, prov = variants[variant_index]
            filename = (
                f"g{group_index:02d}_{label}_{request['mood']}_"
                f"{int(request['tempo'])}_{_slug_key(request['key'])}.wav"
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
            print(f"  {status} {filename} rms={res.audio_rms:.4f} variant={kind}")
            readme_lines.append(f"- `{filename}`")
            score_rows.append(
                {
                    "group": f"{group_index:02d}",
                    "blind_label": label,
                    "file": filename,
                    "prompt": prompt_label,
                    "musically_distinct_1_5": "",
                    "would_keep_1_5": "",
                    "notes": "",
                }
            )
            answer_key.append(
                {
                    "group": group_index,
                    "blind_label": label,
                    "file": filename,
                    "request": request,
                    "seed": seed,
                    "variant": kind,
                    "recipe_id": rec.recipe_id,
                    "provenance": prov,
                    "render": {
                        "nonsilent": res.nonsilent,
                        "audio_rms": round(float(res.audio_rms), 8),
                        "error": res.error,
                    },
                }
            )
        readme_lines.append("")

    (out_dir / "README.md").write_text("\n".join(readme_lines) + "\n", encoding="utf-8")
    (out_dir / "answer_key.json").write_text(json.dumps(answer_key, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with (out_dir / "scorecard.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=score_fields)
        writer.writeheader()
        writer.writerows(score_rows)
    print(f"\n{ok_count}/{total} rendered -> {out_dir}")
    return 0 if ok_count == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
