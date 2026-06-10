#!/usr/bin/env python3
"""Eval harness (phase0 §11): run the task suite against a program, report
JSONL + a summary — no dashboard infra.

  python3 -m flywheel.gepa.eval [--provider mock|gemini] [--tasks N|ids]
      [--program DIR] [--db PATH] [--out report.jsonl]

Reported per run: lowering rate (L0), exec validity (L1), judge mean (L4),
end-to-end success (L1 pass AND judge >= 4), seconds/task. The Stage 11 gate
bar (spec §1): >= 70% end-to-end on the 24-task suite with a REAL provider —
mock runs prove the machinery, not the bar.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flywheel.gepa import rollout  # noqa: E402

TASKS = json.loads((Path(__file__).parent / "tasks.json").read_text())["tasks"]


def run_eval(provider: str, tasks: list[dict], program_dir: Path | None,
             db_path: Path | None, out: Path | None) -> dict:
    rows = []
    for t in tasks:
        r = rollout.run_rollout(t, provider, program_dir=program_dir, db_path=db_path)
        rows.append(r)
        flag = "ok " if r["ok"] else "FAIL"
        print(f"  {flag} {t['id']}: score={r['score']} l0={r['l0']} "
              f"l1={r['l1']} l4={r['l4']} ({r['seconds']}s)")
    n = len(rows)
    summary = {
        "provider": provider,
        "tasks": n,
        "end_to_end_success": round(sum(1 for r in rows if r["ok"]) / n, 3),
        "l0_mean": round(sum(r["l0"] for r in rows) / n, 3),
        "l1_rate": round(sum(1 for r in rows if r["l1"]) / n, 3),
        "l4_mean": round(sum(r["l4"] for r in rows) / n, 3),
        "repair_rate": round(sum(1 for r in rows if r.get("repaired")) / n, 3),
        "seconds_total": round(sum(r["seconds"] for r in rows), 1),
    }
    if out:
        with out.open("w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
            f.write(json.dumps({"summary": summary}) + "\n")
    print("summary:", json.dumps(summary))
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="mock")
    ap.add_argument("--tasks", default="all",
                    help="'all', a count, or comma-separated task ids")
    ap.add_argument("--program", type=Path)
    ap.add_argument("--db", type=Path)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()

    tasks = TASKS
    if a.tasks != "all":
        if a.tasks.isdigit():
            tasks = TASKS[: int(a.tasks)]
        else:
            wanted = set(a.tasks.split(","))
            tasks = [t for t in TASKS if t["id"] in wanted]
    summary = run_eval(a.provider, tasks, a.program, a.db, a.out)
    # Gate bar only binds for real providers on the full suite.
    if a.provider != "mock" and len(tasks) == len(TASKS):
        sys.exit(0 if summary["end_to_end_success"] >= 0.70 else 1)


if __name__ == "__main__":
    main()
