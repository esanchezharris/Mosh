#!/usr/bin/env python3
"""Era-aware pack builder — the Long Pass entrypoint.

An ERA is a physically frozen generation pipeline: era_boundary.py --open creates
a git worktree at the frozen commit plus data-pin snapshots (priors / strikes /
ranker model). Every pack of the era builds FROM THAT WORKTREE with the pinned
data, so the owner's labels accumulate on one stable distribution — the thing
cross-pack LOPO has never had. This script refuses to build if anything drifted.

    python3 scripts/verify-hardware/make_pack.py --next        # build the next planned pack
    python3 scripts/verify-hardware/make_pack.py --next --dry-run

Exit codes: 0 built · 3 no active era / era complete (watcher treats as no-op) ·
1 drift or build failure (fail-closed: no pack is better than a broken one).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BEATS = Path(os.path.expanduser("~/mosh-beats"))
ERAS = BEATS / "eras"
LABELS = BEATS / "labels"


def _sha(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12] if path.is_file() else ""


def active_era() -> dict | None:
    """The highest-numbered era whose manifest has closedAt == None."""
    best = None
    for d in sorted(ERAS.glob("era-*")):
        m = d / "manifest.json"
        if m.is_file():
            doc = json.loads(m.read_text())
            if not doc.get("closedAt"):
                best = doc
    return best


def save_era(era: dict) -> None:
    path = ERAS / era["id"] / "manifest.json"
    path.write_text(json.dumps(era, indent=1) + "\n")


def check_freeze(era: dict) -> list:
    """Every drift is a reason NOT to build (fail-closed). Returns problem strings."""
    problems = []
    wt = Path(os.path.expanduser(era["worktree"]))
    if not wt.is_dir():
        problems.append(f"era worktree missing: {wt}")
        return problems
    # code freeze: the scope must be byte-identical to the frozen commit
    r = subprocess.run(["git", "-C", str(wt), "diff", "--quiet",
                        era["frozenCommit"], "--"] + era["codeFreezeScope"],
                       capture_output=True)
    if r.returncode != 0:
        problems.append("code-freeze scope drifted from the frozen commit "
                        f"({era['frozenCommit']}) — fix at the boundary, not mid-era")
    # ranker model pin: retraining is a boundary-only event
    cur = _sha(LABELS / "taste_ranker.json")
    if era["pins"].get("rankerModelSha") and cur != era["pins"]["rankerModelSha"]:
        problems.append(f"taste_ranker.json changed mid-era ({cur} vs pinned "
                        f"{era['pins']['rankerModelSha']}) — do not retrain mid-era")
    return problems


def next_pack(era: dict) -> str | None:
    for p in era["plannedPacks"]:
        if p not in era.get("packs", []):
            return p
    return None


def build_pack(era: dict, pack: str, dry_run: bool = False) -> int:
    wt = Path(os.path.expanduser(era["worktree"]))
    era_dir = ERAS / era["id"]
    out_dir = BEATS / pack
    pack_num = int(pack.rsplit("-", 1)[1])
    seed_base = pack_num * 10   # deterministic per pack, distinct across packs
    env = dict(os.environ)
    # data pins: generation reads the ERA snapshots, not the live label outputs
    # (the watcher merges labels after every rating — mid-era generation must not see it)
    for var, fname in (("MOSH_SOURCE_PRIORS", "source_priors.json"),
                       ("MOSH_ELEMENT_STRIKES", "element_strikes.json")):
        snap = era_dir / fname
        if snap.is_file():
            env[var] = str(snap)
    cmd = [sys.executable, str(wt / "scripts/verify-hardware/beat_factory.py"),
           "--out", str(out_dir), "--pack-size", "14",
           "--seed-base", str(seed_base)]
    print(f"{era['id']}: building {pack} (seed base {seed_base}) from {wt}")
    if dry_run:
        print("  dry-run:", " ".join(cmd))
    else:
        rc = subprocess.run(cmd, env=env).returncode
        if rc != 0:
            print(f"factory failed rc={rc} — NO pack shipped (fail-closed)")
            return 1
        if not (out_dir / "pack.json").is_file():
            print("factory produced no pack.json — NO pack shipped")
            return 1
    meta = {"pack": pack, "era": era["id"], "frozenCommit": era["frozenCommit"],
            "builtAt": datetime.now().isoformat(timespec="seconds"),
            "seedBase": seed_base, "pageSchema": 2,
            "rankerModelSha": _sha(LABELS / "taste_ranker.json"),
            "priorsHash": _sha(ERAS / era["id"] / "source_priors.json"),
            "strikesHash": _sha(ERAS / era["id"] / "element_strikes.json"),
            "dryRun": dry_run}
    if not dry_run:
        (out_dir / "pack_meta.json").write_text(json.dumps(meta, indent=1) + "\n")
        era.setdefault("packs", []).append(pack)
        save_era(era)
        print(f"{pack} ready → http://127.0.0.1:8188/{pack}/")
    else:
        print("  dry-run meta:", json.dumps(meta))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--next", action="store_true", help="build the next planned pack")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    if not args.next:
        ap.print_help()
        return 2
    era = active_era()
    if era is None:
        print("no active era — open one: era_boundary.py --open")
        return 3
    pack = next_pack(era)
    if pack is None:
        print(f"{era['id']} complete ({len(era['packs'])} packs) — close it: "
              "era_boundary.py --close")
        return 3
    problems = check_freeze(era)
    if problems:
        for p in problems:
            print(f"FREEZE VIOLATION: {p}", file=sys.stderr)
        return 1
    return build_pack(era, pack, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
