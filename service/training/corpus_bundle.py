from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .rights import eligible_for_training, load_registry, write_json


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _bundle_name_from_sources(sources: list[dict[str, Any]], fallback: str = "corpus") -> str:
    parts = [str(s.get("source_id", "")) for s in sources]
    digest = hashlib.sha256("|".join(sorted(parts)).encode("utf-8")).hexdigest()[:12]
    return f"{fallback}-{digest}"


def build_corpus_bundle(registry_path: str | os.PathLike[str],
                        output_root: str | os.PathLike[str],
                        bundle_name: str | None = None) -> dict[str, Any]:
    registry = load_registry(registry_path)
    eligible: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for src in registry.get("sources", []):
        ok, reason = eligible_for_training(src)
        if ok:
            eligible.append(src)
        else:
            skipped.append({"source_id": src.get("source_id", ""), "reason": reason})

    if not eligible:
        raise ValueError("no approved local sources available for training")

    bundle_id = bundle_name or _bundle_name_from_sources(eligible)
    root = Path(output_root) / bundle_id
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    sources_dir = root / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)

    manifest_sources: list[dict[str, Any]] = []
    bundle_hasher = hashlib.sha256()
    bundle_hasher.update(bundle_id.encode("utf-8"))
    bundle_hasher.update(json.dumps({"registry_version": registry.get("version", 1)}, sort_keys=True).encode("utf-8"))

    for index, src in enumerate(sorted(eligible, key=lambda s: str(s.get("source_id", "")))):
        local_path = Path(str(src["local_path"]))
        content_hash = _sha256_file(local_path)
        target_name = f"{index:03d}-{src['source_id']}-{local_path.name}"
        target_path = sources_dir / target_name
        shutil.copy2(local_path, target_path)
        source_record = {
            "index": index,
            "source_id": src["source_id"],
            "title": src.get("title", ""),
            "creator": src.get("creator", ""),
            "source_url": src.get("source_url", ""),
            "local_path": str(local_path),
            "copied_path": str(target_path),
            "user_claimed_license": src.get("user_claimed_license", src.get("license_name", "")),
            "proof_of_rights": src.get("proof_of_rights", ""),
            "approved_for_training": bool(src.get("approved_for_training", False)),
            "expiration": src.get("expiration"),
            "notes": src.get("notes", ""),
            "sha256": content_hash,
            "bytes": local_path.stat().st_size,
        }
        manifest_sources.append(source_record)
        bundle_hasher.update(json.dumps(source_record, sort_keys=True).encode("utf-8"))

    bundle_hash = bundle_hasher.hexdigest()
    manifest = {
        "schema_version": 1,
        "bundle_id": bundle_id,
        "bundle_hash": bundle_hash,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "registry_path": str(Path(registry_path)),
        "source_count": len(manifest_sources),
        "skipped_sources": skipped,
        "sources": manifest_sources,
    }
    manifest_path = root / "corpus.manifest.json"
    write_json(manifest_path, manifest)
    index_path = root / "bundle.index.json"
    write_json(index_path, {
        "bundle_id": bundle_id,
        "bundle_hash": bundle_hash,
        "manifest": str(manifest_path),
        "sources_dir": str(sources_dir),
    })
    manifest["bundle_path"] = str(root)
    manifest["manifest_path"] = str(manifest_path)
    manifest["index_path"] = str(index_path)
    return manifest
