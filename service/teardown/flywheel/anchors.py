"""Anchor store — persist (source, reconstruction, recipe, per-element stems) for high-yield
reconstructions. Only `deterministic` reconstructions (screen-read MIDI §5 + screen-read
params §5b, high confidence) are GOLD positives; the flywheel trusts only those.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Anchor:
    anchor_id: str
    source_audio: str
    reconstruction_audio: str
    recipe_path: str = ""
    stems: dict = field(default_factory=dict)        # role -> stem wav path
    reconstruction_class: str = "partial"             # deterministic | inferred | partial
    yield_overall: float = 0.0


class AnchorStore:
    def __init__(self, root) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest = self.root / "anchors.json"
        self._items: list[Anchor] = []
        if self.manifest.exists():
            self._items = [Anchor(**d) for d in json.loads(self.manifest.read_text())]

    def add(self, a: Anchor) -> bool:
        """Add an anchor (dedup by id). Returns False if the id already exists."""
        if any(x.anchor_id == a.anchor_id for x in self._items):
            return False
        self._items.append(a)
        self.manifest.write_text(json.dumps([asdict(x) for x in self._items], indent=2))
        return True

    def all(self) -> list[Anchor]:
        return list(self._items)

    def gold(self) -> list[Anchor]:
        """Only `deterministic` reconstructions are ground-truth positives (the escape from
        the CLAP-bootstrapping circularity)."""
        return [a for a in self._items if a.reconstruction_class == "deterministic"]
