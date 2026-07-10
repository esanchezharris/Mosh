from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


def write_receipt(path: Path, files: dict[str, Path]) -> None:
    payload = {
        "version": 1,
        "files": {
            label: {
                "path": os.path.relpath(file_path, path.parent),
                "bytes": file_path.stat().st_size,
                "sha256": hashlib.sha256(file_path.read_bytes()).hexdigest(),
            }
            for label, file_path in sorted(files.items())
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def receipt_is_current(path: Path, required_labels: frozenset[str] = frozenset()) -> bool:
    if not path.is_file():
        return False
    payload = json.loads(path.read_text(encoding="utf-8"))
    files = payload.get("files", {})
    if not files or not required_labels.issubset(files):
        return False
    for entry in files.values():
        file_path = Path(str(entry.get("path", "")))
        if not file_path.is_absolute():
            file_path = path.parent / file_path
        if not file_path.is_file() or file_path.stat().st_size != entry.get("bytes"):
            return False
        if hashlib.sha256(file_path.read_bytes()).hexdigest() != entry.get("sha256"):
            return False
    return True
