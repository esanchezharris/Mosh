#!/usr/bin/env python3
"""RL-env generation v0 — the Repo2RLEnv contract applied to Mosh.

Repo2RLEnv's insight: read real repositories (PRs, commits) and emit
verifiable tasks with programmatic rewards. Ours: read the TRAJECTORY STORE
(tutorial replications, human sessions, agent rollouts) and emit verifiable
tasks rewarded by the session-delta scorer. Every Mosh session is an RL
environment the product generates for free.

Contract (matching their Protocol shape):
  pipeline.name : str
  pipeline.run(out_dir) -> {"tasks": n, "ids": [...]}   # writes tasks/<id>/

Each tasks/<content-hash>/task.json:
  {instruction, ir_version, source_traj, oracle: {ops, state_hash},
   scoring: {type: "session_delta", judge: "rubrics/v1"}}
The oracle PROJECTION is not shipped — ops replay deterministically
(Stage 8), so any consumer regenerates it bit-identically via
`Mosh --harness` and rewards with flywheel.verify.delta.score().

  python3 -m flywheel.envgen.tutorial_pipeline --db PATH --out runs/envs

v0 ships TutorialPipeline; SessionHistoryPipeline (human telemetry steps as
tasks) and RolloutPipeline (failed agent rollouts as retry tasks) are the
documented follow-ons under the same contract.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flywheel.store import store  # noqa: E402


class TutorialPipeline:
    name = "tutorial_replication"

    def __init__(self, db_path: Path):
        self.db_path = db_path

    def run(self, out_dir: Path) -> dict:
        conn = store.connect(self.db_path)
        ids = []
        rows = conn.execute(
            "SELECT traj_id FROM trajectories WHERE source = 'tutorial_replication'"
            " AND accepted = 1").fetchall()
        for (traj_id,) in rows:
            rec = store.trajectory_record(conn, traj_id)
            ops = [op for s in rec["steps"] for op in s["ops"]]
            if not ops:
                continue
            state_hash = next((s["state_hash_after"] for s in reversed(rec["steps"])
                               if s.get("state_hash_after")), None)
            payload = {
                "instruction": rec["instruction"],
                "ir_version": rec["ir_version"],
                "source_traj": traj_id,
                "grade": rec["outcome"].get("grade"),
                "oracle": {"ops": ops, "state_hash": state_hash},
                "scoring": {"type": "session_delta",
                            "scorer": "flywheel.verify.delta.score",
                            "judge_rubric": "flywheel/gepa/rubrics/v1.md"},
            }
            canonical = json.dumps({"instruction": payload["instruction"],
                                    "ops": ops}, sort_keys=True)
            task_id = hashlib.sha256(canonical.encode()).hexdigest()[:16]
            task_dir = out_dir / "tasks" / task_id
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "task.json").write_text(json.dumps(payload, indent=1))
            (task_dir / "metadata.json").write_text(json.dumps({
                "pipeline": self.name, "content_hash": task_id,
                "tutorial_url": rec["provenance"].get("tutorial_url"),
                "reward_types": ["session_delta", "llm_judge"],
            }, indent=1))
            ids.append(task_id)
        return {"tasks": len(ids), "ids": ids}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=store.DEFAULT_DB)
    ap.add_argument("--out", type=Path, default=Path("runs/envs"))
    a = ap.parse_args()
    result = TutorialPipeline(a.db).run(a.out)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
