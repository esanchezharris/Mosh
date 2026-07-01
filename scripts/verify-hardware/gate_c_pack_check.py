#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import wave
from collections import defaultdict
from pathlib import Path
from typing import Any


DEFAULT_PACK = Path("~/mosh-beats/r7-gate-c-blind").expanduser()
REQUIRED_COLUMNS = (
    "group",
    "blind_label",
    "file",
    "prompt",
    "musically_distinct_1_5",
    "would_keep_1_5",
    "notes",
)
SCORE_COLUMNS = ("musically_distinct_1_5", "would_keep_1_5")


def _display_path(path: Path) -> str:
    home = Path.home()
    try:
        return "~/" + str(path.resolve().relative_to(home))
    except ValueError:
        return str(path)


def _read_scorecard(path: Path) -> tuple[list[dict[str, str]], list[str]]:
    if not path.is_file():
        return [], [f"missing scorecard: {_display_path(path)}"]
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = [name for name in REQUIRED_COLUMNS if name not in (reader.fieldnames or [])]
        if missing:
            return [], [f"scorecard missing columns: {', '.join(missing)}"]
        return [dict(row) for row in reader], []


def _score_value(raw: str) -> float | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if not math.isfinite(value) or value < 1 or value > 5:
        return None
    return value


def _wav_status(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"file": path.name, "ok": False, "error": "missing"}
    try:
        with wave.open(str(path), "rb") as wav:
            frames = wav.getnframes()
            channels = wav.getnchannels()
            sample_rate = wav.getframerate()
    except wave.Error as exc:
        return {"file": path.name, "ok": False, "error": f"invalid-wav: {exc}"}
    return {
        "file": path.name,
        "ok": frames > 0 and channels > 0 and sample_rate > 0,
        "frames": frames,
        "channels": channels,
        "sampleRate": sample_rate,
    }


def _expected_labels(variants_per_group: int) -> set[str]:
    return {chr(ord("A") + index) for index in range(variants_per_group)}


def _scorecard_status(rows: list[dict[str, str]], *, expect_groups: int, variants_per_group: int) -> dict[str, Any]:
    expected_rows = expect_groups * variants_per_group
    expected_labels = _expected_labels(variants_per_group)
    rows_by_group: dict[str, list[dict[str, str]]] = defaultdict(list)
    invalid_scores: list[dict[str, str]] = []
    incomplete_rows: list[dict[str, str]] = []

    for row in rows:
        group = str(row.get("group", "")).zfill(2)
        rows_by_group[group].append(row)
        row_missing = False
        for column in SCORE_COLUMNS:
            if _score_value(row.get(column, "")) is None:
                row_missing = True
                if str(row.get(column, "")).strip():
                    invalid_scores.append(
                        {
                            "group": group,
                            "blind_label": str(row.get("blind_label", "")),
                            "file": str(row.get("file", "")),
                            "column": column,
                            "value": str(row.get(column, "")),
                        }
                    )
        if row_missing:
            incomplete_rows.append(
                {
                    "group": group,
                    "blind_label": str(row.get("blind_label", "")),
                    "file": str(row.get("file", "")),
                }
            )

    group_errors: list[str] = []
    for index in range(1, expect_groups + 1):
        group = f"{index:02d}"
        group_rows = rows_by_group.get(group, [])
        labels = {str(row.get("blind_label", "")) for row in group_rows}
        if len(group_rows) != variants_per_group:
            group_errors.append(f"group {group} has {len(group_rows)} rows, expected {variants_per_group}")
        if labels != expected_labels:
            group_errors.append(f"group {group} labels {sorted(labels)}, expected {sorted(expected_labels)}")

    unexpected_groups = sorted(group for group in rows_by_group if not (group.isdigit() and 1 <= int(group) <= expect_groups))
    if unexpected_groups:
        group_errors.append(f"unexpected groups: {', '.join(unexpected_groups)}")

    return {
        "rows": len(rows),
        "expectedRows": expected_rows,
        "complete": len(rows) == expected_rows and not incomplete_rows and not invalid_scores and not group_errors,
        "filledRows": len(rows) - len(incomplete_rows),
        "incompleteRows": incomplete_rows,
        "invalidScores": invalid_scores,
        "groupErrors": group_errors,
    }


def _safe_reveal(rows: list[dict[str, str]], answer_key_path: Path) -> tuple[dict[str, Any] | None, list[str]]:
    if not answer_key_path.is_file():
        return None, [f"missing answer key: {_display_path(answer_key_path)}"]
    answer_key = json.loads(answer_key_path.read_text(encoding="utf-8"))
    scores_by_key = {
        (str(row.get("group", "")).zfill(2), str(row.get("blind_label", ""))): row
        for row in rows
    }
    variant_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    errors: list[str] = []
    for item in answer_key:
        group = str(item.get("group", "")).zfill(2)
        label = str(item.get("blind_label", ""))
        variant = str(item.get("variant", "unknown"))
        row = scores_by_key.get((group, label))
        if row is None:
            errors.append(f"answer key row has no scorecard match: group {group} label {label}")
            continue
        variant_rows[variant].append(
            {
                "group": group,
                "blind_label": label,
                "file": str(row.get("file", "")),
                "musicallyDistinct": float(_score_value(row.get("musically_distinct_1_5", "")) or 0),
                "wouldKeep": float(_score_value(row.get("would_keep_1_5", "")) or 0),
            }
        )

    summary: dict[str, Any] = {}
    for variant, scored in sorted(variant_rows.items()):
        count = len(scored)
        summary[variant] = {
            "count": count,
            "avgMusicallyDistinct": round(sum(row["musicallyDistinct"] for row in scored) / count, 3) if count else 0,
            "avgWouldKeep": round(sum(row["wouldKeep"] for row in scored) / count, 3) if count else 0,
        }
    return {"variantSummary": summary}, errors


def build_status(
    pack: Path,
    *,
    expect_groups: int = 6,
    variants_per_group: int = 3,
    reveal: bool = False,
) -> dict[str, Any]:
    pack = pack.expanduser()
    scorecard_path = pack / "scorecard.csv"
    answer_key_path = pack / "answer_key.json"
    rows, scorecard_errors = _read_scorecard(scorecard_path)
    scorecard = _scorecard_status(rows, expect_groups=expect_groups, variants_per_group=variants_per_group) if rows else {
        "rows": 0,
        "expectedRows": expect_groups * variants_per_group,
        "complete": False,
        "filledRows": 0,
        "incompleteRows": [],
        "invalidScores": [],
        "groupErrors": [],
    }
    wavs = [_wav_status(pack / str(row.get("file", ""))) for row in rows]
    missing_readme = not (pack / "README.md").is_file()
    answer_key_present = answer_key_path.is_file()
    structural_errors = list(scorecard_errors)
    if missing_readme:
        structural_errors.append(f"missing README: {_display_path(pack / 'README.md')}")
    if not answer_key_present:
        structural_errors.append(f"missing answer key: {_display_path(answer_key_path)}")
    structural_errors.extend(str(item.get("error")) for item in wavs if not item.get("ok"))

    answer_key_read = False
    reveal_status: dict[str, Any] | None = None
    reveal_errors: list[str] = []
    if reveal:
        if scorecard.get("complete"):
            answer_key_read = True
            reveal_status, reveal_errors = _safe_reveal(rows, answer_key_path)
        else:
            reveal_errors.append("scorecard incomplete; answer_key.json was not read")

    ok = not structural_errors and bool(scorecard.get("complete")) and (not reveal or not reveal_errors)
    owner_action = None
    if not scorecard.get("complete"):
        owner_action = (
            "Score every blind row in scorecard.csv before opening answer_key.json: "
            "fill musically_distinct_1_5 and would_keep_1_5 with 1-5 values."
        )

    status: dict[str, Any] = {
        "schemaVersion": 1,
        "pack": _display_path(pack),
        "blindPreserved": not answer_key_read,
        "answerKeyRead": answer_key_read,
        "answerKeyPresent": answer_key_present,
        "readmePresent": not missing_readme,
        "expectedGroups": expect_groups,
        "variantsPerGroup": variants_per_group,
        "wavFiles": {
            "checked": len(wavs),
            "ok": sum(1 for item in wavs if item.get("ok")),
            "bad": [item for item in wavs if not item.get("ok")],
        },
        "scorecard": scorecard,
        "structuralErrors": structural_errors,
        "ownerActionRequired": owner_action is not None,
        "ownerAction": owner_action,
        "ok": ok,
    }
    if reveal or reveal_errors:
        status["reveal"] = reveal_status or {}
        status["revealErrors"] = reveal_errors
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a Gate C blind pack without revealing labels before scoring")
    parser.add_argument("--pack", default=str(DEFAULT_PACK), help="Gate C blind pack directory")
    parser.add_argument("--expect-groups", type=int, default=6)
    parser.add_argument("--variants-per-group", type=int, default=3)
    parser.add_argument("--reveal", action="store_true", help="read answer_key.json and summarize labels after scorecard completion")
    parser.add_argument("--allow-incomplete", action="store_true", help="exit 0 when only owner scoring is incomplete")
    parser.add_argument("--out", default="", help="optional JSON output path")
    args = parser.parse_args(argv)

    status = build_status(
        Path(args.pack),
        expect_groups=args.expect_groups,
        variants_per_group=args.variants_per_group,
        reveal=args.reveal,
    )
    payload = json.dumps(status, indent=2, sort_keys=True) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)

    if status["ok"]:
        return 0
    scorecard = status["scorecard"]
    if (
        args.allow_incomplete
        and status["ownerActionRequired"]
        and not status["structuralErrors"]
        and not scorecard["invalidScores"]
        and not scorecard["groupErrors"]
    ):
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
