#!/usr/bin/env python3
"""Era boundary — the checklist as code.

    era_boundary.py --open [--commit origin/main] [--packs 4]
    era_boundary.py --note "owner: fix X"      # queue a batched fix mid-era
    era_boundary.py --close [--force]

--open freezes an era: a git worktree at the frozen commit (the PHYSICAL code
freeze — every pack builds from it) + data-pin snapshots (source priors, element
strikes; the ranker model is pinned by refusal in make_pack). --close runs the
boundary pipeline: verify ratings → merge labels → embeddings (backfill+corpus)
→ owner-project library ingest → retrain ranker + report → bench → journal →
era report; then stamps closedAt and removes the worktree. Batched fixes land
as normal PRs AFTER close, BEFORE the next --open.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BEATS = Path(os.path.expanduser("~/mosh-beats"))
ERAS = BEATS / "eras"
LABELS = BEATS / "labels"
ERA_WORKTREES = Path(os.path.expanduser("~/mosh-eras"))

# what the freeze covers: everything that shapes a candidate between request and WAV
FREEZE_SCOPE = ["service/recipes/", "service/teardown/render/",
                "scripts/verify-hardware/beat_factory.py",
                "scripts/verify-hardware/latent_lanes.py",
                "scripts/verify-hardware/make_pack.py"]

sys.path.insert(0, str(HERE))
from make_pack import active_era, save_era, _sha  # noqa: E402


def _run(cmd: list, name: str, timeout: int = 3600) -> dict:
    print(f"── {name}: {' '.join(str(c) for c in cmd)}")
    r = subprocess.run([str(c) for c in cmd], timeout=timeout)
    return {"step": name, "rc": r.returncode}


def open_era(commit_ref: str, n_packs: int) -> int:
    if active_era() is not None:
        print("an era is already open — close it first", file=sys.stderr)
        return 1
    nums = [int(d.name.split("-")[1]) for d in ERAS.glob("era-*") if d.is_dir()]
    era_id = f"era-{(max(nums) + 1 if nums else 1):03d}"
    subprocess.run(["git", "-C", str(REPO), "fetch", "origin", "main"],
                   capture_output=True)
    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", commit_ref],
                            capture_output=True, text=True, check=True).stdout.strip()
    wt = ERA_WORKTREES / era_id
    ERA_WORKTREES.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["git", "-C", str(REPO), "worktree", "add", "--detach",
                        str(wt), commit], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"worktree add failed: {r.stderr.strip()}", file=sys.stderr)
        return 1

    era_dir = ERAS / era_id
    era_dir.mkdir(parents=True, exist_ok=True)
    for fname in ("source_priors.json", "element_strikes.json"):
        src = LABELS / fname
        if src.is_file():
            shutil.copy2(src, era_dir / fname)

    pack_nums = [int(d.name.split("-")[1]) for d in BEATS.glob("pack-*") if d.is_dir()]
    first = (max(pack_nums) + 1) if pack_nums else 1
    lib = wt / "service" / "recipes" / "library"
    lib_hash = hashlib.sha1("".join(sorted(p.name for p in lib.glob("*.json")))
                            .encode()).hexdigest()[:12] if lib.is_dir() else ""
    era = {"id": era_id, "createdAt": datetime.now().isoformat(timespec="seconds"),
           "frozenCommit": commit, "worktree": str(wt),
           "codeFreezeScope": FREEZE_SCOPE,
           "pins": {"rankerModelSha": _sha(LABELS / "taste_ranker.json"),
                    "priorsSha": _sha(era_dir / "source_priors.json"),
                    "strikesSha": _sha(era_dir / "element_strikes.json"),
                    "libraryHash": lib_hash,
                    "paletteSha": _sha(Path(os.path.expanduser(
                        "~/Library/Mosh/palette-v1/manifest.json")))},
           "plannedPacks": [f"pack-{first + i:03d}" for i in range(n_packs)],
           "packs": [], "batchedFixes": [], "closedAt": None, "boundaryReport": None}
    save_era(era)
    print(f"{era_id} OPEN at {commit[:12]} — packs {era['plannedPacks'][0]}…"
          f"{era['plannedPacks'][-1]} build from {wt}")
    print(f"manifest → {era_dir / 'manifest.json'}")
    return 0


def add_note(text: str) -> int:
    era = active_era()
    if era is None:
        print("no active era", file=sys.stderr)
        return 1
    era["batchedFixes"].append({"date": datetime.now().isoformat(timespec="seconds"),
                                "note": text, "status": "queued"})
    save_era(era)
    print(f"queued for the boundary: {text}")
    return 0


def close_era(force: bool) -> int:
    era = active_era()
    if era is None:
        print("no active era", file=sys.stderr)
        return 1
    built = era.get("packs", [])
    missing = [p for p in built if not list((BEATS / p).glob("RATINGS*.csv"))]
    if missing and not force:
        print(f"unrated packs: {', '.join(missing)} — rate them first "
              "(or --force to close anyway)", file=sys.stderr)
        return 1

    py = sys.executable
    report = {"era": era["id"], "closedAt": None, "packs": built,
              "unratedAtClose": missing, "steps": []}
    for cmd, name in (
            ([py, HERE / "merge_labels.py"], "merge_labels"),
            ([py, HERE / "embed_store.py", "--backfill"], "embed_backfill"),
            ([py, HERE / "embed_store.py", "--corpus"], "embed_corpus"),
            ([py, HERE / "ingest_taste_projects.py"], "project_ingest"),
            ([py, HERE / "taste_ranker.py", "--train"], "ranker_train"),
            ([py, HERE / "taste_ranker.py", "--report"], "ranker_report"),
            ([py, HERE / "bench_evaluators.py"], "bench"),
            ([py, HERE / "build_journal.py"], "journal")):
        report["steps"].append(_run(cmd, name))

    stamp = datetime.now().isoformat(timespec="seconds")
    report["closedAt"] = stamp
    era["closedAt"] = stamp
    era["boundaryReport"] = report
    save_era(era)

    reports_dir = REPO / "docs" / "bench" / "ERA_REPORTS"
    reports_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"# {era['id']} boundary report", "",
             f"- closed: {stamp}", f"- frozen commit: {era['frozenCommit']}",
             f"- packs: {', '.join(built) or '(none)'}", ""]
    if report["steps"]:
        lines += ["| step | rc |", "|---|---|"]
        lines += [f"| {s['step']} | {s['rc']} |" for s in report["steps"]]
    if era["batchedFixes"]:
        lines += ["", "## Batched fixes to land before the next era", ""]
        lines += [f"- [ ] {f['note']} ({f['date']})" for f in era["batchedFixes"]]
    (reports_dir / f"{era['id']}.md").write_text("\n".join(lines) + "\n")
    print(f"era report → {reports_dir / (era['id'] + '.md')}")

    wt = Path(os.path.expanduser(era["worktree"]))
    if wt.is_dir():
        subprocess.run(["git", "-C", str(REPO), "worktree", "remove", "--force",
                        str(wt)], capture_output=True)
    bad = [s for s in report["steps"] if s["rc"] != 0]
    if bad:
        print(f"steps with nonzero rc: {[s['step'] for s in bad]} — review before "
              "opening the next era", file=sys.stderr)
    print(f"{era['id']} CLOSED. Land batched fixes on main, then: "
          "era_boundary.py --open")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--open", action="store_true")
    ap.add_argument("--close", action="store_true")
    ap.add_argument("--note", default=None)
    ap.add_argument("--commit", default="origin/main")
    ap.add_argument("--packs", type=int, default=4)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    if args.note:
        return add_note(args.note)
    if args.open:
        return open_era(args.commit, args.packs)
    if args.close:
        return close_era(args.force)
    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
