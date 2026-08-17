from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import uuid
from dataclasses import dataclass, field
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

# Task 2 — Skill Foundry `SourceCardV1` projection (spec §6.2, Global Constraints).
#
# These enums are DELIBERATELY separate from the legacy recipe-mining rubric's
# `rights_status`/`media_handling` free-text fields above: the Skill Source section
# uses the exact closed allowlists the Skill Foundry CLI (Slice D) requires, so a
# card can carry both an old-style recipe rubric AND a new-style skill-source
# projection without the two vocabularies colliding.
RIGHTS_VALUES = {
    "official_public_documentation",
    "creator_authorized",
    "user_owned_or_licensed",
    "manual_paraphrase_only",
}
ACQUISITION_VALUES = {
    "official_https_page",
    "creator_authorized_file",
    "user_supplied_local_file",
    "manual_viewing_notes",
}
PLATFORM_HANDLING_VALUES = {
    "metadata_and_short_paraphrases_only",
    "local_locator_only",
}
CLAIM_ORIGIN_VALUES = {
    "source_text",
    "owner_observation",
    "asr_ocr",
    "codex_inference",
}
SOURCE_STATE_VALUES = {"current", "stale", "superseded", "revoked"}

SKILL_SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HEX64_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_SKILL_SOURCE_CARD_BYTES = 1_048_576
MAX_CLAIMS = 10
MIN_CLAIMS = 1
MAX_SOURCE_CARD_ID_CHARS = 64


@dataclass(frozen=True)
class ScoreRow:
    dimension: str
    score: int
    notes: str


@dataclass(frozen=True)
class ClaimRow:
    claim_id: str
    origin: str
    workflow_moment: str
    paraphrase: str
    boundary: str


@dataclass(frozen=True)
class CandidateCard:
    path: Path | None
    fields: dict[str, str]
    scores: dict[str, ScoreRow]
    total_score: int | None
    raw_text: str
    claims: list[ClaimRow] = field(default_factory=list)

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
    claims: list[ClaimRow] = []
    total_score: int | None = None
    lines = text.splitlines()
    current_key: str | None = None
    current_value: list[str] = []
    current_table: str | None = None  # "score" | "claims" | None

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

    def parse_claim_row(line: str) -> None:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 5 or normalize_key(cells[0]) == "claim id":
            return
        if cells[0] == "" or re.fullmatch(r"-+", cells[0]):
            return
        claims.append(ClaimRow(claim_id=cells[0], origin=cells[1], workflow_moment=cells[2], paraphrase=cells[3], boundary=cells[4]))

    for line in lines:
        stripped = line.strip()
        # Table rows are consumed by prefix, NOT by a full-line `^\|.+\|$` match: GFM data
        # rows commonly omit the trailing "|" (see the fixtures), so only header/separator
        # rows are guaranteed to have one. `startswith("|")` while `current_table` is set (or
        # the row IS a recognized header, which also bootstraps `current_table`) is the actual
        # admission rule; this mirrors the pre-Task-2 score-table behavior exactly.
        if stripped.startswith("| Dimension"):
            current_table = "score"
            parse_score_row(stripped)
            continue
        if stripped.startswith("| Claim ID"):
            current_table = "claims"
            parse_claim_row(stripped)
            continue
        if stripped.startswith("|"):
            if current_table == "score":
                parse_score_row(stripped)
                continue
            if current_table == "claims":
                parse_claim_row(stripped)
                continue
            continue
        if stripped.startswith("## "):
            heading = normalize_key(stripped[3:])
            current_table = heading if heading in ("score", "claims") else None
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
    return CandidateCard(path=path, fields=fields, scores=scores, total_score=total_score, raw_text=text, claims=claims)


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


class SkillSourceProjectionError(ValueError):
    """Raised when a card cannot be projected into a bounded `SourceCardV1`."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def project_skill_source(card: CandidateCard) -> dict[str, object]:
    """Project one already-parsed `CandidateCard` into a bounded `SourceCardV1` dict.

    Rejects (raises `SkillSourceProjectionError`) rather than silently coercing: unknown or
    unresolved rights/acquisition/platform-handling/state values, an out-of-range or
    duplicate claim set, and any decoded string carrying an embedded media/transcript
    payload. `sourceSnapshotSha256` intentionally excludes reviewer/timestamps/dependencies/
    state so unchanged evidence can extend freshness on a later `refresh-source` without
    disturbing certified skills that pinned the earlier snapshot hash.
    """
    errors: list[str] = []

    source_card_id = card.fields.get("source_id", "").strip()
    if (
        not source_card_id
        or len(source_card_id) > MAX_SOURCE_CARD_ID_CHARS
        or not SKILL_SLUG_PATTERN.fullmatch(source_card_id)
    ):
        errors.append(f"invalid source card id: {source_card_id!r}")

    source_version = card.fields.get("source_version", "").strip()

    rights = card.fields.get("rights", "").strip()
    if rights not in RIGHTS_VALUES:
        errors.append(f"unresolved or unknown rights: {rights!r}")

    acquisition = card.fields.get("acquisition", "").strip()
    if acquisition not in ACQUISITION_VALUES:
        errors.append(f"unresolved or unofficial acquisition: {acquisition!r}")

    platform_handling = card.fields.get("platform_handling", "").strip()
    if platform_handling not in PLATFORM_HANDLING_VALUES:
        errors.append(f"unresolved platform handling: {platform_handling!r}")

    evidence_sha256 = card.fields.get("evidence_sha256", "").strip().lower()
    if evidence_sha256 and not HEX64_PATTERN.fullmatch(evidence_sha256):
        errors.append("evidence_sha256 must be 64 lowercase hex characters")

    reviewer = card.fields.get("reviewer", "").strip()
    reviewed_at = card.fields.get("reviewed_at", "").strip()

    state = card.fields.get("source_state", "").strip()
    if state not in SOURCE_STATE_VALUES:
        errors.append(f"unknown source_state: {state!r}")

    dependent_ids = split_lines(card.fields.get("dependent_ids", "").replace(",", "\n"))

    claims = card.claims
    if len(claims) < MIN_CLAIMS:
        errors.append("at least one claim is required")
    if len(claims) > MAX_CLAIMS:
        errors.append(f"claim ceiling exceeded: {len(claims)} claims (max {MAX_CLAIMS})")

    seen_claim_ids: set[str] = set()
    claim_payload: list[dict[str, str]] = []
    for claim in claims:
        if claim.claim_id in seen_claim_ids:
            errors.append(f"duplicate claim id: {claim.claim_id}")
        seen_claim_ids.add(claim.claim_id)
        if claim.origin not in CLAIM_ORIGIN_VALUES:
            errors.append(f"unknown claim origin for {claim.claim_id}: {claim.origin!r}")
        for field_name, value in (
            ("workflow_moment", claim.workflow_moment),
            ("paraphrase", claim.paraphrase),
            ("boundary", claim.boundary),
        ):
            if value and contains_media_or_transcript_payload(value, field_name=field_name):
                errors.append(f"unsafe payload in claim {claim.claim_id} field {field_name}")
        claim_payload.append(
            {
                "claimId": claim.claim_id,
                "origin": claim.origin,
                "workflowMoment": claim.workflow_moment,
                "paraphrase": claim.paraphrase,
                "boundary": claim.boundary,
            }
        )

    for field_name, value in (("reviewer", reviewer), ("source_version", source_version)):
        if value and contains_media_or_transcript_payload(value, field_name=field_name):
            errors.append(f"unsafe payload in {field_name}")
    for dependent_id in dependent_ids:
        if contains_media_or_transcript_payload(dependent_id, field_name="dependent_ids"):
            errors.append("unsafe payload in dependent_ids")
            break

    if errors:
        raise SkillSourceProjectionError(errors)

    # `sourceSnapshotSha256` covers stable identity/version/rights/acquisition/evidence/
    # ordered claims only — reviewer/timestamps/dependencies/state are excluded on purpose
    # (spec §5.3/§6.2). Canonical JSON (sorted keys, no whitespace) over the UTF-8 bytes.
    snapshot_payload = {
        "sourceCardId": source_card_id,
        "sourceVersion": source_version,
        "rights": rights,
        "acquisition": acquisition,
        "platformHandling": platform_handling,
        "evidenceSha256": evidence_sha256,
        "claims": claim_payload,
    }
    snapshot_bytes = json.dumps(snapshot_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    source_snapshot_sha256 = hashlib.sha256(snapshot_bytes).hexdigest()

    return {
        "schemaVersion": 1,
        "sourceCardId": source_card_id,
        "sourceVersion": source_version,
        "rights": rights,
        "acquisition": acquisition,
        "platformHandling": platform_handling,
        "evidenceSha256": evidence_sha256,
        "reviewer": reviewer,
        "reviewedAt": reviewed_at,
        "state": state,
        "dependentIds": dependent_ids,
        "claims": claim_payload,
        "sourceSnapshotSha256": source_snapshot_sha256,
    }


def read_source_card_text(path: Path) -> str:
    """lstat + bounded-read + strict-UTF-8-decode one EXPLICIT source card file.

    Rejects symlinks and non-regular files (FIFOs, devices, ...) before reading any bytes,
    and rejects a file larger than `MAX_SKILL_SOURCE_CARD_BYTES` from its `lstat` size alone
    — no partial read of an oversized file is attempted.
    """
    st = path.lstat()
    if stat.S_ISLNK(st.st_mode):
        raise SkillSourceProjectionError([f"source card must not be a symlink: {path}"])
    if not stat.S_ISREG(st.st_mode):
        raise SkillSourceProjectionError([f"source card must be a regular file: {path}"])
    if st.st_size > MAX_SKILL_SOURCE_CARD_BYTES:
        raise SkillSourceProjectionError(
            [f"source card exceeds {MAX_SKILL_SOURCE_CARD_BYTES} bytes: {path} ({st.st_size} bytes)"]
        )
    raw = path.read_bytes()
    if len(raw) > MAX_SKILL_SOURCE_CARD_BYTES:
        raise SkillSourceProjectionError(
            [f"source card exceeds {MAX_SKILL_SOURCE_CARD_BYTES} bytes: {path} ({len(raw)} bytes)"]
        )
    try:
        return raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise SkillSourceProjectionError([f"source card is not valid UTF-8: {exc}"]) from exc


def project_skill_source_from_path(path: Path) -> dict[str, object]:
    text = read_source_card_text(path)
    card = parse_candidate_card(text, path=path)
    return project_skill_source(card)


def write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    """0600 unique sibling temp -> file fsync -> `os.replace` -> parent fsync."""
    path = path.resolve()
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    tmp_path = path.parent / f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}"
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    dir_fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


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

    project = sub.add_parser(
        "project-skill-source", help="project a bounded SourceCardV1 JSON from one explicit card file"
    )
    project.add_argument("card", help="explicit markdown source card file (no globs, no directories)")
    project.add_argument("--out", help="atomically write the JSON here instead of stdout")

    args = parser.parse_args(argv)

    if args.command == "project-skill-source":
        try:
            projected = project_skill_source_from_path(Path(args.card))
        except SkillSourceProjectionError as exc:
            print(f"FAIL {args.card}")
            for error in exc.errors:
                print(f"  - {error}")
            return 1
        if args.out:
            write_json_atomic(Path(args.out), projected)
        else:
            print(json.dumps(projected, indent=2, sort_keys=True))
        return 0

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
