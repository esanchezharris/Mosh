#!/usr/bin/env python3
"""Import a Mosh session's trajectory.jsonl into the trajectory store.

  python3 -m flywheel.store.import_session <session_dir>
      [--db PATH] [--instruction TEXT] [--source human_session|...]
      [--allow-no-consent]   # test/dev ONLY — consent gates corpus entry (§12.4)

Consent is read from the session header plus any later {type:"consent"} lines
(latest wins). Without consent the import REFUSES — that is the product
contract, enforced at the store boundary. Renders found in <session>/renders
are content-addressed into the object store. IR ops in steps are validated
against moshir-0.2.schema.json; invalid ops fail the import (corrupt ops never
enter the corpus — phase0 §8 L1's job at the boundary).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "moshir"))
sys.path.insert(0, str(REPO_ROOT))

import validate as moshir_validate  # noqa: E402  (moshir/validate.py)
from flywheel.store import store  # noqa: E402


def import_session(session_dir: Path, db_path: Path, instruction: str | None,
                   source: str, allow_no_consent: bool) -> str:
    traj_path = session_dir / "trajectory.jsonl"
    if not traj_path.is_file():
        raise SystemExit(f"no trajectory.jsonl in {session_dir}")

    header = None
    steps, markers = [], []
    tutorial_url = None
    consent = False
    for line in traj_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        kind = rec.get("type")
        if kind == "session":
            header = rec
            consent = bool(rec.get("consent"))
        elif kind == "step":
            steps.append(rec)
        elif kind == "marker":
            markers.append(rec)
        elif kind == "tutorial":
            tutorial_url = rec.get("url")
        elif kind == "consent":
            consent = bool(rec.get("consent"))
    if header is None:
        raise SystemExit("trajectory has no session header")

    if not consent and not allow_no_consent:
        raise SystemExit(
            "REFUSED: session has no consent flag — nothing enters the corpus "
            "without it (phase0 §12.4). Flip it in Mosh (set_consent) or pass "
            "--allow-no-consent for test data.")

    # Validate every IR op against the schema BEFORE anything is written.
    bad = 0
    for s in steps:
        for op in s.get("ir") or []:
            errs = moshir_validate.validate_op(op)
            if errs:
                bad += 1
                print(f"  invalid IR in step {s.get('seq')}: {errs[0]}", file=sys.stderr)
    if bad:
        raise SystemExit(f"REFUSED: {bad} invalid IR op(s) — corpus stays clean")

    traj_id = header["traj_id"]
    conn = store.connect(db_path)
    with conn:
        store.insert_trajectory(conn, {
            "traj_id": traj_id,
            "ir_version": header.get("ir_version", "0.1"),
            "mosh_version": header.get("mosh_version", "unknown"),
            "source": source,
            "instruction": instruction,
            "actor_uuid": (header.get("actor") or {}).get("uuid"),
            "actor_name": (header.get("actor") or {}).get("name"),
            "consent": consent,
            "started_ts": header.get("started_ts"),
            "tutorial_url": tutorial_url,
            "provenance": {
                "tutorial_url": tutorial_url,
                "acquisition": "manual",
                "consent": consent,
                "license_notes": "no source media stored; samples from owned/licensed/generated",
            },
        })
        for s in steps:
            store.insert_step(conn, traj_id, s)
        for m in markers:
            store.insert_marker(conn, traj_id, m)
        renders = session_dir / "renders"
        if renders.is_dir():
            for f in sorted(renders.glob("*.wav")):
                store.put_object(conn, Path(db_path), f, traj_id, "render")
    n_objects = conn.execute(
        "SELECT COUNT(*) FROM objects WHERE traj_id = ?", (traj_id,)).fetchone()[0]
    print(f"imported {traj_id}: {len(steps)} steps, {len(markers)} markers, "
          f"{n_objects} objects, consent={consent}")
    return traj_id


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir", type=Path)
    ap.add_argument("--db", type=Path, default=store.DEFAULT_DB)
    ap.add_argument("--instruction")
    ap.add_argument("--source", default="human_session",
                    choices=["human_session", "tutorial_replication",
                             "perturbation", "agent_rollout"])
    ap.add_argument("--allow-no-consent", action="store_true")
    a = ap.parse_args()
    import_session(a.session_dir, a.db, a.instruction, a.source, a.allow_no_consent)


if __name__ == "__main__":
    main()
