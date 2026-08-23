#!/usr/bin/env python3
"""Fail-closed validator for Mosh's owner-local Ableton Live 11 parity ledger."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from rules import (
    FORBIDDEN_DOC_CLAIMS,
    REQUIRED_SURFACES,
    nonempty_string,
    sha256,
    validate_reference,
    validate_surface,
)


def read_json(path: Path, errors: list[str], label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"{label}: missing file {path}")
        return {}
    except json.JSONDecodeError as exc:
        errors.append(f"{label}: invalid JSON at {exc.lineno}:{exc.colno}")
        return {}
    if not isinstance(value, dict):
        errors.append(f"{label}: root must be an object")
        return {}
    return value


def git_commit_exists(root: Path, revision: str) -> bool:
    return subprocess.run(
        ["git", "cat-file", "-e", f"{revision}^{{commit}}"],
        cwd=root,
        capture_output=True,
        text=True,
    ).returncode == 0


def git_commit_is_ancestor(root: Path, revision: str) -> bool:
    return subprocess.run(
        ["git", "merge-base", "--is-ancestor", revision, "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
    ).returncode == 0


def validate(
    root: Path,
    ledger_path: Path,
    manifest_path: Path,
    expected_source_sha: str | None = None,
) -> list[str]:
    errors: list[str] = []
    ledger = read_json(ledger_path, errors, "ledger")
    manifest = read_json(manifest_path, errors, "reference manifest")
    if not ledger or not manifest:
        return errors

    references = manifest.get("references")
    if not isinstance(references, list) or not references:
        errors.append("reference manifest: references must be non-empty")
        references = []
    reference_ids = {
        reference_id
        for index, reference in enumerate(references)
        if (reference_id := validate_reference(root, reference, index, errors))
    }
    if len(reference_ids) != len(references):
        errors.append("reference manifest: reference ids must be unique and valid")

    required_captures = manifest.get("requiredCaptures")
    if not isinstance(required_captures, list):
        errors.append("reference manifest: requiredCaptures must be an array")
        required_captures = []
    capture_surface_ids: list[str] = []
    for index, capture in enumerate(required_captures):
        prefix = f"requiredCaptures[{index}]"
        if not isinstance(capture, dict) or capture.get("surfaceId") not in REQUIRED_SURFACES:
            errors.append(f"{prefix}: invalid surfaceId")
            continue
        surface_id = str(capture["surfaceId"])
        capture_surface_ids.append(surface_id)
        status = capture.get("status")
        if status == "captured":
            refs = capture.get("referenceIds")
            if not isinstance(refs, list) or not refs or any(ref not in reference_ids for ref in refs):
                errors.append(f"{prefix}: captured row requires known referenceIds")
        elif status == "missing":
            if not nonempty_string(capture.get("reason")):
                errors.append(f"{prefix}: missing row requires reason")
        else:
            errors.append(f"{prefix}: status must be captured or missing")
    if set(capture_surface_ids) != REQUIRED_SURFACES or len(capture_surface_ids) != len(REQUIRED_SURFACES):
        errors.append("reference manifest: requiredCaptures must contain each surface exactly once")

    tested_source_sha = ledger.get("testedSourceSha")
    if not isinstance(tested_source_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", tested_source_sha):
        errors.append("ledger: testedSourceSha must be an exact 40-character git SHA")
    elif not git_commit_exists(root, tested_source_sha):
        errors.append(f"ledger: testedSourceSha is not an existing commit: {tested_source_sha}")
    elif not git_commit_is_ancestor(root, tested_source_sha):
        errors.append(f"ledger: testedSourceSha is not an ancestor of HEAD: {tested_source_sha}")
    if expected_source_sha is not None and tested_source_sha != expected_source_sha:
        errors.append(
            "ledger: testedSourceSha does not match the expected handoff revision "
            f"{expected_source_sha}"
        )
    if not nonempty_string(ledger.get("revision")):
        errors.append("ledger: missing revision")

    surfaces = ledger.get("surfaces")
    if not isinstance(surfaces, list):
        errors.append("ledger: surfaces must be an array")
        surfaces = []
    surface_ids = [
        surface_id
        for index, surface in enumerate(surfaces)
        if (surface_id := validate_surface(root, surface, index, tested_source_sha, reference_ids, errors))
    ]
    if set(surface_ids) != REQUIRED_SURFACES or len(surface_ids) != len(REQUIRED_SURFACES):
        errors.append("ledger: surfaces must contain each of the eight required ids exactly once")

    repairs = ledger.get("repairs")
    if not isinstance(repairs, list):
        errors.append("ledger: repairs must be an array")
        repairs = []
    policy = ledger.get("policy")
    max_active = policy.get("maxActiveRepairs") if isinstance(policy, dict) else None
    if max_active != 3:
        errors.append("ledger: policy.maxActiveRepairs must equal 3")
    active_count = sum(
        1 for repair in repairs if isinstance(repair, dict) and repair.get("state") == "active"
    )
    if active_count > 3:
        errors.append(f"ledger: active repairs {active_count} exceeds 3")

    all_required_verified = all(
        isinstance(surface, dict)
        and (not surface.get("required") or surface.get("status") == "verified")
        for surface in surfaces
    ) and len(surfaces) == len(REQUIRED_SURFACES)
    if ledger.get("parityClaimed") is True or ledger.get("overallStatus") == "parity":
        if not all_required_verified:
            errors.append("ledger: unsupported parity claim while required surfaces remain unverified")
    elif ledger.get("overallStatus") != "not-parity":
        errors.append("ledger: overallStatus must be not-parity until every required surface is verified")

    documentation = ledger.get("documentation")
    if not isinstance(documentation, list) or not documentation:
        errors.append("ledger: documentation must name audited Markdown files")
        documentation = []
    for relative in documentation:
        if not nonempty_string(relative):
            errors.append("ledger: documentation entries must be paths")
            continue
        path = root / str(relative)
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            errors.append(f"documentation: missing {relative}")
            continue
        if "Live 11 parity status: NOT PROVEN" not in text:
            errors.append(f"documentation: {relative} lacks the NOT PROVEN disclosure")
        if any(pattern.search(text) for pattern in FORBIDDEN_DOC_CLAIMS):
            errors.append(f"documentation: contradictory Live 11 parity claim in {relative}")
    return errors


def git_sha(root: Path) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--ledger", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--json-output", type=Path)
    parser.add_argument(
        "--expected-source-sha",
        help="Fail unless the ledger is pinned to this exact tested code revision.",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    ledger = args.ledger or root / "docs/live-clone/live11-parity.json"
    manifest = args.manifest or root / "docs/live-clone/live11-reference-manifest.json"
    errors = validate(root, ledger, manifest, args.expected_source_sha)
    result = {
        "status": "pass" if not errors else "fail",
        "sourceSha": git_sha(root),
        "ledgerPath": str(ledger.relative_to(root)),
        "ledgerSha256": sha256(ledger) if ledger.is_file() else None,
        "manifestPath": str(manifest.relative_to(root)),
        "manifestSha256": sha256(manifest) if manifest.is_file() else None,
        "errors": errors,
    }
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
