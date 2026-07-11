from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json_object(path: str | os.PathLike[str]) -> tuple[dict[str, Any], str | None]:
    """Read a JSON object, distinguishing MISSING from CORRUPT / non-object.

    Returns ``(data, error)``. A MISSING file yields ``({}, None)`` so callers
    initialise normally; unparseable JSON or a valid-but-non-object payload yields
    ``({}, diagnostic)`` so the caller can SURFACE the problem instead of silently
    dropping it (and, in the state loaders, avoid overwriting the evidence).
    """
    p = Path(path)
    if not p.exists():
        return {}, None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        return {}, f"corrupt state at {p.name}: {exc}"
    if not isinstance(data, dict):
        return {}, f"invalid state at {p.name}: expected object, got {type(data).__name__}"
    return data, None


def read_json(path: str | os.PathLike[str]) -> dict[str, Any]:
    return read_json_object(path)[0]


def write_json(path: str | os.PathLike[str], payload: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def canonical_license(source: dict[str, Any]) -> str:
    return str(source.get("user_claimed_license", source.get("license_name", ""))).strip()


def next_source_id(sources: list[dict[str, Any]], prefix: str = "beat") -> str:
    max_n = 0
    for src in sources:
        sid = str(src.get("source_id", ""))
        if sid.startswith(f"{prefix}-"):
            tail = sid[len(prefix) + 1 :]
            if tail.isdigit():
                max_n = max(max_n, int(tail))
    return f"{prefix}-{max_n + 1:03d}"


def normalize_source(source: dict[str, Any]) -> dict[str, Any]:
    claimed_license = canonical_license(source)
    out = {
        "source_id": str(source.get("source_id", "")).strip(),
        "title": str(source.get("title", "")).strip(),
        "creator": str(source.get("creator", "")).strip(),
        "source_url": str(source.get("source_url", "")).strip(),
        "local_path": str(source.get("local_path", "")).strip(),
        "user_claimed_license": claimed_license,
        "proof_of_rights": str(source.get("proof_of_rights", "")).strip(),
        "approved_for_training": bool(source.get("approved_for_training", False)),
        "expiration": source.get("expiration", None),
        "notes": str(source.get("notes", "")).strip(),
        "created_at": str(source.get("created_at", utc_now())),
        "updated_at": utc_now(),
    }
    if out["expiration"] in ("", "null"):
        out["expiration"] = None
    if out["source_id"] == "":
        out["source_id"] = next_source_id([source])
    return out


def validate_source(source: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not str(source.get("source_id", "")).strip():
        errors.append("missing source_id")
    if not str(source.get("title", "")).strip():
        errors.append("missing title")
    if not str(source.get("creator", "")).strip():
        errors.append("missing creator")
    if not str(source.get("user_claimed_license", source.get("license_name", ""))).strip():
        errors.append("missing user_claimed_license")
    if not str(source.get("proof_of_rights", "")).strip():
        errors.append("missing proof_of_rights")
    if not str(source.get("source_url", "")).strip() and not str(source.get("local_path", "")).strip():
        errors.append("missing source_url or local_path")
    expiration = source.get("expiration")
    if isinstance(expiration, str) and expiration:
        try:
            datetime.fromisoformat(expiration.replace("Z", "+00:00"))
        except Exception:
            errors.append("invalid expiration")
    return errors


def eligible_for_training(source: dict[str, Any], now: datetime | None = None) -> tuple[bool, str]:
    now = now or datetime.now(timezone.utc)
    errors = validate_source(source)
    if errors:
        return False, ", ".join(errors)
    if not bool(source.get("approved_for_training", False)):
        return False, "not approved_for_training"
    local_path = str(source.get("local_path", "")).strip()
    if not local_path:
        return False, "missing local_path"
    p = Path(local_path)
    if not p.exists() or not p.is_file():
        return False, f"missing local file: {local_path}"
    expiration = source.get("expiration")
    if isinstance(expiration, str) and expiration:
        try:
            exp = datetime.fromisoformat(expiration.replace("Z", "+00:00"))
            if exp < now:
                return False, "expired"
        except Exception:
            return False, "invalid expiration"
    return True, ""


def load_registry(path: str | os.PathLike[str]) -> dict[str, Any]:
    data, error = read_json_object(path)
    sources = data.get("sources", [])
    if not isinstance(sources, list):
        sources = []
    data["sources"] = [normalize_source(s) for s in sources if isinstance(s, dict)]
    data.setdefault("version", 1)
    data.setdefault("updated_at", utc_now())
    if error:
        # CORRUPT / non-object registry: surface the diagnostic instead of silently
        # presenting an empty registry (the caller reports it; save_registry rebuilds
        # a clean payload so this transient flag is never persisted).
        data["stateError"] = error
    return data


def save_registry(path: str | os.PathLike[str], registry: dict[str, Any]) -> None:
    payload = {
        "version": int(registry.get("version", 1)),
        "updated_at": utc_now(),
        "sources": registry.get("sources", []),
    }
    write_json(path, payload)
