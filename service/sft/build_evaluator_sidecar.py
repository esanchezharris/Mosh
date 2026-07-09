#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FEATURE_ALIASES = {
    "ranker_score": ("ranker_score", "predictedKeep", "predicted_keep"),
    "audiobox_pq": ("audiobox_pq", "PQ", "pq"),
    "audiobox_ce": ("audiobox_ce", "CE", "ce"),
    "audiobox_cu": ("audiobox_cu", "CU", "cu"),
    "audiobox_pc": ("audiobox_pc", "PC", "pc"),
    "clap_pos": ("clap_pos", "clapPos"),
    "clap_contrast": ("clap_contrast", "clapContrast"),
    "clap_kept_centroid": ("clap_kept_centroid", "clapKeptCentroid"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def jsonl_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line:
                row = json.loads(line)
                if isinstance(row, dict):
                    rows.append(row)
    return rows


def nested_values(row: dict[str, Any]) -> list[dict[str, Any]]:
    values = [row]
    for key in ("features", "scores", "evaluators", "metrics"):
        value = row.get(key)
        if isinstance(value, dict):
            values.append(value)
    return values


def read_feature(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    for source in nested_values(row):
        for name in names:
            if name in source and source[name] is not None:
                return source[name]
    return None


def extract_features(row: dict[str, Any]) -> dict[str, Any]:
    features: dict[str, Any] = {}
    for output_name, aliases in FEATURE_ALIASES.items():
        value = read_feature(row, aliases)
        if value is not None:
            features[output_name] = value
    return features


def row_audio_path(row: dict[str, Any]) -> str | None:
    for key in ("audio_path", "path", "file", "wav", "filename"):
        value = row.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def row_source_run(row: dict[str, Any], fallback: str) -> str:
    for key in ("source_run", "run", "round", "pack"):
        value = row.get(key)
        if isinstance(value, str) and value:
            return value
    return fallback


def sidecar_id(row: dict[str, Any], index: int, audio_path: str | None) -> str:
    for key in ("id", "beat_id", "clip_id", "sample_id"):
        value = row.get(key)
        if isinstance(value, str) and value:
            return value
    if audio_path:
        kind = row.get("kind")
        suffix = f":{kind}" if isinstance(kind, str) and kind else ""
        return f"{audio_path}{suffix}:{index}"
    return f"sidecar-row-{index}"


def evaluator_versions(features: dict[str, Any]) -> dict[str, Any]:
    return {
        "ranker": {"available": "ranker_score" in features},
        "audiobox": {
            "available": any(key.startswith("audiobox_") for key in features)
        },
        "clap": {"available": any(key.startswith("clap_") for key in features)},
        "gemini_audio_judge": {"enabled": False},
    }


def build_sidecar(
    sources: list[Path],
    out_path: Path,
    source_run: str,
    computed_at: str,
) -> dict[str, Any]:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped = 0
    source_reports = []
    with out_path.open("w", encoding="utf-8") as out:
        for source in sources:
            if not source.exists():
                source_reports.append(
                    {"path": str(source), "exists": False, "rows_read": 0}
                )
                continue
            rows = jsonl_rows(source)
            source_reports.append(
                {"path": str(source), "exists": True, "rows_read": len(rows)}
            )
            for row in rows:
                audio_path = row_audio_path(row)
                features = extract_features(row)
                if not audio_path and not features:
                    skipped += 1
                    continue
                written += 1
                sidecar_row = {
                    "id": sidecar_id(row, written, audio_path),
                    "audio_path": audio_path,
                    "source_run": row_source_run(row, source_run),
                    "features": features,
                    "evaluator_versions": evaluator_versions(features),
                    "computed_at": computed_at,
                }
                out.write(json.dumps(sidecar_row, separators=(",", ":")) + "\n")
    manifest = {
        "created_at": computed_at,
        "sidecar": str(out_path),
        "sources": source_reports,
        "rows_written": written,
        "rows_skipped": skipped,
        "feature_policy": {
            "included": list(FEATURE_ALIASES.keys()),
            "gemini_enabled": False,
            "external_model_calls": False,
        },
    }
    out_path.with_suffix(out_path.suffix + ".manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def default_sources() -> list[str]:
    labels = Path("~/mosh-beats/labels/labels.jsonl").expanduser()
    return [str(labels)] if labels.exists() else []


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build a local evaluator metadata sidecar without model calls."
    )
    ap.add_argument("--out", required=True)
    ap.add_argument("--source", action="append", default=None)
    ap.add_argument("--source-run", default="r5-prep")
    args = ap.parse_args()

    sources = [Path(p).expanduser().resolve() for p in (args.source or default_sources())]
    manifest = build_sidecar(
        sources,
        Path(args.out).expanduser().resolve(),
        args.source_run,
        now_iso(),
    )
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
