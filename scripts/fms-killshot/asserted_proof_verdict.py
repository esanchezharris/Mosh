from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

VERDICTS = {"pass", "close but revise", "fail"}
CLASSIFICATIONS = {"", "words", "timing", "pitch/register", "voice/timbre"}

# Ground-truth annotation (annotator round, 2026-07-12): the owner's hand-marked syllable
# onsets, saved by the waveform tool. No manifest hash — this is fresh truth, not a verdict
# ON an artifact. Bounds are sanity guards; the real precision is the owner's ear.
MAX_ANNOTATION_ONSETS = 2000        # a 56s take holds ~150; 2000 is a runaway backstop
MAX_ANNOTATION_TIME_S = 3600.0      # 1 hour — a paste/units-bug tripwire, not a real limit
MAX_STRUCK_WORDS = 500              # struck ASR words ("word@start" keys) — same backstop idea
MAX_STRUCK_KEY_LEN = 64


def validate_annotations(payload: dict) -> None:
    """Raise RuntimeError unless payload is a well-formed onset annotation set:
    {phrases: {"<index>": [onset_s, ...]}, createdAt, ...}. Onsets are finite,
    non-negative, within the sanity cap; the total is bounded."""
    if not isinstance(payload, dict):
        raise RuntimeError("annotations must be a JSON object")
    if not isinstance(payload.get("createdAt"), str) or not payload["createdAt"]:
        raise RuntimeError("annotations must include createdAt")
    phrases = payload.get("phrases")
    if not isinstance(phrases, dict):
        raise RuntimeError("annotations.phrases must be an object of per-phrase onset lists")
    total = 0
    for key, onsets in phrases.items():
        if not isinstance(onsets, list):
            raise RuntimeError(f"phrase {key} onsets must be a list")
        total += len(onsets)
        for t in onsets:
            if isinstance(t, bool) or not isinstance(t, (int, float)):
                raise RuntimeError(f"phrase {key} has a non-numeric onset")
            if not math.isfinite(float(t)) or not (0.0 <= float(t) <= MAX_ANNOTATION_TIME_S):
                raise RuntimeError(f"phrase {key} has an out-of-range onset: {t}")
    if total > MAX_ANNOTATION_ONSETS:
        raise RuntimeError(f"too many onsets ({total} > {MAX_ANNOTATION_ONSETS})")
    struck = payload.get("struck", {})
    if not isinstance(struck, dict):
        raise RuntimeError("annotations.struck must be an object of word@start keys")
    if len(struck) > MAX_STRUCK_WORDS:
        raise RuntimeError(f"too many struck words ({len(struck)} > {MAX_STRUCK_WORDS})")
    for key in struck:
        if not isinstance(key, str) or len(key) > MAX_STRUCK_KEY_LEN:
            raise RuntimeError("struck keys must be short 'word@start' strings")


def save_annotations(payload: dict, destination: Path) -> dict:
    validate_annotations(payload)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return payload


def _validate_verdict_fields(verdict: dict, manifest_path: Path) -> None:
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


def validate_review_verdict(verdict: dict, manifest_path: Path) -> None:
    if verdict.get("clip") != "opening":
        raise RuntimeError("owner verdict must target the opening proof")
    _validate_verdict_fields(verdict, manifest_path)


def validate_ace_cover_verdict(verdict: dict, manifest_path: Path, seed: int) -> None:
    if verdict.get("clip") != "ace-cover":
        raise RuntimeError("candidate verdict must target the ace-cover lane")
    try:
        verdict_seed = int(verdict.get("seed"))
    except (TypeError, ValueError):
        raise RuntimeError("candidate verdict must carry an integer seed") from None
    if verdict_seed != int(seed):
        raise RuntimeError(f"candidate verdict seed {verdict.get('seed')} does not match the target seed {seed}")
    _validate_verdict_fields(verdict, manifest_path)


def save_ace_cover_verdict(verdict: dict, manifest_path: Path, seed: int, destination: Path) -> dict:
    validate_ace_cover_verdict(verdict, manifest_path, seed)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(verdict, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return verdict


AB_WINNERS = {"A", "B", "neither"}


def validate_ab_verdict(verdict: dict, manifest_path: Path) -> None:
    if verdict.get("clip") != "ace-cover-ab":
        raise RuntimeError("verdict must target the ace-cover-ab comparison")
    if verdict.get("winner") not in AB_WINNERS:
        raise RuntimeError("ab verdict winner must be A, B, or neither")
    if not isinstance(verdict.get("notes", ""), str) or len(verdict.get("notes", "")) > 4000:
        raise RuntimeError("owner verdict notes must be text no longer than 4000 characters")
    if not isinstance(verdict.get("createdAt"), str) or not verdict["createdAt"]:
        raise RuntimeError("owner verdict must include createdAt")
    current = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    if verdict.get("manifestSha256") != current:
        raise RuntimeError("owner verdict approved a different artifact manifest")


def save_ab_verdict(verdict: dict, manifest_path: Path, destination: Path) -> dict:
    validate_ab_verdict(verdict, manifest_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(verdict, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return verdict


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
