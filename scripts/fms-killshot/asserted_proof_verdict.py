from __future__ import annotations

import hashlib
import json
from pathlib import Path

VERDICTS = {"pass", "close but revise", "fail"}
CLASSIFICATIONS = {"", "words", "timing", "pitch/register", "voice/timbre"}


def validate_review_verdict(verdict: dict, manifest_path: Path) -> None:
    if verdict.get("clip") != "opening":
        raise RuntimeError("owner verdict must target the opening proof")
    if verdict.get("verdict") not in VERDICTS:
        raise RuntimeError("owner verdict must be pass, close but revise, or fail")
    if verdict.get("classification", "") not in CLASSIFICATIONS:
        raise RuntimeError("owner verdict classification is invalid")
    if not isinstance(verdict.get("notes", ""), str) or len(verdict.get("notes", "")) > 4000:
        raise RuntimeError("owner verdict notes must be text no longer than 4000 characters")
    if not isinstance(verdict.get("createdAt"), str) or not verdict["createdAt"]:
        raise RuntimeError("owner verdict must include createdAt")
    current = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    if verdict.get("manifestSha256") != current:
        raise RuntimeError("owner verdict approved a different artifact manifest")


def save_review_verdict(verdict: dict, manifest_path: Path, destination: Path) -> dict:
    validate_review_verdict(verdict, manifest_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(verdict, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return verdict


def validate_owner_verdict(verdict: dict, manifest_path: Path) -> None:
    validate_review_verdict(verdict, manifest_path)
    if verdict.get("verdict") != "pass":
        raise RuntimeError("expand-first-half requires an owner pass verdict for opening")
