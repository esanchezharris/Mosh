from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Direct invocation (the gate runs `python3 <file>`): put the repo root on sys.path
# so `service.agent_eval` resolves; pytest collection already has it via rootdir.
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))

from service.agent_eval import grade
from service.agent_eval.attempt import AttemptConfig, run_attempt
from service.agent_eval.attempt_test import _source_repo, _task
from service.agent_eval.models import sha256_file


def _completed_attempt(tmp_path: Path) -> tuple[Path, Path]:
    source, base_commit = _source_repo(tmp_path)
    script = (
        "from pathlib import Path; "
        "Path('tracked.txt').write_text('after\\n'); "
        "Path('new.txt').write_text('new\\n')"
    )
    artifacts = tmp_path / "attempt-artifacts"
    run_attempt(
        AttemptConfig(
            task=_task(tmp_path, base_commit),
            source_repo=source,
            candidate_repo=tmp_path / "candidate",
            artifacts_dir=artifacts,
            agent_command=(sys.executable, "-c", script),
            passed_environment=(),
        )
    )
    return source, artifacts / "attempt.json"


def _grader_manifest(tmp_path: Path, version: str) -> Path:
    path = tmp_path / f"{version}.manifest.json"
    path.write_text(json.dumps({"version": version}), encoding="utf-8")
    return path


def test_regrade_applies_preserved_patch_and_accepts_structured_private_result(
    tmp_path: Path,
) -> None:
    # Given: a preserved attempt and a private grader that observes the patched clone.
    source, attempt_path = _completed_attempt(tmp_path)
    payload = {
        "schema_version": 1,
        "grader_version": "duplicate-time-private-v1",
        "score": 1.0,
        "passed": True,
        "checks": [
            {
                "id": "runtime",
                "passed": True,
                "score": 1.0,
                "failure_class": None,
                "detail": "fixture passed",
            }
        ],
    }
    script = (
        "import json; from pathlib import Path; "
        "assert Path('tracked.txt').read_text() == 'after\\n'; "
        "assert Path('new.txt').read_text() == 'new\\n'; "
        f"print(json.dumps({payload!r}))"
    )
    grader_manifest = _grader_manifest(tmp_path, "duplicate-time-private-v1")
    config = grade.RegradeConfig(
        attempt_path=attempt_path,
        source_repo=source,
        grader_repo=tmp_path / "grader-candidate",
        artifacts_dir=tmp_path / "grade-artifacts",
        grader_command=(sys.executable, "-c", script),
        grader_version="duplicate-time-private-v1",
        grader_manifest_path=grader_manifest,
        timeout_seconds=10,
        passed_environment=(),
    )

    # When: the external grader replays the patch without rerunning the agent.
    record = grade.run_regrade(config)

    # Then: the score is accepted with exact attempt and grader provenance.
    assert record.outcome == grade.GradeOutcome.COMPLETED
    assert record.result is not None and record.result.score == 1.0
    assert record.result.passed is True
    assert record.grader.version == "duplicate-time-private-v1"
    assert record.grader.bundle_sha256 == sha256_file(grader_manifest)
    assert record.attempt.patch_sha256


def test_regrade_classifies_malformed_grader_output_as_infrastructure_error(
    tmp_path: Path,
) -> None:
    # Given: a preserved attempt and a grader process that emits non-contract output.
    source, attempt_path = _completed_attempt(tmp_path)
    grader_manifest = _grader_manifest(tmp_path, "duplicate-time-private-v2")
    config = grade.RegradeConfig(
        attempt_path=attempt_path,
        source_repo=source,
        grader_repo=tmp_path / "grader-candidate",
        artifacts_dir=tmp_path / "grade-artifacts",
        grader_command=(sys.executable, "-c", "print('not-json')"),
        grader_version="duplicate-time-private-v2",
        grader_manifest_path=grader_manifest,
        timeout_seconds=10,
        passed_environment=(),
    )

    # When: the grader result cannot be parsed.
    record = grade.run_regrade(config)

    # Then: no candidate score is fabricated or reduced.
    assert record.outcome == grade.GradeOutcome.INFRA_ERROR
    assert record.result is None
    assert record.infrastructure_error


def test_regrade_rejects_tampered_patch_before_private_grader_runs(
    tmp_path: Path,
) -> None:
    # Given: a preserved attempt whose patch no longer matches its recorded hash.
    source, attempt_path = _completed_attempt(tmp_path)
    patch_path = attempt_path.parent / "patch.diff"
    patch_path.write_text(patch_path.read_text() + "tampered\n", encoding="utf-8")
    marker = tmp_path / "grader-ran"
    grader_manifest = _grader_manifest(tmp_path, "duplicate-time-private-v1")
    config = grade.RegradeConfig(
        attempt_path=attempt_path,
        source_repo=source,
        grader_repo=tmp_path / "grader-candidate",
        artifacts_dir=tmp_path / "grade-artifacts",
        grader_command=(
            sys.executable,
            "-c",
            f"from pathlib import Path; Path({str(marker)!r}).touch()",
        ),
        grader_version="duplicate-time-private-v1",
        grader_manifest_path=grader_manifest,
        timeout_seconds=10,
        passed_environment=(),
    )

    # When/Then: integrity validation stops before any private grader process starts.
    with pytest.raises(grade.ArtifactIntegrityError, match="patch sha256 mismatch"):
        grade.run_regrade(config)
    assert marker.exists() is False


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
