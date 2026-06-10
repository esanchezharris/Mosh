#!/usr/bin/env python3
"""Extraction pipeline v0 (phase0 §7): tutorial → graded trajectory.

  python3 -m flywheel.extract.pipeline --fixture flywheel/extract/fixtures/trap140
      [--provider mock|gemini] [--db PATH] [--app MOSH_BINARY]
  python3 -m flywheel.extract.pipeline --url https://... --provider gemini

ingest → segment → per-step op inference (validated, 1 repair retry,
`unextracted` gaps recorded) → ONE harness replay of the accumulated program
(L0/L1 + canonical projection) → typed claims diffed against the projection
(L2) → L3 (rank-calibrated; unavailable until gold pairs) → L4 judge →
graded accept (gold/silver/bronze) → trajectory store, provenance mandatory.
"""
from __future__ import annotations

import argparse
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

from flywheel.extract import ingest as ingest_mod  # noqa: E402
from flywheel.extract import segment as segment_mod  # noqa: E402
from flywheel.extract import infer as infer_mod  # noqa: E402
from flywheel.extract import verify  # noqa: E402
from flywheel.gepa import judge as judge_mod  # noqa: E402
from flywheel.store import store  # noqa: E402

DEFAULT_APP = REPO_ROOT / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"


def run_pipeline(url: str | None, media: Path | None, fixture: Path | None,
                 provider: str, app: Path, db_path: Path,
                 judge_provider: str | None = None) -> dict:
    t0 = time.time()
    ing = ingest_mod.ingest(url=url, media=media, fixture=fixture)
    steps = segment_mod.segment(ing["transcript"])
    print(f"segmented into {len(steps)} steps")

    fixture_steps = None
    if fixture is not None and (fixture / "steps.json").is_file():
        fixture_steps = json.loads((fixture / "steps.json").read_text())

    # Per-step inference; the running summary is just executed-op kinds (cheap).
    all_ops, step_records, unextracted = [], [], 0
    summary_kinds: list[str] = []
    for i, step in enumerate(steps):
        mock_ops = fixture_steps[i] if fixture_steps and i < len(fixture_steps) else None
        inf = infer_mod.infer_step(step, ", ".join(summary_kinds[-12:]),
                                   provider, mock_ops=mock_ops)
        ops = inf.get("ops", []) if inf.get("ok") else []
        if not inf.get("ok"):
            unextracted += 1
        all_ops += ops
        summary_kinds += [op.get("kind", "") for op in ops]
        step_records.append({"step": step, "ops": ops,
                             "unextracted": not inf.get("ok"),
                             "errors": inf.get("errors", [])})
        print(f"  {step['step_id']}: {len(ops)} ops"
              + (" (UNEXTRACTED)" if not inf.get("ok") else ""))

    if not all_ops:
        return {"accepted": False, "grade": None, "error": "nothing extracted"}

    # One replay of the whole program (L0/L1 + projection for L2).
    with tempfile.TemporaryDirectory() as tmp:
        job_path = Path(tmp) / "job.json"
        job_path.write_text(json.dumps({"ops": all_ops, "projection": True,
                                        "tutorialId": url or str(fixture),
                                        "timeout_s": 120}))
        out_path = Path(tmp) / "result.json"
        env = dict(os.environ, MOSH_SESSION_DIR=str(Path(tmp) / "sess"),
                   MOSH_GAP_LEDGER=str(Path(tmp) / "gap.jsonl"))
        subprocess.run([str(app), "--harness", str(job_path),
                        "--harness-out", str(out_path)],
                       env=env, capture_output=True, timeout=180)
        harness = json.loads(out_path.read_text()) if out_path.exists() else {}

    counts = harness.get("counts", {}) or {}
    total = max(1, len(all_ops))
    l0 = (total - counts.get("unsupported", total)) / total
    l1 = counts.get("failed", 1) == 0 and bool(harness.get("state_hash"))

    # Claims: fixture/VLM file + transcript-mined; L2 against the projection.
    claims = verify.claims_from_transcript(ing["transcript"])
    if ing.get("claims_path"):
        claims += json.loads(Path(ing["claims_path"]).read_text())
    l2 = verify.l2_score(claims, harness.get("projection", "{}")) \
        if harness.get("projection") else {"score": None, "checked": 0, "misses": []}
    l3 = verify.l3_score(genre=ing["provenance"].get("genre", "unknown"))
    instruction = (ing["provenance"].get("title")
                   or f"replicate tutorial: {steps[0]['narration'][:90]}")
    verdict = judge_mod.judge(judge_provider or provider, instruction, all_ops, counts)
    decision = verify.grade(l0, l1, l2, l3, float(verdict.get("mean", 0.0)))

    # Store it — provenance mandatory; graded, not binary (spec §14.2).
    traj_id = f"tut-{uuid.uuid4().hex[:10]}"
    conn = store.connect(db_path)
    with conn:
        store.insert_trajectory(conn, {
            "traj_id": traj_id, "ir_version": "0.1", "mosh_version": "extract-v0",
            "source": "tutorial_replication", "instruction": instruction,
            "actor_uuid": "extractor/" + provider, "consent": True,
            "started_ts": int(t0 * 1000),
            "tutorial_url": url or str(fixture),
            "grade": decision["grade"], "accepted": 1 if decision["accepted"] else 0,
            "outcome": {"verifier": {"L0_lowering": round(l0, 3), "L1_exec": l1,
                                     "L2_symbolic": l2.get("score"),
                                     "L3_audio": l3.get("status"),
                                     "L4_judge": verdict.get("mean")},
                        "grade": decision["grade"], "accepted": decision["accepted"],
                        "policy_notes": decision["policy_notes"],
                        "l2_misses": l2.get("misses", [])[:10],
                        "unextracted_steps": unextracted},
            "provenance": ing["provenance"],
        })
        for i, sr in enumerate(step_records, start=1):
            store.insert_step(conn, traj_id, {
                "seq": i, "command": "execute_ir",
                "args": {"ops": sr["ops"], "narration": sr["step"]["narration"],
                         "narration_ts": sr["step"]["narration_ts"],
                         "unextracted": sr["unextracted"]},
                "ok": not sr["unextracted"], "ir": sr["ops"],
                "state_hash_after": harness.get("state_hash") if i == len(step_records) else None,
                "ts": int(time.time() * 1000)})
            store.insert_marker(conn, traj_id, {
                "op_seq": i, "video_ts": sr["step"]["narration_ts"][0]})

    result = {"traj_id": traj_id, "steps": len(steps), "ops": len(all_ops),
              "unextracted": unextracted, "l0": round(l0, 3), "l1": l1,
              "l2": l2.get("score"), "l3": l3.get("status"),
              "l4": verdict.get("mean"), "grade": decision["grade"],
              "accepted": decision["accepted"],
              "policy_notes": decision["policy_notes"],
              "seconds": round(time.time() - t0, 1)}
    print(json.dumps(result))
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--media", type=Path)
    ap.add_argument("--fixture", type=Path)
    ap.add_argument("--provider", default=os.environ.get("MOSH_AGENT_PROVIDER", "gemini"))
    ap.add_argument("--app", type=Path, default=Path(os.environ.get("MOSH_APP", DEFAULT_APP)))
    ap.add_argument("--db", type=Path, default=store.DEFAULT_DB)
    a = ap.parse_args()
    r = run_pipeline(a.url, a.media, a.fixture, a.provider, a.app, a.db)
    sys.exit(0 if r.get("accepted") else 1)


if __name__ == "__main__":
    main()
