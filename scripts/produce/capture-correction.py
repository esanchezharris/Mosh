#!/usr/bin/env python3
"""capture-correction.py — turn an owner verdict into a produce-lane correction.

Writes docs/produce-corrections/<id>.meta.json — the produce lane's own
correction store (docs/produce-corrections/README.md), same shape as the
AbletonMONSTER flywheel lab's flywheel-data/corrections/*.meta.json. This is
the START of a correction round: filing a correction never touches
PRODUCE_RULES on its own — promotion (README.md's step-by-step) is a separate,
hand-done edit, never automatic, never gated on a proxy score.

Two input modes:

  1. From the overnight package's verdict.json (scripts/produce-lane/
     build-package.py's output, or its audition.html "Copy verdict" paste-over):
       capture-correction.py --verdict-json <path> [--candidate <name>]
     Writes one meta.json per RATED candidate in the array (an entry whose
     `rating` is still null is a template row the owner hasn't filled in yet —
     skipped, never fabricated). --candidate limits to one entry by its
     `candidate` field (e.g. "B-mosh-run042.wav").

  2. Manual, for a single run:
       capture-correction.py --run <runId> --rating pass|pass_with_notes|fail \\
         --verdict "one sentence" --note "..." [--note "..." ...] \\
         [--reference <path-or-note>] [--ask <text>] [--run-dir <dir>]

`ask` and `prompt_version` are filled in automatically when discoverable
(--run-dir's run.json for the ask; PRODUCE_VERSION parsed out of
ui/src/agent/loop/producePrompt.ts for the prompt version) — never guessed
when they aren't.

Usage:
  capture-correction.py --verdict-json <path> [--candidate <name>] [--dry-run]
  capture-correction.py --run <runId> --rating <r> --verdict <text>
    [--note <text> ...] [--reference <text>] [--ask <text>] [--run-dir <dir>]
    [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
CORRECTIONS_DIR = REPO_ROOT / "docs" / "produce-corrections"
PRODUCE_PROMPT_TS = REPO_ROOT / "ui" / "src" / "agent" / "loop" / "producePrompt.ts"
VALID_RATINGS = {"pass", "pass_with_notes", "fail"}
ID_RE = re.compile(r"[^A-Za-z0-9._-]+")


def slugify(name: str) -> str:
    stem = name.rsplit(".", 1)[0] if "." in name and not name.startswith(".") else name
    return ID_RE.sub("-", stem).strip("-")


def discover_prompt_version() -> int | None:
    """Parse `export const PRODUCE_VERSION = N;` out of producePrompt.ts — never
    guessed, and never re-derived from anything but the source of truth."""
    try:
        text = PRODUCE_PROMPT_TS.read_text(encoding="utf-8")
    except OSError:
        return None
    m = re.search(r"export const PRODUCE_VERSION\s*=\s*(\d+)\s*;", text)
    return int(m.group(1)) if m else None


def discover_ask(run_dir: Path | None) -> str | None:
    if run_dir is None:
        return None
    run_json = run_dir / "run.json"
    if not run_json.is_file():
        return None
    try:
        data = json.loads(run_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    ask = data.get("ask")
    return ask if isinstance(ask, str) and ask else None


def run_id_from_candidate(candidate: str) -> str | None:
    """"B-mosh-<runId>.wav" / "B-labkit-<runId>.wav" -> <runId>; anything else
    (a release/flywheel/fixture-replay reference) has no run id."""
    m = re.match(r"^B-(?:mosh|labkit)-(?P<run_id>.+)\.wav$", candidate)
    return m.group("run_id") if m else None


def build_meta(
    *,
    correction_id: str,
    created: str,
    ask: str | None,
    prompt_version: str | None,
    run: str | None,
    reference: str | None,
    rating: str,
    user_verdict: str | None,
    notes: list[str],
) -> dict[str, Any]:
    if rating not in VALID_RATINGS:
        raise ValueError(f"rating must be one of {sorted(VALID_RATINGS)}, got {rating!r}")
    return {
        "id": correction_id,
        "created": created,
        "ask": ask,
        "prompt_version": prompt_version,
        "run": run,
        "reference": reference,
        "rating": rating,
        "user_verdict": user_verdict,
        "notes": list(notes),
        "promoted_to": None,
    }


def write_meta(meta: dict[str, Any], out_dir: Path, *, dry_run: bool) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{meta['id']}.meta.json"
    text = json.dumps(meta, indent=2) + "\n"
    if dry_run:
        print(f"[capture-correction] --dry-run: would write {path}")
        print(text)
    else:
        path.write_text(text, encoding="utf-8")
        print(f"[capture-correction] wrote {path}")
    return path


def from_verdict_json(args: argparse.Namespace) -> int:
    verdict_path = Path(args.verdict_json).expanduser()
    try:
        entries = json.loads(verdict_path.read_text(encoding="utf-8"))
    except OSError as e:
        print(f"[capture-correction] cannot read {verdict_path}: {e}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as e:
        print(f"[capture-correction] {verdict_path} is not valid JSON: {e}", file=sys.stderr)
        return 1
    if not isinstance(entries, list):
        print(f"[capture-correction] {verdict_path}: expected a JSON array (v1 verdict shape)", file=sys.stderr)
        return 1

    run_dir_root = Path(args.run_dir).expanduser() if args.run_dir else None
    prompt_version = discover_prompt_version()
    written: list[Path] = []
    skipped_unrated = 0

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        candidate = entry.get("candidate")
        if not isinstance(candidate, str) or not candidate:
            continue
        if args.candidate and candidate != args.candidate:
            continue
        rating = entry.get("rating")
        if not rating:
            skipped_unrated += 1
            continue  # a template row the owner hasn't filled in yet
        if rating not in VALID_RATINGS:
            print(f"[capture-correction] skipping {candidate}: unrecognized rating {rating!r}", file=sys.stderr)
            continue

        run_id = run_id_from_candidate(candidate)
        run_dir = (run_dir_root / "runs" / run_id) if (run_dir_root and run_id) else None
        ask = discover_ask(run_dir)
        notes = entry.get("notes") or []
        if not isinstance(notes, list):
            notes = [str(notes)]

        meta = build_meta(
            correction_id=slugify(candidate),
            created=str(entry.get("date") or date.today().isoformat()),
            ask=ask,
            prompt_version=str(prompt_version) if prompt_version is not None else None,
            run=run_id or candidate,
            reference=entry.get("reference"),
            rating=rating,
            user_verdict=entry.get("user_verdict"),
            notes=[str(n) for n in notes],
        )
        written.append(write_meta(meta, Path(args.out_dir), dry_run=args.dry_run))

    if not written:
        msg = "no rated candidates found" if skipped_unrated == 0 else f"all {skipped_unrated} candidate(s) are still unrated (fill in verdict.json first)"
        print(f"[capture-correction] {msg}", file=sys.stderr)
        return 1
    if skipped_unrated:
        print(f"[capture-correction] skipped {skipped_unrated} unrated candidate(s)")
    return 0


def from_manual_args(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).expanduser() if args.run_dir else None
    ask = args.ask or discover_ask(run_dir)
    prompt_version = discover_prompt_version()
    meta = build_meta(
        correction_id=slugify(args.run),
        created=date.today().isoformat(),
        ask=ask,
        prompt_version=str(prompt_version) if prompt_version is not None else None,
        run=str(run_dir) if run_dir else args.run,
        reference=args.reference,
        rating=args.rating,
        user_verdict=args.verdict,
        notes=list(args.note or []),
    )
    write_meta(meta, Path(args.out_dir), dry_run=args.dry_run)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out-dir", default=str(CORRECTIONS_DIR), help="where to write <id>.meta.json (default: docs/produce-corrections)")
    p.add_argument("--dry-run", action="store_true", help="print what would be written, write nothing")

    p.add_argument("--verdict-json", help="path to a verdict.json (build-package.py's array shape) — mode 1")
    p.add_argument("--candidate", help="with --verdict-json: only this candidate's `candidate` field")

    p.add_argument("--run", help="run id — mode 2 (manual, single run)")
    p.add_argument("--rating", choices=sorted(VALID_RATINGS), help="mode 2: pass | pass_with_notes | fail")
    p.add_argument("--verdict", help="mode 2: the owner's own one-line summary (user_verdict)")
    p.add_argument("--note", action="append", help="mode 2: one specific note (repeatable)")
    p.add_argument("--reference", help="mode 2: what the render was judged against")
    p.add_argument("--ask", help="mode 2: the produce-lane ask, if not discoverable from --run-dir")
    p.add_argument("--run-dir", help="the run's own directory (…/produce-runs/<runId>, or a produce-ab dir for --verdict-json) — used to read run.json's `ask`")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.verdict_json:
        return from_verdict_json(args)

    if not args.run or not args.rating or not args.verdict:
        print("[capture-correction] manual mode needs --run, --rating and --verdict (or use --verdict-json)", file=sys.stderr)
        return 2
    return from_manual_args(args)


if __name__ == "__main__":
    raise SystemExit(main())
