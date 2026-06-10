#!/usr/bin/env python3
"""Export trajectories from the store as spec §5 JSONL records.

  python3 -m flywheel.store.export_jsonl [--db PATH] [--traj-id ID] [--out FILE]

One JSON record per line; the whole corpus view a trainer consumes.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flywheel.store import store  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=store.DEFAULT_DB)
    ap.add_argument("--traj-id")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()

    conn = store.connect(a.db)
    ids = [a.traj_id] if a.traj_id else [r[0] for r in conn.execute(
        "SELECT traj_id FROM trajectories ORDER BY imported_at")]
    sink = a.out.open("w") if a.out else sys.stdout
    for tid in ids:
        sink.write(json.dumps(store.trajectory_record(conn, tid)) + "\n")
    if a.out:
        sink.close()
        print(f"exported {len(ids)} trajectories -> {a.out}")


if __name__ == "__main__":
    main()
