from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from teardown.catalog import TutorialCatalog
from teardown.frame_verify import FrameVerifier
from teardown.jobs import build_teardown_jobs, write_jobs
from teardown.scout import (
    ScoutPolicy,
    TutorialCandidate,
    build_scout_system_prompt,
    load_template_bank,
    rank_tutorials,
)
from teardown.youtube import YouTubeDataClient, YtDlpSearchClient


_DEFAULT_CATALOG = Path("service/teardown/catalog.sqlite")
_DEFAULT_FRAME_CACHE = Path(".cache/mosh-teardown/frames")
_DEFAULT_JOBS = Path("service/teardown/teardown_jobs.jsonl")
_DEFAULT_CHECKPOINTS = Path("service/teardown/checkpoints")


def _load_candidates(path: Path) -> list[TutorialCandidate]:
    if path.suffix.lower() in {".jsonl", ".ndjson"}:
        items = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [TutorialCandidate.from_mapping(item) for item in items if isinstance(item, dict)]
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("candidates"), list):
        items = data["candidates"]
    elif isinstance(data, list):
        items = data
    else:
        items = []
    return [TutorialCandidate.from_mapping(item) for item in items if isinstance(item, dict)]


def cmd_prompt(args: argparse.Namespace) -> int:
    policy = ScoutPolicy(synth_policy=args.synth_policy)
    print(build_scout_system_prompt(policy))
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    bank = load_template_bank(args.templates)
    candidates = _load_candidates(Path(args.input))
    if args.template_id:
        candidates = [candidate for candidate in candidates if candidate.template_id == args.template_id]
    if not candidates:
        raise SystemExit("no candidates to score")
    scored = rank_tutorials(candidates, policy=ScoutPolicy(synth_policy=args.synth_policy))
    if args.catalog:
        catalog = TutorialCatalog(args.catalog)
        for scored_candidate in scored:
            catalog.upsert(scored_candidate)
    output = {
        "templates": [template.id for template in bank],
        "results": [item.as_record() for item in scored],
    }
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    bank = load_template_bank(args.templates)
    templates = tuple(bank)
    if args.template_id:
        selected = bank.by_id(args.template_id)
        if selected is None:
            raise SystemExit(f"unknown template id: {args.template_id}")
        templates = (selected,)
    api_key = args.api_key or _read_api_key_file(args.api_key_file)
    client = YouTubeDataClient(api_key=api_key)
    backend = "youtube-data-api"
    if not client.available:
        client = YtDlpSearchClient()
        backend = "yt-dlp"
    if not client.available:
        raise SystemExit("YOUTUBE_DATA_API_KEY, --api-key-file, or yt-dlp is required for discovery")
    candidates: list[TutorialCandidate] = []
    verifier = FrameVerifier() if args.verify_frames else None
    for template in templates:
        hits = client.discover(template, max_results=args.max_results)
        for hit in hits:
            candidate = hit.to_candidate(template.id)
            if verifier is not None:
                probe = verifier.verify(
                    candidate.video_id,
                    candidate.url,
                    args.frame_cache,
                    candidate.duration_s,
                    candidate.title,
                    candidate.description,
                    candidate.tags,
                )
                candidate = dataclasses.replace(candidate, probe=probe)
            candidates.append(candidate)
    scored = rank_tutorials(candidates, policy=ScoutPolicy(synth_policy=args.synth_policy))
    catalog = TutorialCatalog(args.catalog)
    for scored_candidate in scored:
        catalog.upsert(scored_candidate)
    rows = [item.as_record() for item in scored[: args.limit if args.limit else None]]
    json.dump({"backend": backend, "results": rows, "summary": catalog.summary()}, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def cmd_queue(args: argparse.Namespace) -> int:
    catalog = TutorialCatalog(args.catalog)
    status = None if args.status == "all" else args.status
    rows = catalog.list(status=status, limit=args.limit)
    compact = []
    for row in rows:
        compact.append({
            "video_id": row["video_id"],
            "status": row["status"],
            "score": row["score"],
            "confidence": row["confidence"],
            "title": row["title"],
            "url": row["url"],
        })
    json.dump({"results": compact, "summary": catalog.summary()}, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def _candidate_from_catalog_row(row: dict) -> TutorialCandidate:
    evidence = json.loads(row.get("evidence_json") or "{}")
    metadata = json.loads(row.get("metadata_json") or "{}")
    return TutorialCandidate.from_mapping({
        "video_id": row.get("video_id", ""),
        "url": row.get("url", ""),
        "title": row.get("title", ""),
        "channel": row.get("channel", ""),
        "duration_s": row.get("duration_s"),
        "license": row.get("license", "unknown"),
        "template_id": row.get("template_id", ""),
        "probe": evidence.get("probe", {}) if isinstance(evidence, dict) else {},
        "metadata": metadata if isinstance(metadata, dict) else {},
    })


def cmd_rescore_catalog(args: argparse.Namespace) -> int:
    source = TutorialCatalog(args.catalog)
    rows = source.list(limit=args.limit if args.limit else None)
    scored = rank_tutorials(
        [_candidate_from_catalog_row(row) for row in rows],
        policy=ScoutPolicy(synth_policy=args.synth_policy),
    )
    old_by_id = {row["video_id"]: row for row in rows}
    out_path = args.out_catalog or args.catalog
    if args.out_catalog:
        catalog_path = Path(args.catalog).expanduser().resolve()
        output_path = Path(out_path).expanduser().resolve()
        if output_path != catalog_path:
            for stale_path in (Path(out_path), Path(f"{out_path}-wal"), Path(f"{out_path}-shm")):
                if stale_path.exists():
                    stale_path.unlink()
    output_catalog = TutorialCatalog(out_path)
    movement = []
    for item in scored:
        old = old_by_id.get(item.candidate.video_id, {})
        output_catalog.upsert(item, discovered_at=old.get("discovered_at", ""), screened_at=old.get("screened_at", ""))
        if old and (old.get("status") != item.decision or round(float(old.get("score", 0.0)), 4) != item.score):
            movement.append({
                "video_id": item.candidate.video_id,
                "title": item.candidate.title,
                "old_status": old.get("status"),
                "new_status": item.decision,
                "old_score": old.get("score"),
                "new_score": item.score,
            })
    output = {
        "catalog": args.catalog,
        "out_catalog": out_path,
        "summary": output_catalog.summary(),
        "changed": movement,
    }
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def cmd_export_jobs(args: argparse.Namespace) -> int:
    catalog = TutorialCatalog(args.catalog)
    statuses = tuple(status.strip() for status in args.statuses.split(",") if status.strip())
    rows = catalog.list(limit=args.limit if args.limit else None)
    jobs = build_teardown_jobs(rows, checkpoint_root=args.checkpoint_root, statuses=statuses)
    written = write_jobs(args.out, jobs)
    output = {
        "out": args.out,
        "written": written,
        "statuses": list(statuses),
        "jobs": jobs[: args.print_limit if args.print_limit else 0],
    }
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def cmd_ingest_midi(args: argparse.Namespace) -> int:
    from teardown.midi_ingest import ingest_directory
    from teardown.recipe import Role

    split_drum_roles = tuple(
        Role(role.strip())
        for role in args.split_drum_roles.split(",")
        if role.strip()
    )

    output = ingest_directory(args.dir, args.out, bpm=args.bpm, key=args.key,
                              limit=args.limit, library_out=args.library_out,
                              split_drum_roles=split_drum_roles)
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def _read_api_key_file(path: str) -> str:
    if not path:
        return ""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", text)
    text = text.replace("{", " ").replace("}", " ").replace("\\", " ")
    match = re.search(r"AIza[0-9A-Za-z_-]{20,}", text)
    return match.group(0) if match else ""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="teardown-scout", description="Tutorial scouting workflow")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prompt_parser = subparsers.add_parser("prompt", help="print the scouting agent prompt")
    prompt_parser.add_argument("--synth-policy", default="hybrid", choices=["hybrid", "strict"])
    prompt_parser.set_defaults(func=cmd_prompt)

    score_parser = subparsers.add_parser("score", help="score tutorial candidates from JSON or JSONL")
    score_parser.add_argument("--input", required=True, help="candidate JSON or JSONL file")
    score_parser.add_argument("--templates", default=str(Path(__file__).with_name("template_bank.json")))
    score_parser.add_argument("--catalog", default="")
    score_parser.add_argument("--template-id", default="")
    score_parser.add_argument("--synth-policy", default="hybrid", choices=["hybrid", "strict"])
    score_parser.set_defaults(func=cmd_score)

    discover_parser = subparsers.add_parser("discover", help="query the YouTube Data API and score the results")
    discover_parser.add_argument("--api-key", default="")
    discover_parser.add_argument("--templates", default=str(Path(__file__).with_name("template_bank.json")))
    discover_parser.add_argument("--catalog", default=str(_DEFAULT_CATALOG))
    discover_parser.add_argument("--max-results", type=int, default=5)
    discover_parser.add_argument("--limit", type=int, default=0)
    discover_parser.add_argument("--template-id", default="")
    discover_parser.add_argument("--api-key-file", default="")
    discover_parser.add_argument("--verify-frames", action="store_true")
    discover_parser.add_argument("--frame-cache", default=str(_DEFAULT_FRAME_CACHE))
    discover_parser.add_argument("--synth-policy", default="hybrid", choices=["hybrid", "strict"])
    discover_parser.set_defaults(func=cmd_discover)

    queue_parser = subparsers.add_parser("queue", help="print queued tutorial candidates")
    queue_parser.add_argument("--catalog", default=str(_DEFAULT_CATALOG))
    queue_parser.add_argument("--status", default="all", choices=["all", "ideal", "usable", "weak", "reject"])
    queue_parser.add_argument("--limit", type=int, default=10)
    queue_parser.set_defaults(func=cmd_queue)

    rescore_parser = subparsers.add_parser("rescore-catalog", help="rescore an existing tutorial catalog with the current ranker")
    rescore_parser.add_argument("--catalog", default=str(_DEFAULT_CATALOG))
    rescore_parser.add_argument("--out-catalog", default="")
    rescore_parser.add_argument("--limit", type=int, default=0)
    rescore_parser.add_argument("--synth-policy", default="hybrid", choices=["hybrid", "strict"])
    rescore_parser.set_defaults(func=cmd_rescore_catalog)

    jobs_parser = subparsers.add_parser("export-jobs", help="export queued scout rows as teardown job JSONL")
    jobs_parser.add_argument("--catalog", default=str(_DEFAULT_CATALOG))
    jobs_parser.add_argument("--out", default=str(_DEFAULT_JOBS))
    jobs_parser.add_argument("--checkpoint-root", default=str(_DEFAULT_CHECKPOINTS))
    jobs_parser.add_argument("--statuses", default="ideal,usable")
    jobs_parser.add_argument("--limit", type=int, default=0)
    jobs_parser.add_argument("--print-limit", type=int, default=5)
    jobs_parser.set_defaults(func=cmd_export_jobs)

    ingest_parser = subparsers.add_parser("ingest-midi", help="ingest local MIDI files as single-element recipe ingredients")
    ingest_parser.add_argument("--dir", required=True, help="directory containing .mid/.midi files")
    ingest_parser.add_argument("--out", required=True, help="output directory for recipe.json files")
    ingest_parser.add_argument("--bpm", type=float, default=140.0)
    ingest_parser.add_argument("--key", default="")
    ingest_parser.add_argument("--limit", type=int, default=0)
    ingest_parser.add_argument("--library-out", default="", help="optional flat Recipe library directory for generator.load_library")
    ingest_parser.add_argument("--split-drum-roles", default="",
                               help="comma-separated GM drum roles to extract as separate ingredients, e.g. snare or kick,snare,hat")
    ingest_parser.set_defaults(func=cmd_ingest_midi)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
