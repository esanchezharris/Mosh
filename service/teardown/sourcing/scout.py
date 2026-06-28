"""The Scout — wires discovery → catalog → pre-screen → ranked queue (spec §3).

discover() pulls metadata via the Searcher and lands new videos (dedup by video_id);
prescreen() scores the discovered batch and writes yield.predicted; queue() returns the
top tutorials by predicted overall yield for §4. visual_verify() is deferred (needs §2).
"""
from __future__ import annotations

import time
from typing import Callable, Optional

from .catalog import Catalog
from .discover import Searcher, VideoMeta, YtDlpSearcher
from .prescreen import prescreen
from .score import predict_yield


class Scout:
    def __init__(self, catalog: Catalog, searcher: Optional[Searcher] = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.cat = catalog
        self.searcher = searcher or YtDlpSearcher()
        self.clock = clock

    def discover(self, templates: list[str], max_results: int) -> int:
        """Search each template; land NEW videos. Returns the count added (dedup'd)."""
        added = 0
        for t in templates:
            for meta in self.searcher.search(t, max_results):
                if meta.video_id and self.cat.upsert_discovered(meta, self.clock()):
                    added += 1
        return added

    def prescreen(self, batch: int = 200) -> int:
        """Score the discovered batch (metadata-only) → prescreen_score + yield.predicted;
        keep tutorials, mark obvious non-matches `skipped`. Returns rows screened."""
        n = 0
        for row in self.cat.by_status("discovered")[:batch]:
            meta = VideoMeta.from_dict(row.metadata_json or {})
            res = prescreen(meta)
            y = predict_yield(res.signals, row.license)
            self.cat.set_screened(row.video_id, res.score, y, self.clock(), keep=res.keep)
            n += 1
        return n

    def visual_verify(self, batch: int = 50) -> int:
        """Sparse visual verification (pull a few frames, run §2 detectors) — DEFERRED
        until §2 (the vision package) lands. No-op for now."""
        return 0

    def queue(self, n: int, min_overall: float = 0.0):
        return self.cat.queue(n, min_overall)
