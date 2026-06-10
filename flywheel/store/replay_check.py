#!/usr/bin/env python3
"""Replay-check a stored trajectory (phase0 §4 conformance + §8 verifier L1):
rebuild a harness job from the trajectory's IR ops, run `Mosh --harness` in a
fresh session, and compare the resulting state_hash against the recorded
state_hash_after of the last IR step.

  python3 -m flywheel.store.replay_check <traj_id> --db PATH --app MOSH_BINARY

Exact-match guarantee applies to pure-IR trajectories (steps recorded via
execute_ir — harness runs, agent rollouts, IR-driven sessions). Sessions of
native UI commands carry best-effort lifted IR (documented lossy: bar
rounding); those replay for L1 validity, not hash equality — the verifier
grades them, this tool reports rather than asserts.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flywheel.store import store  # noqa: E402


def replay_check(traj_id: str, db_path: Path, app: Path, strict: bool) -> int:
    conn = store.connect(db_path)
    rec = store.trajectory_record(conn, traj_id)

    # Hash-checkable = every op-bearing step is execute_ir (verbatim IR) or
    # lifts only to state-neutral render ops (bounce/commit don't mutate the
    # edit). Anything else is best-effort lifted IR — L1 validity only.
    HASH_NEUTRAL = {"render.bounce", "render.commit"}
    ops, expected_hash, pure_ir = [], None, True
    for step in rec["steps"]:
        if step["ops"]:
            ops.extend(step["ops"])
            if step["command"] == "execute_ir":
                expected_hash = step["state_hash_after"] or expected_hash
            elif all(op.get("kind") in HASH_NEUTRAL for op in step["ops"]):
                expected_hash = step["state_hash_after"] or expected_hash
            else:
                pure_ir = False
    if not ops:
        print("no IR ops to replay")
        return 2

    with tempfile.TemporaryDirectory() as tmp:
        job = {"ops": ops, "tutorialId": traj_id, "timeout_s": 120}
        job_path = Path(tmp) / "job.json"
        job_path.write_text(json.dumps(job))
        result_path = Path(tmp) / "result.json"
        env = dict(os.environ,
                   MOSH_SESSION_DIR=str(Path(tmp) / "sess"),
                   MOSH_GAP_LEDGER=str(Path(tmp) / "gap.jsonl"))
        proc = subprocess.run(
            [str(app), "--harness", str(job_path), "--harness-out", str(result_path)],
            env=env, capture_output=True, timeout=180)
        result = json.loads(result_path.read_text()) if result_path.exists() else {}

    counts = result.get("counts", {})
    replay_hash = result.get("state_hash")
    print(f"replayed {len(ops)} IR ops: exec={counts.get('executed')} "
          f"unsupported={counts.get('unsupported')} failed={counts.get('failed')} "
          f"(harness exit {proc.returncode})")
    if counts.get("failed", 1) != 0:
        print("L1 FAIL: ops failed on replay")
        return 1
    if pure_ir and expected_hash:
        match = replay_hash == expected_hash
        print(f"hash check (pure-IR trajectory): {'MATCH' if match else 'MISMATCH'}\n"
              f"  recorded: {expected_hash}\n  replayed: {replay_hash}")
        return 0 if match else 1
    print("L1 pass (lifted-IR trajectory: validity check only, hash not asserted)")
    return 0 if not strict else 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("traj_id")
    ap.add_argument("--db", type=Path, default=store.DEFAULT_DB)
    ap.add_argument("--app", type=Path, required=True)
    ap.add_argument("--strict", action="store_true",
                    help="fail unless a hash equality check was possible and passed")
    a = ap.parse_args()
    sys.exit(replay_check(a.traj_id, a.db, a.app, a.strict))


if __name__ == "__main__":
    main()
