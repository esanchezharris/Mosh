"""Reusable validation rules for the owner-local Live 11 parity contract."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


REQUIRED_SURFACES = {
    "global-chrome-transport",
    "arrangement-grid-rulers",
    "track-headers-mixer",
    "clips-automation-take-lanes",
    "browser-devices-plugins",
    "midi-editor",
    "audio-device-workflow",
    "core-producer-flows",
}
VALID_SURFACE_STATUSES = {"unproven", "candidate", "verified"}
FORBIDDEN_DOC_CLAIMS = (
    re.compile(r"live\s*11\s+parity\s+(?:status\s*:\s*)?(?:complete|achieved|passed)", re.I),
    re.compile(r"(?:complete|actual|full)\s+ableton\s+live\s*11\s+parity", re.I),
)


def nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_reference(root: Path, reference: object, index: int, errors: list[str]) -> str | None:
    prefix = f"reference[{index}]"
    if not isinstance(reference, dict):
        errors.append(f"{prefix}: must be an object")
        return None
    reference_id = reference.get("id")
    if not nonempty_string(reference_id):
        errors.append(f"{prefix}: missing id")
        reference_id = None

    app = reference.get("app")
    if not isinstance(app, dict) or not nonempty_string(app.get("name")):
        errors.append(f"{prefix}: missing app.name")
    if not isinstance(app, dict) or not nonempty_string(app.get("version")):
        errors.append(f"{prefix}: missing app.version")

    viewport = reference.get("viewport")
    if not isinstance(viewport, dict):
        errors.append(f"{prefix}: missing viewport")
    else:
        for field in ("width", "height", "scale"):
            if not isinstance(viewport.get(field), (int, float)) or viewport[field] <= 0:
                errors.append(f"{prefix}: viewport.{field} must be positive")
    if not isinstance(reference.get("state"), dict) or not reference["state"]:
        errors.append(f"{prefix}: missing state metadata")

    expected_sha = reference.get("sha256")
    if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        errors.append(f"{prefix}: missing or invalid sha256")
    local_path = reference.get("localPath")
    if not nonempty_string(local_path):
        errors.append(f"{prefix}: missing localPath")
    else:
        artifact = root / str(local_path)
        if not artifact.is_file():
            errors.append(f"{prefix}: missing local reference {local_path}")
        elif isinstance(expected_sha, str) and re.fullmatch(r"[0-9a-f]{64}", expected_sha):
            if sha256(artifact) != expected_sha:
                errors.append(f"{prefix}: hash mismatch for {local_path}")
    return str(reference_id) if reference_id else None


def validate_surface(
    root: Path,
    surface: object,
    index: int,
    tested_source_sha: object,
    reference_ids: set[str],
    errors: list[str],
) -> str | None:
    prefix = f"surface[{index}]"
    if not isinstance(surface, dict):
        errors.append(f"{prefix}: must be an object")
        return None
    surface_id = surface.get("id")
    if not nonempty_string(surface_id):
        errors.append(f"{prefix}: missing id")
        return None
    prefix = f"surface[{surface_id}]"
    status = surface.get("status")
    if status not in VALID_SURFACE_STATUSES:
        errors.append(f"{prefix}: invalid status {status!r}")
    refs = surface.get("referenceIds")
    if not isinstance(refs, list) or not refs:
        errors.append(f"{prefix}: referenceIds must be non-empty")
    elif any(ref not in reference_ids for ref in refs):
        errors.append(f"{prefix}: unknown referenceIds")

    tests = surface.get("testIds")
    artifacts = surface.get("artifacts")
    if not isinstance(tests, list):
        errors.append(f"{prefix}: testIds must be an array")
        tests = []
    if not isinstance(artifacts, list):
        errors.append(f"{prefix}: artifacts must be an array")
        artifacts = []
    if status == "unproven" and not nonempty_string(surface.get("gapReason")):
        errors.append(f"{prefix}: unproven rows require gapReason")
    if status in {"candidate", "verified"}:
        if not tests or not all(nonempty_string(test_id) for test_id in tests):
            errors.append(f"{prefix}: {status} rows require exact testIds")
        if not artifacts:
            errors.append(f"{prefix}: {status} rows require artifacts")
    if status == "verified" and surface.get("verifiedSourceSha") != tested_source_sha:
        errors.append(f"{prefix}: stale source SHA in verified row")
    for artifact_index, artifact in enumerate(artifacts):
        artifact_prefix = f"{prefix}: artifact[{artifact_index}]"
        if not isinstance(artifact, dict):
            errors.append(f"{artifact_prefix} must be an object")
            continue
        artifact_path = artifact.get("path")
        if not nonempty_string(artifact_path):
            errors.append(f"{artifact_prefix} missing path")
            continue
        if artifact.get("sourceSha") != tested_source_sha:
            errors.append(f"{artifact_prefix} has stale source SHA")
        expected_sha = artifact.get("sha256")
        if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
            errors.append(f"{artifact_prefix} missing or invalid sha256")
            continue
        evidence_path = root / str(artifact_path)
        if not evidence_path.is_file():
            errors.append(f"{artifact_prefix} missing evidence artifact {artifact_path}")
        elif sha256(evidence_path) != expected_sha:
            errors.append(f"{artifact_prefix} evidence hash mismatch for {artifact_path}")
    return str(surface_id)
