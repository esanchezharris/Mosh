"""The sourcing catalog (sqlite) — the persistent store of discovered/screened/queued
videos feeding §4. stdlib sqlite3 only; dedup by video_id PK; provenance + license + the
predicted yield ride on every row.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

STATUSES = ("discovered", "screened", "queued", "torn_down", "failed", "skipped")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
  video_id        TEXT PRIMARY KEY,
  url             TEXT,
  title           TEXT,
  channel         TEXT,
  duration_s      REAL,
  license         TEXT,
  metadata_json   TEXT,
  prescreen_score REAL,
  yield_json      TEXT,
  status          TEXT,
  content_hash    TEXT,
  discovered_at   REAL,
  screened_at     REAL
);
CREATE INDEX IF NOT EXISTS idx_status ON videos(status);
"""


@dataclass
class VideoRow:
    video_id: str
    url: str
    title: str
    channel: str
    duration_s: float
    license: str
    status: str
    prescreen_score: Optional[float] = None
    yield_overall: Optional[float] = None
    yield_json: Optional[dict] = None
    metadata_json: Optional[dict] = None
    content_hash: Optional[str] = None


def _row_to_video(r: sqlite3.Row) -> VideoRow:
    y = json.loads(r["yield_json"]) if r["yield_json"] else None
    return VideoRow(
        video_id=r["video_id"], url=r["url"], title=r["title"], channel=r["channel"],
        duration_s=r["duration_s"], license=r["license"], status=r["status"],
        prescreen_score=r["prescreen_score"],
        yield_overall=(y or {}).get("overall") if y else None,
        yield_json=y, metadata_json=json.loads(r["metadata_json"]) if r["metadata_json"] else None,
        content_hash=r["content_hash"],
    )


class Catalog:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(_SCHEMA)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # ── writes ────────────────────────────────────────────────────────────────
    def upsert_discovered(self, meta, now: float) -> bool:
        """Insert a freshly-discovered video. Returns False if the video_id already
        exists (dedup — never overwrites a screened/queued row)."""
        cur = self.db.execute("SELECT 1 FROM videos WHERE video_id=?", (meta.video_id,))
        if cur.fetchone() is not None:
            return False
        self.db.execute(
            "INSERT INTO videos (video_id,url,title,channel,duration_s,license,metadata_json,"
            "status,discovered_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (meta.video_id, meta.url, meta.title, meta.channel, meta.duration_s, meta.license,
             json.dumps(meta.to_dict()), "discovered", now),
        )
        self.db.commit()
        return True

    def set_screened(self, video_id: str, prescreen_score: float, yield_pred: dict,
                     now: float, keep: bool = True) -> None:
        self.db.execute(
            "UPDATE videos SET prescreen_score=?, yield_json=?, status=?, screened_at=? WHERE video_id=?",
            (prescreen_score, json.dumps(yield_pred), "screened" if keep else "skipped", now, video_id),
        )
        self.db.commit()

    def set_license(self, video_id: str, license: str) -> None:
        """Persist a license fetched after discovery (ytsearch metadata omits it)."""
        self.db.execute("UPDATE videos SET license=? WHERE video_id=?", (license, video_id))
        self.db.commit()

    def set_status(self, video_id: str, status: str) -> None:
        assert status in STATUSES, status
        self.db.execute("UPDATE videos SET status=? WHERE video_id=?", (status, video_id))
        self.db.commit()

    # ── reads ─────────────────────────────────────────────────────────────────
    def get(self, video_id: str) -> Optional[VideoRow]:
        r = self.db.execute("SELECT * FROM videos WHERE video_id=?", (video_id,)).fetchone()
        return _row_to_video(r) if r else None

    def by_status(self, status: str) -> list[VideoRow]:
        rows = self.db.execute("SELECT * FROM videos WHERE status=? ORDER BY discovered_at", (status,)).fetchall()
        return [_row_to_video(r) for r in rows]

    def counts(self) -> dict[str, int]:
        rows = self.db.execute("SELECT status, COUNT(*) c FROM videos GROUP BY status").fetchall()
        return {r["status"]: r["c"] for r in rows}

    def queue(self, n: int, min_overall: float = 0.0) -> list[VideoRow]:
        """Top screened videos by predicted overall yield; marks them queued."""
        rows = self.db.execute("SELECT * FROM videos WHERE status='screened'").fetchall()
        scored = [_row_to_video(r) for r in rows]
        scored = [v for v in scored if (v.yield_overall or 0.0) >= min_overall]
        scored.sort(key=lambda v: (-(v.yield_overall or 0.0), v.video_id))  # ties → stable by id
        picked = scored[: max(0, n)]
        for v in picked:
            self.set_status(v.video_id, "queued")
        return picked
