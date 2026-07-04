#!/usr/bin/env python3
"""Owner DAW projects → recipe library (the drum-poverty fix).

Walks ~/mosh-taste/projects/*.{flp,als,rpp}, runs each through the lossless
importer CLI (`npm run import -- <file> --json <ir.json>` — 100% note fidelity,
docs/MOSHI_IMPORTERS.md), then service/recipes/ingest_ir.py turns the IR into
per-element library recipes (License.owner, real project tempo, the standing
grid/rhythm/dedupe refusal guards).

ERA DISCIPLINE: growing the library shifts generation's retrieval distribution,
so this runs at ERA BOUNDARIES (era_boundary.py calls it), never mid-era. The
drop folder itself can accumulate any time.

    python3 scripts/verify-hardware/ingest_taste_projects.py [--dry-run]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
PROJECTS = Path(os.path.expanduser("~/mosh-taste/projects"))
STAGING = PROJECTS / ".ir"
LEDGER = PROJECTS / ".ingested.json"
LIBRARY = REPO / "service" / "recipes" / "library"
PROJECT_EXT = {".flp", ".als", ".rpp"}


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not PROJECTS.is_dir():
        print(f"no projects dir at {PROJECTS}")
        return 0
    files = sorted(p for p in PROJECTS.rglob("*")
                   if p.is_file() and p.suffix.lower() in PROJECT_EXT
                   and " 2" not in p.name)
    if not files:
        print(f"projects: nothing under {PROJECTS} (drop .flp/.als/.rpp files)")
        return 0

    done = json.loads(LEDGER.read_text()) if LEDGER.is_file() else {}
    todo = [(p, _sha(p)) for p in files]
    todo = [(p, s) for p, s in todo if done.get(str(p)) != s]
    if not todo:
        print(f"projects: all {len(files)} already ingested (idempotent)")
        return 0
    if args.dry_run:
        for p, _ in todo:
            print(f"would import {p}")
        return 0

    STAGING.mkdir(parents=True, exist_ok=True)
    imported = 0
    for p, s in todo:
        out = STAGING / f"{p.stem}_{s[:8]}.ir.json"
        print(f"importing {p.name} …")
        r = subprocess.run(["npm", "run", "-s", "import", "--", str(p),
                            "--json", str(out)],
                           cwd=str(REPO / "ui"), capture_output=True, text=True,
                           timeout=600)
        if r.returncode != 0 or not out.is_file():
            tail = (r.stderr or r.stdout or "").strip().splitlines()
            print(f"  importer failed: {tail[-1] if tail else '?'}", file=sys.stderr)
            continue
        done[str(p)] = s
        imported += 1
    if not imported:
        print("projects: nothing imported")
        return 1

    r = subprocess.run([sys.executable, str(REPO / "service/recipes/ingest_ir.py"),
                        "--ir-dir", str(STAGING), "--library", str(LIBRARY)],
                       capture_output=True, text=True, timeout=600)
    print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr.strip(), file=sys.stderr)
        return r.returncode
    LEDGER.write_text(json.dumps(done, indent=1))
    print(f"projects: {imported} project(s) → library "
          f"(summary: {LIBRARY.parent / 'owner_ingest_summary.json'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
