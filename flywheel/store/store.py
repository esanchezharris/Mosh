"""Trajectory store (phase0 §5): SQLite for records, JSONL export per
trajectory, renders/assets content-addressed in flat object storage.

One schema, every source — human_session | tutorial_replication |
perturbation | agent_rollout — interchangeable training rows from day one.
SQLite is the Phase 0 decision (no Postgres, no queue infra, §14.3).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import time
from pathlib import Path

DEFAULT_DB = Path(os.environ.get(
    "MOSH_STORE_DB",
    Path.home() / "Library/Mosh/flywheel/store.sqlite3"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS trajectories (
  traj_id      TEXT PRIMARY KEY,
  ir_version   TEXT NOT NULL,
  mosh_version TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN
                ('human_session','tutorial_replication','perturbation','agent_rollout')),
  instruction  TEXT,
  actor_uuid   TEXT,
  actor_name   TEXT,
  consent      INTEGER NOT NULL DEFAULT 0,
  started_ts   INTEGER,
  tutorial_url TEXT,
  grade        TEXT CHECK (grade IN ('exact','gold','silver','bronze') OR grade IS NULL),
  accepted     INTEGER,
  outcome      TEXT,      -- JSON: verifier readouts (L0..L4) when graded
  provenance   TEXT,      -- JSON: acquisition/license posture (§12)
  imported_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  traj_id          TEXT NOT NULL REFERENCES trajectories(traj_id),
  seq              INTEGER NOT NULL,
  command          TEXT NOT NULL,
  args             TEXT,             -- JSON: the exact native record (replay view)
  ok               INTEGER NOT NULL,
  ir               TEXT,             -- JSON array of MoshIR ops (corpus view)
  state_hash_after TEXT,
  ts               INTEGER,
  PRIMARY KEY (traj_id, seq)
);
CREATE TABLE IF NOT EXISTS markers (
  traj_id  TEXT NOT NULL REFERENCES trajectories(traj_id),
  op_seq   INTEGER NOT NULL,
  video_ts REAL NOT NULL,
  note     TEXT
);
CREATE TABLE IF NOT EXISTS objects (
  sha256    TEXT PRIMARY KEY,
  traj_id   TEXT,
  role      TEXT,           -- render | asset | bounce
  src_name  TEXT,
  bytes     INTEGER
);
"""


def connect(db_path: Path | str = DEFAULT_DB) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def objects_dir(db_path: Path | str = DEFAULT_DB) -> Path:
    d = Path(db_path).parent / "objects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def put_object(conn: sqlite3.Connection, db_path: Path, file: Path,
               traj_id: str, role: str) -> str | None:
    """Content-address a file into the object store; returns its sha256."""
    if not file.is_file():
        return None
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    dest = objects_dir(db_path) / digest
    if not dest.exists():
        shutil.copyfile(file, dest)
    conn.execute(
        "INSERT OR IGNORE INTO objects (sha256, traj_id, role, src_name, bytes)"
        " VALUES (?,?,?,?,?)",
        (digest, traj_id, role, file.name, file.stat().st_size))
    return digest


def insert_trajectory(conn: sqlite3.Connection, rec: dict) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO trajectories (traj_id, ir_version, mosh_version,"
        " source, instruction, actor_uuid, actor_name, consent, started_ts,"
        " tutorial_url, grade, accepted, outcome, provenance, imported_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rec["traj_id"], rec["ir_version"], rec["mosh_version"], rec["source"],
         rec.get("instruction"), rec.get("actor_uuid"), rec.get("actor_name"),
         int(bool(rec.get("consent"))), rec.get("started_ts"),
         rec.get("tutorial_url"), rec.get("grade"),
         rec.get("accepted"), json.dumps(rec.get("outcome")) if rec.get("outcome") else None,
         json.dumps(rec.get("provenance")) if rec.get("provenance") else None,
         int(time.time() * 1000)))


def insert_step(conn: sqlite3.Connection, traj_id: str, s: dict) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO steps (traj_id, seq, command, args, ok, ir,"
        " state_hash_after, ts) VALUES (?,?,?,?,?,?,?,?)",
        (traj_id, s["seq"], s["command"],
         json.dumps(s.get("args")), int(bool(s.get("ok"))),
         json.dumps(s.get("ir")) if s.get("ir") is not None else None,
         s.get("state_hash_after"), s.get("ts")))


def insert_marker(conn: sqlite3.Connection, traj_id: str, m: dict) -> None:
    conn.execute(
        "INSERT INTO markers (traj_id, op_seq, video_ts, note) VALUES (?,?,?,?)",
        (traj_id, m.get("op_seq", 0), m.get("video_ts", 0.0), m.get("note")))


def trajectory_record(conn: sqlite3.Connection, traj_id: str) -> dict:
    """Assemble the spec §5 record shape for one trajectory."""
    cur = conn.execute("SELECT * FROM trajectories WHERE traj_id = ?", (traj_id,))
    cur.row_factory = sqlite3.Row
    row = cur.fetchone()
    if row is None:
        raise KeyError(traj_id)
    steps = []
    sc = conn.execute(
        "SELECT seq, command, args, ok, ir, state_hash_after, ts FROM steps"
        " WHERE traj_id = ? ORDER BY seq", (traj_id,))
    for seq, command, args, ok, ir, h, ts in sc.fetchall():
        steps.append({
            "step_id": f"s{seq}",
            "command": command,
            "args": json.loads(args) if args else None,
            "ok": bool(ok),
            "ops": json.loads(ir) if ir else [],
            "state_hash_after": h,
            "ts": ts,
        })
    markers = [{"op_seq": o, "video_ts": v, "note": n} for o, v, n in conn.execute(
        "SELECT op_seq, video_ts, note FROM markers WHERE traj_id = ?", (traj_id,))]
    return {
        "traj_id": row["traj_id"],
        "ir_version": row["ir_version"],
        "mosh_version": row["mosh_version"],
        "source": row["source"],
        "instruction": row["instruction"],
        "context": {"state_before": None},
        "steps": steps,
        "markers": markers,
        "outcome": json.loads(row["outcome"]) if row["outcome"] else
                   {"verifier": {}, "grade": row["grade"], "accepted": bool(row["accepted"])
                    if row["accepted"] is not None else None},
        "provenance": json.loads(row["provenance"]) if row["provenance"] else {
            "tutorial_url": row["tutorial_url"],
            "consent": bool(row["consent"]),
            "license_notes": "no source media stored; samples from owned/licensed/generated",
        },
    }
