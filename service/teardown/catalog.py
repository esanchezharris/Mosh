from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Mapping

from .scout import ScoredTutorial


class TutorialCatalog:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tutorial_candidates (
                    video_id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    channel TEXT NOT NULL DEFAULT '',
                    duration_s INTEGER,
                    license TEXT NOT NULL DEFAULT 'unknown',
                    template_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    score REAL NOT NULL,
                    yield_json TEXT NOT NULL,
                    evidence_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    discovered_at TEXT NOT NULL DEFAULT '',
                    screened_at TEXT NOT NULL DEFAULT ''
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS tutorial_candidates_status_idx ON tutorial_candidates(status, score DESC)")
            conn.commit()

    def upsert(self, scored: ScoredTutorial, discovered_at: str = "", screened_at: str = "") -> None:
        record = scored.as_record()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO tutorial_candidates (
                    video_id, url, title, channel, duration_s, license, template_id, status,
                    confidence, score, yield_json, evidence_json, metadata_json, content_hash,
                    discovered_at, screened_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id) DO UPDATE SET
                    url=excluded.url,
                    title=excluded.title,
                    channel=excluded.channel,
                    duration_s=excluded.duration_s,
                    license=excluded.license,
                    template_id=excluded.template_id,
                    status=excluded.status,
                    confidence=excluded.confidence,
                    score=excluded.score,
                    yield_json=excluded.yield_json,
                    evidence_json=excluded.evidence_json,
                    metadata_json=excluded.metadata_json,
                    content_hash=excluded.content_hash,
                    discovered_at=excluded.discovered_at,
                    screened_at=excluded.screened_at
                """,
                (
                    record["video_id"],
                    record["url"],
                    record["title"],
                    record["channel"],
                    record["duration_s"],
                    record["license"],
                    record["template_id"],
                    record["status"],
                    record["confidence"],
                    record["score"],
                    json.dumps(record["yield_json"], sort_keys=True),
                    json.dumps({"bundle": record["evidence_bundle"], "probe": record["probe"]}, sort_keys=True),
                    json.dumps(record["metadata"], sort_keys=True),
                    record["content_hash"],
                    discovered_at,
                    screened_at,
                ),
            )
            conn.commit()

    def list(self, status: str | None = None, limit: int | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM tutorial_candidates"
        params: list[Any] = []
        if status is not None:
            query += " WHERE status = ?"
            params.append(status)
        query += """
            ORDER BY CASE status
                WHEN 'ideal' THEN 0
                WHEN 'usable' THEN 1
                WHEN 'weak' THEN 2
                WHEN 'reject' THEN 3
                ELSE 4
            END,
            score DESC,
            confidence DESC,
            video_id ASC
        """
        if limit is not None:
            query += " LIMIT ?"
            params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def update_status(self, video_id: str, status: str, screened_at: str = "") -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE tutorial_candidates SET status = ?, screened_at = ? WHERE video_id = ?",
                (status, screened_at, video_id),
            )
            conn.commit()

    def summary(self) -> dict[str, Any]:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM tutorial_candidates").fetchone()[0]
            by_status = conn.execute(
                "SELECT status, COUNT(*) AS count FROM tutorial_candidates GROUP BY status ORDER BY status"
            ).fetchall()
        return {
            "total": total,
            "by_status": {row["status"]: row["count"] for row in by_status},
        }
