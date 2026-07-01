from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Mapping


_JOB_STATUSES = {"ideal", "usable"}


def build_teardown_job(row: Mapping[str, Any], checkpoint_root: str | Path = "service/teardown/checkpoints") -> dict[str, Any]:
    video_id = str(row["video_id"])
    work_dir = Path(checkpoint_root) / video_id
    yield_payload = _loads(row.get("yield_json"), {})
    evidence_payload = _loads(row.get("evidence_json"), {})
    metadata_payload = _loads(row.get("metadata_json"), {})
    return {
        "version": 1,
        "job_id": f"teardown:{video_id}",
        "status": "queued",
        "source": {
            "video_id": video_id,
            "url": row["url"],
            "title": row["title"],
            "channel": row["channel"],
            "duration_s": row["duration_s"],
            "license": row["license"],
            "template_id": row["template_id"],
            "content_hash": row["content_hash"],
            "metadata": metadata_payload,
        },
        "priority": {
            "scout_status": row["status"],
            "score": row["score"],
            "confidence": row["confidence"],
        },
        "yield": {
            "predicted": yield_payload,
        },
        "evidence": evidence_payload,
        "routing": {
            "start_stage": "video2recipe",
            "stages": [
                "video2recipe",
                "midi_from_screen",
                "synth_from_screen",
                "extract",
                "render",
                "qa",
            ],
            "resume_policy": "checkpoint",
        },
        "paths": {
            "work_dir": str(work_dir),
            "recipe_checkpoint": str(work_dir / "recipe.checkpoint.json"),
            "recipe_final": str(work_dir / "recipe.final.json"),
        },
        "resume": {
            "requires_recrawl": False,
            "catalog_content_hash": row["content_hash"],
            "discovered_at": row["discovered_at"],
            "screened_at": row["screened_at"],
        },
    }


def build_teardown_jobs(
    rows: Iterable[Mapping[str, Any]],
    checkpoint_root: str | Path = "service/teardown/checkpoints",
    statuses: Iterable[str] = _JOB_STATUSES,
    required_evidence: Iterable[str] = (),
    excluded_evidence: Iterable[str] = (),
) -> list[dict[str, Any]]:
    allowed = {str(status) for status in statuses}
    required = {str(item) for item in required_evidence if str(item)}
    excluded = {str(item) for item in excluded_evidence if str(item)}
    jobs = []
    for row in rows:
        if row.get("status") not in allowed:
            continue
        bundle = _evidence_bundle(row)
        if required and not required.issubset(bundle):
            continue
        if excluded and excluded.intersection(bundle):
            continue
        jobs.append(build_teardown_job(row, checkpoint_root))
    return jobs


def write_jobs(path: str | Path, jobs: Iterable[Mapping[str, Any]]) -> int:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with output.open("w", encoding="utf-8") as handle:
        for job in jobs:
            handle.write(json.dumps(job, sort_keys=True) + "\n")
            count += 1
    return count


def _loads(value: Any, fallback: Any) -> Any:
    if isinstance(value, str) and value:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return fallback
    return fallback


def _evidence_bundle(row: Mapping[str, Any]) -> set[str]:
    evidence_payload = _loads(row.get("evidence_json"), {})
    if not isinstance(evidence_payload, Mapping):
        return set()
    bundle = evidence_payload.get("bundle", [])
    if not isinstance(bundle, list):
        return set()
    return {str(item) for item in bundle}
