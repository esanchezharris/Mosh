"""Re-stamp stored trajectory hashes after a canonical-hash version bump.

The state hash is versioned (the `schema` key inside the canon — v2 as of
S33). Bumping it invalidates every recorded `state_hash_after` in the store:
replay_check would report MISMATCH for perfectly good trajectories. This
script re-derives the truth instead of discarding it:

  for each trajectory:
    rebuild the IR job exactly like replay_check
    fresh replay on the CURRENT binary  ->  current-version hash
    if all ops execute: UPDATE the final hash-bearing step's
    state_hash_after and stamp trajectories.hash_version

Intermediate per-step hashes are left as recorded (historical, version
implied by hash_version at import time); the replay contract — and the only
thing replay_check asserts — is the FINAL hash.

Usage:
  python3 -m flywheel.store.restamp_hashes [--db PATH] [--app PATH] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from . import store

HASH_VERSION = 2
HASH_NEUTRAL = {"render.bounce", "render.commit"}

DEFAULT_APP = Path(__file__).resolve().parents[2] / (
    "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh")


def ensure_column(conn) -> None:
    cols = [r[1] for r in conn.execute("PRAGMA table_info(trajectories)")]
    if "hash_version" not in cols:
        conn.execute(
            "ALTER TABLE trajectories ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1")
        conn.commit()


def restamp(conn, traj_id: str, app: Path, dry_run: bool) -> str:
    rec = store.trajectory_record(conn, traj_id)
    ops, last_hash_seq, pure_ir = [], None, True
    for step in rec["steps"]:
        if not step["ops"]:
            continue
        ops.extend(step["ops"])
        if step["command"] == "execute_ir" or all(
                op.get("kind") in HASH_NEUTRAL for op in step["ops"]):
            if step["state_hash_after"]:
                # trajectory_record exposes seq as step_id = "s<seq>".
                last_hash_seq = int(str(step["step_id"]).lstrip("s"))
        else:
            pure_ir = False
    if not ops:
        return "skip (no IR ops)"
    if not pure_ir or last_hash_seq is None:
        # Lifted trajectories never assert hash equality - nothing to re-stamp
        # beyond the version marker.
        if not dry_run:
            conn.execute("UPDATE trajectories SET hash_version=? WHERE traj_id=?",
                         (HASH_VERSION, traj_id))
            conn.commit()
        return "version-stamped (lifted-IR: hash not asserted)"

    with tempfile.TemporaryDirectory() as tmp:
        job_path = Path(tmp) / "job.json"
        job_path.write_text(json.dumps(
            {"ops": ops, "tutorialId": traj_id, "timeout_s": 120}))
        result_path = Path(tmp) / "result.json"
        env = dict(os.environ,
                   MOSH_SESSION_DIR=str(Path(tmp) / "sess"),
                   MOSH_GAP_LEDGER=str(Path(tmp) / "gap.jsonl"))
        subprocess.run(
            [str(app), "--harness", str(job_path), "--harness-out", str(result_path)],
            env=env, capture_output=True, timeout=180)
        result = json.loads(result_path.read_text()) if result_path.exists() else {}

    counts = result.get("counts") or {}
    new_hash = result.get("state_hash")
    if counts.get("failed", 1) != 0 or not new_hash:
        # Not replay-coherent (e.g. eval-rollout residue: ops from separate
        # sessions concatenated, so symbol bindings cross session boundaries).
        # That is a property of the stored data, not the hash bump - leave it
        # at v1 so the incoherence stays visible.
        return (f"not replay-coherent (exec={counts.get('executed')} "
                f"failed={counts.get('failed')}) - left at v1, hash NOT restamped")
    if dry_run:
        return f"would restamp seq {last_hash_seq} -> {new_hash[:16]}…"
    conn.execute(
        "UPDATE steps SET state_hash_after=? WHERE traj_id=? AND seq=?",
        (new_hash, traj_id, last_hash_seq))
    conn.execute("UPDATE trajectories SET hash_version=? WHERE traj_id=?",
                 (HASH_VERSION, traj_id))
    conn.commit()
    return f"restamped seq {last_hash_seq} -> {new_hash[:16]}… (v{HASH_VERSION})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--app", default=str(DEFAULT_APP))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = store.connect(args.db) if args.db else store.connect()
    ensure_column(conn)
    rows = conn.execute("SELECT traj_id, hash_version FROM trajectories").fetchall()
    if not rows:
        print("store is empty - nothing to restamp")
        return 0
    failures = 0
    for traj_id, hv in rows:
        if hv == HASH_VERSION:
            print(f"{traj_id}: already v{HASH_VERSION}")
            continue
        outcome = restamp(conn, traj_id, Path(args.app), args.dry_run)
        print(f"{traj_id}: {outcome}")
        failures += outcome.startswith("FAIL")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
