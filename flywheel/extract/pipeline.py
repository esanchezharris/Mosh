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
                 judge_provider: str | None = None,
                 workdir: Path | None = None,
                 artifacts_dir: Path | None = None,
                 instruction: str | None = None) -> dict:
    t0 = time.time()
    ing = ingest_mod.ingest(url=url, media=media, fixture=fixture, workdir=workdir)
    steps = segment_mod.segment(ing["transcript"])
    print(f"segmented into {len(steps)} steps")

    fixture_steps = None
    if fixture is not None and (fixture / "steps.json").is_file():
        fixture_steps = json.loads((fixture / "steps.json").read_text())

    # Per-step inference. The running summary is the SYMBOL TABLE — rung-1
    # lesson: without it the model copies exemplar ids per step and later
    # steps reference clips that don't exist yet.
    all_ops, step_records, unextracted = [], [], 0
    symbols = {"tracks": {}, "clips": {}, "devices": {}}

    def _summary() -> str:
        if not any(symbols.values()):
            return "EMPTY project — no tracks, clips, or devices exist yet."
        parts = []
        if symbols["tracks"]:
            parts.append("tracks: " + ", ".join(
                f"{k}({v})" for k, v in symbols["tracks"].items()))
        if symbols["clips"]:
            parts.append("clips: " + ", ".join(
                f"{k}(on {v})" for k, v in symbols["clips"].items()))
        if symbols["devices"]:
            parts.append("devices: " + ", ".join(
                f"{k}({v})" for k, v in symbols["devices"].items()))
        return "; ".join(parts)

    def _absorb(ops: list) -> None:
        for op in ops:
            k, p = op.get("kind", ""), op.get("params", {})
            if k == "track.create":
                symbols["tracks"][p.get("track_id")] = p.get("role", p.get("kind", "audio"))
            elif k == "track.delete":
                symbols["tracks"].pop(p.get("track_id"), None)
            elif k in ("clip.create", "sample.place"):
                symbols["clips"][p.get("clip_id")] = p.get("track_id")
            elif k == "clip.delete":
                symbols["clips"].pop(p.get("clip_id"), None)
            elif k == "device.add":
                symbols["devices"][p.get("device_id")] = \
                    f"{p.get('role')} on {p.get('track_id')}"

    for i, step in enumerate(steps):
        mock_ops = fixture_steps[i] if fixture_steps and i < len(fixture_steps) else None
        inf = infer_mod.infer_step(step, _summary(), provider, mock_ops=mock_ops)
        ops = inf.get("ops", []) if inf.get("ok") else []
        if not inf.get("ok"):
            unextracted += 1
        all_ops += ops
        _absorb(ops)
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

    # Claims: transcript-mined + fixture file + REAL vision claims off the
    # keyframes (mock provider → zero vision calls); L2 vs the projection.
    claims = verify.claims_from_transcript(ing["transcript"])
    if ing.get("claims_path"):
        claims += json.loads(Path(ing["claims_path"]).read_text())
    if ing.get("frame_index") and provider != "mock":
        vclaims = verify.claims_from_frames(ing["frame_index"], provider)
        print(f"  vision claims: {len(vclaims)} from {len(ing['frame_index'])} keyframes")
        claims += vclaims
    # Claim hygiene (rung-1 lesson): spoken BPMs in a teaching video are often
    # demonstrations ("if I drop to 90..."). Frame-read BPM beats speech; with
    # no frames, only the LAST spoken bpm describes the kept artifact.
    # Dedupe identical (kind, value) claims first — 93 keyframes of a static
    # tempo display yield 48 copies of bpm=160, which would drown every other
    # claim in the L2 denominator. Keep the max-confidence representative.
    best: dict = {}
    for c in claims:
        k = (c.get("kind"), str(c.get("value")), c.get("source"))
        if k not in best or c.get("confidence", 0) > best[k].get("confidence", 0):
            best[k] = c
    claims = list(best.values())

    spoken_bpm = [c for c in claims if c.get("kind") == "bpm" and c.get("source") == "transcript"]
    frame_bpm = [c for c in claims if c.get("kind") == "bpm" and c.get("source") == "frame"]
    if spoken_bpm and (frame_bpm or len(spoken_bpm) > 1):
        keep = set() if frame_bpm else {id(max(spoken_bpm, key=lambda c: c.get("ts", 0)))}
        claims = [c for c in claims if not (c.get("kind") == "bpm"
                                            and c.get("source") == "transcript"
                                            and id(c) not in keep)]
    duration_s = ing["transcript"][-1]["end"] if ing["transcript"] else None
    l2 = verify.l2_score(claims, harness.get("projection", "{}"), duration_s) \
        if harness.get("projection") else {"score": None, "checked": 0, "misses": []}
    l3 = verify.l3_score(genre=ing["provenance"].get("genre", "unknown"))
    instruction = (instruction or ing["provenance"].get("title")
                   or f"replicate tutorial: {steps[0]['narration'][:90]}")
    outline = "\n".join(f"- {s['narration'][:140]}" for s in steps[:20])
    verdict = judge_mod.judge(
        judge_provider or provider,
        f"{instruction}\nWhat the tutorial covered, step by step:\n{outline}\n"
        f"Judge how faithfully the op program realizes the BUILD steps among "
        f"these (explanation-only steps need no ops).",
        all_ops, counts)
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

    # Replication-ladder artifacts: everything the correction pass needs.
    if artifacts_dir is not None:
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        (artifacts_dir / "attempt.json").write_text(json.dumps({
            "result": result,
            "steps": [{"step_id": sr["step"]["step_id"],
                       "narration": sr["step"]["narration"],
                       "narration_ts": sr["step"]["narration_ts"],
                       "ops": sr["ops"],
                       "unextracted": sr["unextracted"],
                       "errors": sr["errors"]} for sr in step_records],
            "claims": claims,
            "l2": l2,
            "judge": verdict,
        }, indent=1))
        if harness.get("projection"):
            (artifacts_dir / "projection.json").write_text(harness["projection"])

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
