from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

REQUIRED_FIELDS = [
    "source_id",
    "source_type",
    "title",
    "creator_or_owner",
    "url_or_local_locator",
    "accessed_at",
    "rights_status",
    "media_handling",
    "musical_roles_observed",
    "recipe_extractability",
    "owner_audition_gate",
    "decision",
]

SCORE_DIMENSIONS = [
    "rights and handling",
    "musical specificity",
    "recipe extractability",
    "recombination value",
    "production relevance",
    "evidence quality",
    "owner gate readiness",
]

MEDIA_PATTERNS = [
    re.compile(r"!\[[^\]]*\]\([^)]+\)", re.IGNORECASE),
    re.compile(r"<\s*(audio|video|iframe|img)\b", re.IGNORECASE),
    re.compile(r"\bhttps?://\S+\.(?:wav|mp3|m4a|flac|aac|ogg|mp4|mov|mkv|webm)\b", re.IGNORECASE),
]

TIMESTAMP_PATTERN = re.compile(r"\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b")
TRANSCRIPT_HINTS = re.compile(r"\b(transcript|verbatim|caption(?:s)?|subtitles?)\b", re.IGNORECASE)

FIELD_LINE_PATTERN = re.compile(r"^-\s*`([^`]+)`:\s*(.*)$")
TABLE_SPLIT_PATTERN = re.compile(r"^\|.+\|$")


@dataclass(frozen=True)
class ScoreRow:
    dimension: str
    score: int
    notes: str


@dataclass(frozen=True)
class CandidateCard:
    path: Path | None
    fields: dict[str, str]
    scores: dict[str, ScoreRow]
    total_score: int | None
    raw_text: str

    def safe_summary(self) -> dict[str, object]:
        blockers = split_lines(self.fields.get("vetoes_or_blockers", ""))
        local_evidence_path = self.fields.get("local_evidence_path", "").strip()
        evidence_note = ""
        if local_evidence_path:
            evidence_note = "outside-repo" if not path_is_inside_repo(local_evidence_path) else "inside-repo"
        summary: dict[str, object] = {
            "source_id": self.fields.get("source_id", ""),
            "title": self.fields.get("title", ""),
            "creator_or_owner": self.fields.get("creator_or_owner", ""),
            "source_type": self.fields.get("source_type", ""),
            "rights_status": self.fields.get("rights_status", ""),
            "media_handling": self.fields.get("media_handling", ""),
            "recipe_extractability": self.fields.get("recipe_extractability", ""),
            "owner_audition_gate": self.fields.get("owner_audition_gate", ""),
            "decision": self.fields.get("decision", ""),
            "total_score": self.total_score,
            "score": {dimension: row.score for dimension, row in self.scores.items()},
            "blockers": blockers,
        }
        if evidence_note:
            summary["local_evidence"] = evidence_note
        return summary

    def safe_index_line(self) -> str:
        summary = self.safe_summary()
        blockers = summary["blockers"]
        blockers_text = "; ".join(blockers) if blockers else "-"
        score_text = summary["total_score"] if summary["total_score"] is not None else "?"
        return (
            f"{summary['source_id']} | {summary['title']} | "
            f"{summary['rights_status']}/{summary['media_handling']} | "
            f"decision={summary['decision']} | score={score_text} | blockers={blockers_text}"
        )


def split_lines(value: str) -> list[str]:
    return [line.strip() for line in value.splitlines() if line.strip()]


def normalize_key(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def path_is_inside_repo(path_text: str) -> bool:
    repo_root = Path.cwd().resolve()
    candidate = Path(path_text).expanduser()
    try:
        return candidate.resolve().is_relative_to(repo_root)
    except Exception:
        return False


def parse_candidate_card(text: str, path: Path | None = None) -> CandidateCard:
    fields: dict[str, str] = {}
    scores: dict[str, ScoreRow] = {}
    total_score: int | None = None
    lines = text.splitlines()
    current_key: str | None = None
    current_value: list[str] = []
    in_score_table = False

    def flush_field() -> None:
        nonlocal current_key, current_value
        if current_key is not None:
            fields[current_key] = "\n".join(part.rstrip() for part in current_value).strip()
        current_key = None
        current_value = []

    def parse_score_row(line: str) -> None:
        nonlocal total_score
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 3 or normalize_key(cells[0]) == "dimension":
            return
        if cells[0] == "" or re.fullmatch(r"-+", cells[0]):
            return
        if cells[0] == "Total":
            try:
                total_score = int(cells[1])
            except ValueError:
                total_score = None
            return
        try:
            score = int(cells[1])
        except ValueError:
            score = -1
        scores[normalize_key(cells[0])] = ScoreRow(cells[0], score, cells[2])

    for line in lines:
        stripped = line.strip()
        if TABLE_SPLIT_PATTERN.match(stripped):
            in_score_table = in_score_table or stripped.startswith("| Dimension")
            if in_score_table:
                parse_score_row(stripped)
            continue
        if stripped.startswith("## "):
            if normalize_key(stripped[3:]) != "score":
                in_score_table = False
            continue
        if in_score_table and stripped.startswith("|"):
            parse_score_row(stripped)
            continue
        match = FIELD_LINE_PATTERN.match(line)
        if match:
            flush_field()
            current_key = match.group(1)
            current_value = [match.group(2)]
            continue
        if current_key is not None and (line.startswith("  ") or line.startswith("\t") or stripped == "" or stripped.startswith("- ")):
            current_value.append(line)
            continue
        flush_field()

    flush_field()
    if total_score is None:
        raw_total = fields.get("total_score", "").strip()
        if raw_total:
            try:
                total_score = int(raw_total)
            except ValueError:
                total_score = None
    return CandidateCard(path=path, fields=fields, scores=scores, total_score=total_score, raw_text=text)


def validate_candidate_card(card: CandidateCard, repo_root: Path | None = None) -> list[str]:
    repo_root = repo_root or Path.cwd().resolve()
    errors: list[str] = []

    for field in REQUIRED_FIELDS:
        if not card.fields.get(field, "").strip():
            errors.append(f"missing required field: {field}")

    for field_name in ("local_evidence_path", "source_hashes", "timecoded_moments", "vetoes_or_blockers"):
        value = card.fields.get(field_name, "")
        if value and contains_media_or_transcript_payload(value, field_name=field_name):
            errors.append(f"unsafe payload in {field_name}")

    url = card.fields.get("url_or_local_locator", "").strip()
    if looks_like_media_locator(url):
        errors.append("url_or_local_locator points at media instead of a source page or locator")

    local_evidence_path = card.fields.get("local_evidence_path", "").strip()
    if local_evidence_path:
        resolved = Path(local_evidence_path).expanduser()
        if not resolved.is_absolute():
            resolved = (repo_root / resolved).resolve()
        else:
            resolved = resolved.resolve()
        if resolved.is_relative_to(repo_root):
            errors.append("local_evidence_path must stay outside the repo")

    if len(card.scores) != len(SCORE_DIMENSIONS):
        missing = [dimension for dimension in SCORE_DIMENSIONS if dimension not in card.scores]
        extra = [dimension for dimension in card.scores if dimension not in SCORE_DIMENSIONS]
        if missing:
            errors.append("missing score rows: " + ", ".join(missing))
        if extra:
            errors.append("unexpected score rows: " + ", ".join(sorted(extra)))

    score_total = 0
    for dimension in SCORE_DIMENSIONS:
        row = card.scores.get(dimension)
        if row is None:
            continue
        if row.score < 0 or row.score > 3:
            errors.append(f"invalid score for {row.dimension}: {row.score}")
        score_total += max(row.score, 0)

    if card.total_score is None:
        errors.append("missing total_score")
    elif card.total_score != score_total:
        errors.append(f"total_score mismatch: expected {score_total}, got {card.total_score}")

    return errors


def contains_media_or_transcript_payload(value: str, field_name: str = "") -> bool:
    if any(pattern.search(value) for pattern in MEDIA_PATTERNS):
        return True
    if "```" in value or "<blockquote" in value.lower():
        return True
    words = value.split()
    timestamp_count = len(TIMESTAMP_PATTERN.findall(value))
    if field_name == "timecoded_moments":
        if timestamp_count >= 4 and len(words) >= 20:
            return True
    else:
        if len(words) >= 120:
            return True
        if timestamp_count >= 4 and len(words) >= 40:
            return True
    if TRANSCRIPT_HINTS.search(value) and len(words) >= 60:
        return True
    return False


def looks_like_media_locator(value: str) -> bool:
    if not value:
        return False
    return bool(re.search(r"\.(?:wav|mp3|m4a|flac|aac|ogg|mp4|mov|mkv|webm|png|jpg|jpeg|gif)$", value, re.IGNORECASE))


def iter_candidate_paths(paths: Iterable[str]) -> list[Path]:
    candidates: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            candidates.extend(sorted(p for p in path.rglob("*.md") if p.is_file()))
        else:
            candidates.append(path)
    return candidates


def load_candidate_card(path: Path) -> CandidateCard:
    return parse_candidate_card(path.read_text(encoding="utf-8"), path=path)


def emit_json(cards: list[CandidateCard]) -> None:
    payload = [card.safe_summary() for card in cards]
    print(json.dumps(payload, indent=2, sort_keys=True))


def emit_text(cards: list[CandidateCard]) -> None:
    for card in cards:
        print(card.safe_index_line())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate and index recipe-source candidate cards")
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate", help="validate one or more candidate cards")
    validate.add_argument("paths", nargs="+", help="markdown card files or directories")

    index = sub.add_parser("index", help="emit a safe index/summary for one or more cards")
    index.add_argument("paths", nargs="+", help="markdown card files or directories")
    index.add_argument("--json", action="store_true", help="emit JSON instead of text")

    args = parser.parse_args(argv)
    cards = [load_candidate_card(path) for path in iter_candidate_paths(args.paths)]

    if args.command == "validate":
        failures: list[str] = []
        for card in cards:
            errors = validate_candidate_card(card)
            label = card.path.name if card.path is not None else "<memory>"
            if errors:
                failures.append(label)
                print(f"FAIL {label}")
                for error in errors:
                    print(f"  - {error}")
            else:
                print(f"PASS {label}")
        if failures:
            print(f"\nFAILED: {len(failures)} card(s)")
            return 1
        print(f"\nOK: {len(cards)} card(s)")
        return 0

    if args.json:
        emit_json(cards)
    else:
        emit_text(cards)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
