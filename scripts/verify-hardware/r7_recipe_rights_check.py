#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "service"
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

from training.rights import eligible_for_training, normalize_source, validate_source  # noqa: E402

DEFAULT_LIBRARY = REPO / "service" / "recipes" / "library"
DEFAULT_OUT = REPO / ".cache" / "mosh-teardown" / "midi-ingredients" / "2026-07-01-r7-curated" / "rights-eligibility.json"

FORBIDDEN_MARKERS = (
    "/Users/",
    str(Path.home()),
    ".mid",
    ".midi",
    ".wav",
    "palette",
    "manifest",
    "answer_key",
)


def _load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _recipe_files(library: Path) -> list[Path]:
    return sorted(path for path in library.glob("*.json") if path.is_file())


def _safe_recipe_text(path: Path) -> tuple[bool, list[str]]:
    text = path.read_text(encoding="utf-8")
    hits = [marker for marker in FORBIDDEN_MARKERS if marker and marker in text]
    return not hits, hits


def _rights_source(recipe: dict[str, Any]) -> dict[str, Any]:
    source = recipe.get("source") if isinstance(recipe.get("source"), dict) else {}
    source_id = str(source.get("video_id") or recipe.get("recipe_id") or "").strip()
    title = str(source.get("title") or source_id).strip()
    license_name = str(source.get("license") or "").strip()
    content_hash = str(source.get("content_hash") or "").strip()
    return normalize_source(
        {
            "source_id": source_id,
            "title": title,
            "creator": str(source.get("platform") or "unknown"),
            "source_url": "",
            "local_path": "",
            "user_claimed_license": license_name,
            "proof_of_rights": "",
            "approved_for_training": False,
            "notes": f"research recipe JSON only; content_hash={content_hash}" if content_hash else "research recipe JSON only",
        }
    )


def build_report(library: Path) -> dict[str, Any]:
    files = _recipe_files(library)
    items: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    training_eligible = 0
    path_safe = True
    proof_missing = 0
    public_ready = 0

    for path in files:
        recipe = _load_json(path)
        source = recipe.get("source") if isinstance(recipe.get("source"), dict) else {}
        platform = str(source.get("platform") or "unknown")
        license_name = str(source.get("license") or "").strip() or "missing"
        counts[platform] = counts.get(platform, 0) + 1
        safe_text, marker_hits = _safe_recipe_text(path)
        path_safe = path_safe and safe_text

        rights_source = _rights_source(recipe)
        validation_errors = validate_source(rights_source)
        eligible, reason = eligible_for_training(rights_source)
        if eligible:
            training_eligible += 1
        if "missing proof_of_rights" in validation_errors:
            proof_missing += 1
        if eligible and license_name not in {"unknown", "missing", "unlicensed"}:
            public_ready += 1

        items.append(
            {
                "file": path.name,
                "recipe_id": str(recipe.get("recipe_id") or ""),
                "platform": platform,
                "license": license_name,
                "has_content_hash": bool(str(source.get("content_hash") or "").strip()),
                "path_safe": safe_text,
                "forbidden_marker_hits": marker_hits,
                "training_eligible": eligible,
                "training_blocker": reason or "",
                "validation_errors": validation_errors,
                "policy": "tracked-research-only",
            }
        )

    local_midi = counts.get("local-midi", 0)
    seeds = counts.get("seed", 0)
    ok = (
        len(files) >= 53
        and local_midi >= 48
        and seeds >= 5
        and path_safe
        and training_eligible == 0
        and public_ready == 0
    )
    return {
        "ok": ok,
        "library": str(library.resolve().relative_to(REPO)) if library.resolve().is_relative_to(REPO) else "outside-repo",
        "recipe_count": len(files),
        "platform_counts": dict(sorted(counts.items())),
        "local_midi_recipe_count": local_midi,
        "seed_recipe_count": seeds,
        "tracked_files_path_safe": path_safe,
        "training_eligible_count": training_eligible,
        "public_distribution_ready_count": public_ready,
        "missing_proof_of_rights_count": proof_missing,
        "policy": {
            "research": "allowed for internal research recipe-library promotion",
            "training": "blocked until separate rights proof and approval",
            "public_distribution": "blocked until separate rights and packaging decision",
        },
        "items": items,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check r7/default recipe-library rights posture")
    parser.add_argument("--library", default=str(DEFAULT_LIBRARY))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    report = build_report(Path(args.library))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "items"}, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
