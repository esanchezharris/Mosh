"""Render/score cache keyed by the rendered-WAV hash (+ a scorer/version tag).

Identical rollouts never re-render or re-score. In-memory by default; pass a path to
persist a JSON store across runs. Keys are composed by the caller (Oracle) from the
rendered-audio hash and the scorer version, so a scorer swap (§11) cleanly invalidates.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional, Union

import numpy as np


def wav_hash(y: np.ndarray) -> str:
    """Stable content hash of a mono float32 buffer (the render-cache key primitive)."""
    return hashlib.sha256(
        np.ascontiguousarray(np.asarray(y, dtype=np.float32)).tobytes()
    ).hexdigest()


class RenderCache:
    def __init__(self, path: Optional[Union[str, Path]] = None) -> None:
        self.path = Path(path) if path else None
        self._mem: dict[str, Any] = {}
        if self.path and self.path.exists():
            try:
                self._mem = json.loads(self.path.read_text())
            except (json.JSONDecodeError, OSError):
                self._mem = {}

    def get(self, key: str) -> Optional[Any]:
        return self._mem.get(key)

    def put(self, key: str, value: Any) -> None:
        self._mem[key] = value
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self._mem, sort_keys=True))

    def __contains__(self, key: str) -> bool:
        return key in self._mem

    def __len__(self) -> int:
        return len(self._mem)
