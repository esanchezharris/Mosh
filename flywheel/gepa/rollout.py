"""One GEPA rollout (phase0 §10): instruction → propose → headless execute →
verifier composite + TEXTUAL feedback. The typed traces (validation errors,
Unsupported reasons, judge critique) are the whole point — reflective prompt
evolution feeds on them, not on a scalar.

Every rollout — pass or fail — is written to the trajectory store as
source=agent_rollout (failures included, future KTO food).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "service"))

from agent import propose as agent_propose  # noqa: E402
from flywheel.gepa import judge as judge_mod  # noqa: E402
from flywheel.store import store  # noqa: E402

DEFAULT_APP = REPO_ROOT / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"

# A deterministic sample library for rollout sandboxes: asset.resolve needs
# something to resolve against (a producer has a crate; so does the testbed).
# Generated via FakeAdapter (seeded, byte-stable) — never committed.
LIBRARY_NAMES = [
    "808-long-distorted", "808-sub-clean", "kick-punchy", "snare-tight",
    "clap-layered", "hat-closed-crisp", "hat-open", "keys-rhodes-warm-dusty",
    "pad-dark-evolving", "lead-bright-pluck", "vox-chop-wet", "perc-shaker",
]


def ensure_library() -> Path:
    lib = Path(__file__).parent / "_library_cache"
    if not all((lib / f"{n}.wav").exists() for n in LIBRARY_NAMES):
        lib.mkdir(exist_ok=True)
        from adapters import fake_adapter  # service/ is on sys.path
        for i, n in enumerate(LIBRARY_NAMES):
            fake_adapter.generate(str(lib / f"{n}.wav"),
                                  {"seed": 1000 + i, "prompt": n, "seconds": 2.0})
    return lib


def run_rollout(task: dict, provider: str, app: Path | None = None,
                program_dir: Path | None = None,
                db_path: Path | None = None,
                judge_provider: str | None = None) -> dict:
    """Returns {task_id, ok, score, l0, l1, l4, feedback: [..], ops, ...}."""
    app = Path(app or os.environ.get("MOSH_APP", DEFAULT_APP))
    feedback: list[str] = []
    t0 = time.time()

    if program_dir is not None:
        os.environ["MOSH_AGENT_PROGRAM"] = str(program_dir)
    proposal = agent_propose.propose({
        "instruction": task["instruction"],
        "provider": provider,
        # Rollout sandboxes start cold — say so, exactly like the in-app flow
        # always sends a real summary. "The 808" on an empty session means
        # create it first; the agent can only know that if told.
        "session_summary": "EMPTY project — no tracks, clips, or devices exist yet."})
    if not proposal.get("ok"):
        feedback.append("PROPOSAL FAILED: " + proposal.get("error", "unknown"))
        feedback += proposal.get("validation_errors", [])
        result = {"task_id": task["id"], "ok": False, "score": 0.0,
                  "l0": 0.0, "l1": False, "l4": 0.0,
                  "stage": "propose", "feedback": feedback, "ops": [],
                  "seconds": round(time.time() - t0, 2)}
        _store_rollout(task, provider, result, db_path)
        return result
    ops = proposal["ops"]

    # Headless execute (L0 = lowering rate, L1 = exec validity).
    with tempfile.TemporaryDirectory() as tmp:
        job = {"ops": ops, "tutorialId": f"rollout-{task['id']}", "timeout_s": 120}
        job_path = Path(tmp) / "job.json"
        job_path.write_text(json.dumps(job))
        out_path = Path(tmp) / "result.json"
        env = dict(os.environ,
                   MOSH_SESSION_DIR=str(Path(tmp) / "sess"),
                   MOSH_GAP_LEDGER=str(Path(tmp) / "gap.jsonl"),
                   MOSH_SAMPLE_LIBRARY=str(ensure_library()))
        subprocess.run([str(app), "--harness", str(job_path),
                        "--harness-out", str(out_path)],
                       env=env, capture_output=True, timeout=180)
        harness = json.loads(out_path.read_text()) if out_path.exists() else {}
        gap = Path(tmp, "gap.jsonl")
        gap_lines = gap.read_text().splitlines() if gap.exists() else []

    counts = harness.get("counts", {}) or {}
    total = max(1, len(ops))
    l0 = (total - counts.get("unsupported", total)) / total
    l1 = counts.get("failed", 1) == 0 and bool(harness.get("state_hash"))

    for r in harness.get("results", []) or []:
        if not r.get("ok"):
            tag = "UNSUPPORTED" if r.get("unsupported") else "FAILED"
            feedback.append(f"{tag} {r.get('kind')}: "
                            f"{r.get('reason') or r.get('error') or ''}")
    for line in gap_lines:
        try:
            g = json.loads(line)
            feedback.append(f"gap: {g.get('missing_capability')}: {g.get('reason')}")
        except json.JSONDecodeError:
            pass

    # Light symbolic expectations from the task (L2-ish, ops-level).
    expect = task.get("expect", {})
    kinds = [op.get("kind") for op in ops]
    if "bpm" in expect:
        tempos = [op["params"].get("bpm") for op in ops
                  if op.get("kind") == "project.set_tempo"]
        if expect["bpm"] not in tempos:
            feedback.append(f"expectation: tempo {expect['bpm']} not set (got {tempos})")
    for k in expect.get("kinds", []):
        if k not in kinds:
            feedback.append(f"expectation: no {k} op in the program")

    verdict = judge_mod.judge(judge_provider or provider,
                              task["instruction"], ops, counts,
                              rationale=proposal.get("rationale", ""))
    l4 = float(verdict.get("mean", 0.0))
    if verdict.get("critique"):
        feedback.append("judge: " + verdict["critique"])

    expectation_hits = sum(1 for f in feedback if f.startswith("expectation:")) == 0
    ok = l1 and l4 >= 4.0
    score = round(0.3 * l0 + 0.3 * (1.0 if l1 else 0.0) + 0.4 * (l4 / 5.0), 4)
    result = {"task_id": task["id"], "ok": ok, "score": score,
              "l0": round(l0, 3), "l1": l1, "l4": l4,
              "expectations_met": expectation_hits,
              "state_hash": harness.get("state_hash"),
              "repaired": proposal.get("repaired", False),
              "program_version": proposal.get("program_version"),
              "stage": "complete", "feedback": feedback, "ops": ops,
              "seconds": round(time.time() - t0, 2)}
    _store_rollout(task, provider, result, db_path)
    return result


def _store_rollout(task: dict, provider: str, result: dict,
                   db_path: Path | None) -> None:
    """Every rollout enters the store (spec §10) — failures included."""
    conn = store.connect(db_path or store.DEFAULT_DB)
    traj_id = f"rollout-{task['id']}-{uuid.uuid4().hex[:8]}"
    with conn:
        store.insert_trajectory(conn, {
            "traj_id": traj_id, "ir_version": "0.1",
            "mosh_version": result.get("program_version") or "v0",
            "source": "agent_rollout",
            "instruction": task["instruction"],
            "actor_uuid": f"monster/{provider}",
            "consent": True,
            "started_ts": int(time.time() * 1000),
            "grade": None,
            "accepted": 1 if result["ok"] else 0,
            "outcome": {"verifier": {"L0_lowering": result["l0"],
                                     "L1_exec": result["l1"],
                                     "L4_judge": result["l4"]},
                        "accepted": result["ok"],
                        "feedback": result["feedback"][:20]},
            "provenance": {"acquisition": "agent_rollout", "consent": True,
                           "license_notes": "agent-generated ops only"},
        })
        store.insert_step(conn, traj_id, {
            "seq": 1, "command": "execute_ir",
            "args": {"ops": result["ops"], "actor": "monster"},
            "ok": result["ok"], "ir": result["ops"],
            "state_hash_after": result.get("state_hash"),
            "ts": int(time.time() * 1000)})
