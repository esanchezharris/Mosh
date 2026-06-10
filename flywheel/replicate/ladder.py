#!/usr/bin/env python3
"""The Replication Ladder (Stage 13): Claude replicates tutorials, the
pipeline learns from the corrections.

  python3 -m flywheel.replicate.ladder attempt trap-03     # autonomous pass
  python3 -m flywheel.replicate.ladder rescore trap-03     # after corrections
  python3 -m flywheel.replicate.ladder status              # ladder scoreboard

attempt:  resolve the tutorial from flywheel/tutorials.json (held-out REFUSED)
          → download locally (yt-dlp; §12: never redistributed) → full
          extraction pipeline (ASR + keyframes + vision claims + replay +
          graded accept) → artifacts under runs/replication/<id>/:
          attempt.json (per-step ops + narration + claims + verdicts),
          projection.json, work/ (media, transcript, frames).

rescore:  reads corrected-steps.json (written by the corrector — Claude
          in-session, or Emilio) → replays it through the harness → grades →
          DELTA-SCORES attempt vs corrected (scope/magnitude, Repo2RLEnv
          style) → stores the corrected trajectory (silver = gold-candidate;
          Emilio's audio sign-off flips to gold) → ladder.json scoreboard.

The readiness gate for the big autonomous pass: 3 consecutive new tutorials
at >= silver fully autonomously with <= 2 corrections and delta-composite
>= 0.8 vs the corrected version.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "service"))

from flywheel.extract import pipeline as pipeline_mod  # noqa: E402
from flywheel.extract import verify as everify  # noqa: E402
from flywheel.gepa import judge as judge_mod  # noqa: E402
from flywheel.store import store  # noqa: E402
from flywheel.verify import delta as delta_mod  # noqa: E402

TUTORIALS = json.loads((REPO_ROOT / "flywheel/tutorials.json").read_text())["tutorials"]
RUNS = REPO_ROOT / "runs/replication"
DEFAULT_APP = REPO_ROOT / "build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"
EMPTY_PROJ = '{"tracks": [], "sections": []}'


def tut(tut_id: str) -> dict:
    for t in TUTORIALS:
        if t["id"] == tut_id:
            if t.get("held_out"):
                raise SystemExit(f"{tut_id} is HELD OUT — the ladder never touches it")
            return t
    raise SystemExit(f"unknown tutorial id: {tut_id}")


def _replay(ops: list, app: Path, timeout_s: int = 120) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        job = Path(tmp) / "job.json"
        job.write_text(json.dumps({"ops": ops, "projection": True,
                                   "bounce": True, "timeout_s": timeout_s}))
        out = Path(tmp) / "r.json"
        env = dict(os.environ, MOSH_SESSION_DIR=str(Path(tmp) / "sess"),
                   MOSH_GAP_LEDGER=str(Path(tmp) / "gap.jsonl"))
        subprocess.run([str(app), "--harness", str(job), "--harness-out", str(out)],
                       env=env, capture_output=True, timeout=timeout_s + 60)
        result = json.loads(out.read_text()) if out.exists() else {}
        # The bounce lives in the temp session — copy it out for ears.
        bounce = Path(tmp) / "sess/renders/harness_bounce.wav"
        result["_bounce_bytes"] = bounce.read_bytes() if bounce.exists() else None
        return result


def attempt(tut_id: str, provider: str, app: Path, db: Path) -> dict:
    t = tut(tut_id)
    out_dir = RUNS / tut_id
    out_dir.mkdir(parents=True, exist_ok=True)
    r = pipeline_mod.run_pipeline(
        url=t["url"], media=None, fixture=None,
        provider=provider, app=app, db_path=db,
        workdir=out_dir / "work", artifacts_dir=out_dir,
        instruction=f"replicate tutorial: {t['title']}")
    _update_board(tut_id, {"attempt": r, "attempt_ts": int(time.time())})
    return r


def rescore(tut_id: str, provider: str, app: Path, db: Path) -> dict:
    t = tut(tut_id)
    out_dir = RUNS / tut_id
    corrected_path = out_dir / "corrected-steps.json"
    if not corrected_path.is_file():
        raise SystemExit(f"no {corrected_path} — write the corrections first")
    corrected = json.loads(corrected_path.read_text())
    steps = corrected["steps"] if isinstance(corrected, dict) else corrected
    all_ops = [op for s in steps for op in s.get("ops", [])]

    harness = _replay(all_ops, app)
    counts = harness.get("counts", {}) or {}
    l1 = counts.get("failed", 1) == 0 and bool(harness.get("state_hash"))
    if harness.get("projection"):
        (out_dir / "projection-corrected.json").write_text(harness["projection"])
    bounce_db = None
    if harness.get("_bounce_bytes"):
        bounce = out_dir / "bounce-corrected.wav"
        bounce.write_bytes(harness.pop("_bounce_bytes"))
        bounce_db = _peak_dbfs(bounce)
        if bounce_db is None or bounce_db < -60.0:
            # The rung-1 facepalm: a structurally perfect render nobody can
            # hear (empty samplers). Silence is a loud failure now.
            print(f"!! SILENT BOUNCE ({bounce_db} dBFS) — samplers without "
                  f"sounds? device.load_sound missing?")

    # Delta-score: how far was the autonomous attempt from the correction?
    attempt_proj = (out_dir / "projection.json")
    d_att = delta_mod.delta(EMPTY_PROJ, attempt_proj.read_text()) \
        if attempt_proj.is_file() else delta_mod.delta(EMPTY_PROJ, EMPTY_PROJ)
    d_cor = delta_mod.delta(EMPTY_PROJ, harness.get("projection", EMPTY_PROJ))
    dscore = delta_mod.score(d_att, d_cor)

    # Re-grade the corrected program. Claims: the corrector's VERIFIED claims
    # win when present (rung-1 lesson: 46 agreeing vision claims misread the
    # tempo display 160→140 — corrector-zoomed crops are the ground truth);
    # else fall back to the attempt's claims.
    art = json.loads((out_dir / "attempt.json").read_text()) \
        if (out_dir / "attempt.json").is_file() else {}
    claims = (corrected.get("verified_claims") if isinstance(corrected, dict) else None) \
        or art.get("claims", [])
    duration = (steps[-1].get("narration_ts", [0, None])[1]
                if steps and steps[-1].get("narration_ts") else None)
    l2 = everify.l2_score(claims, harness.get("projection", "{}"), duration)
    # The judge grades REPLICATION fidelity, not generic taste — it must see
    # what the tutorial actually taught (the step narrations are the spec).
    outline = "\n".join(f"- [{s.get('narration_ts', ['?'])[0]}s] {s.get('narration', '')[:160]}"
                        for s in steps)
    verdict = judge_mod.judge(
        provider,
        f"Replicate this tutorial: {t['title']}\n"
        f"What the tutorial built, step by step:\n{outline}\n"
        f"Judge how faithfully the op program realizes THESE steps "
        f"(not genre conventions beyond them).",
        all_ops, counts)
    decision = everify.grade(1.0, l1, l2, everify.l3_score(genre=t["genre"]),
                             float(verdict.get("mean", 0.0)))
    if decision["grade"] == "gold":
        # Plan rule: Claude-corrected caps at silver (gold-candidate) until a
        # human listens to the bounce against the video — ears are the one
        # verifier this loop does not have.
        decision["grade"] = "silver"
        decision["policy_notes"].append(
            "gold-candidate: metrics at gold (L2>=0.8, judge>=4); awaiting audio sign-off")
    else:
        decision["policy_notes"].append(
            "gold-candidate: Claude-corrected; gold awaits Emilio's audio sign-off")

    traj_id = f"tut-{tut_id}-corrected"
    conn = store.connect(db)
    with conn:
        store.insert_trajectory(conn, {
            "traj_id": traj_id, "ir_version": "0.1", "mosh_version": "ladder-v0",
            "source": "tutorial_replication",
            "instruction": f"replicate: {t['title']}",
            "actor_uuid": "claude-corrector", "consent": True,
            "started_ts": int(time.time() * 1000), "tutorial_url": t["url"],
            "grade": decision["grade"], "accepted": 1 if decision["accepted"] else 0,
            "outcome": {"verifier": {"L1_exec": l1, "L2_symbolic": l2.get("score"),
                                     "L4_judge": verdict.get("mean")},
                        "grade": decision["grade"],
                        "policy_notes": decision["policy_notes"],
                        "delta_vs_attempt": dscore["composite"]},
            "provenance": {"tutorial_url": t["url"], "acquisition": "api",
                           "corrected_by": "claude",
                           "license_notes": "no source media stored"},
        })
        for i, s in enumerate(steps, start=1):
            store.insert_step(conn, traj_id, {
                "seq": i, "command": "execute_ir",
                "args": {"ops": s.get("ops", []), "narration": s.get("narration"),
                         "narration_ts": s.get("narration_ts")},
                "ok": True, "ir": s.get("ops", []),
                "state_hash_after": harness.get("state_hash") if i == len(steps) else None,
                "ts": int(time.time() * 1000)})

    summary = {"tut_id": tut_id, "l1": l1, "l2": l2.get("score"),
               "l4": verdict.get("mean"), "grade": decision["grade"],
               "bounce_peak_dbfs": bounce_db,
               "delta_attempt_vs_corrected": dscore,
               "corrections": corrected.get("corrections", []) if isinstance(corrected, dict) else [],
               "traj_id": traj_id}
    _update_board(tut_id, {"corrected": summary, "corrected_ts": int(time.time())})
    print(json.dumps({k: v for k, v in summary.items() if k != "delta_attempt_vs_corrected"}
                     | {"delta_composite": dscore["composite"]}))
    return summary


def _peak_dbfs(wav_path: Path) -> float | None:
    """Peak level of a 16/24-bit wav (stdlib only) — the silence guard.
    (The engine bounces 24-bit; the first version of this meter only read
    16-bit and reported None — meters must never be vaguer than the failure
    they guard against.)"""
    import math
    import struct
    import wave
    try:
        with wave.open(str(wav_path), "rb") as w:
            width = w.getsampwidth()
            if width not in (2, 3):
                return None
            peak, full = 1, float(1 << (8 * width - 1))
            remaining = w.getnframes()
            while remaining > 0:
                chunk = w.readframes(min(remaining, 1 << 16))
                remaining -= min(remaining, 1 << 16)
                if width == 2:
                    vals = struct.unpack(f"<{len(chunk) // 2}h", chunk)
                else:
                    vals = []
                    for i in range(0, len(chunk) - 2, 3):
                        v = chunk[i] | (chunk[i + 1] << 8) | (chunk[i + 2] << 16)
                        if v & 0x800000:
                            v -= 0x1000000
                        vals.append(v)
                if vals:
                    peak = max(peak, max(abs(v) for v in vals))
            return round(20 * math.log10(peak / full), 1)
    except Exception:  # noqa: BLE001
        return None


def _update_board(tut_id: str, patch: dict) -> None:
    board_path = RUNS / "ladder.json"
    board = json.loads(board_path.read_text()) if board_path.is_file() else {}
    board.setdefault(tut_id, {}).update(patch)
    RUNS.mkdir(parents=True, exist_ok=True)
    board_path.write_text(json.dumps(board, indent=1))


def status() -> None:
    board_path = RUNS / "ladder.json"
    board = json.loads(board_path.read_text()) if board_path.is_file() else {}
    for tid, entry in board.items():
        a = entry.get("attempt", {})
        c = entry.get("corrected", {})
        print(f"{tid}: attempt grade={a.get('grade')} l2={a.get('l2')} l4={a.get('l4')}"
              + (f" | corrected grade={c.get('grade')} delta={c.get('delta_attempt_vs_corrected', {}).get('composite')}"
                 f" corrections={len(c.get('corrections', []))}" if c else ""))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["attempt", "rescore", "status"])
    ap.add_argument("tut_id", nargs="?")
    ap.add_argument("--provider", default=os.environ.get("MOSH_AGENT_PROVIDER", "gemini"))
    ap.add_argument("--app", type=Path, default=Path(os.environ.get("MOSH_APP", DEFAULT_APP)))
    ap.add_argument("--db", type=Path, default=store.DEFAULT_DB)
    a = ap.parse_args()
    if a.cmd == "status":
        return status()
    if not a.tut_id:
        raise SystemExit("tutorial id required")
    if a.cmd == "attempt":
        attempt(a.tut_id, a.provider, a.app, a.db)
    else:
        rescore(a.tut_id, a.provider, a.app, a.db)


if __name__ == "__main__":
    main()
