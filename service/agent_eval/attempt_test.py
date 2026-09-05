from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

# Direct invocation (the gate runs `python3 <file>`): put the repo root on sys.path
# so `service.agent_eval` resolves; pytest collection already has it via rootdir.
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))

from service.agent_eval import attempt
from service.agent_eval.models import LoadedTask, load_task, sha256_bytes, sha256_file


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _source_repo(tmp_path: Path) -> tuple[Path, str]:
    source = tmp_path / "source"
    source.mkdir()
    _git(source, "init", "--quiet")
    _git(source, "config", "user.email", "fixture@example.invalid")
    _git(source, "config", "user.name", "Fixture")
    (source / "tracked.txt").write_text("before\n", encoding="utf-8")
    _git(source, "add", "tracked.txt")
    _git(source, "commit", "--quiet", "-m", "fixture")
    return source, _git(source, "rev-parse", "HEAD")


def _task(tmp_path: Path, base_commit: str, *, wall_seconds: int = 10) -> LoadedTask:
    bundle = tmp_path / "task"
    bundle.mkdir()
    prompt_text = "Implement the public fixture.\n"
    (bundle / "PROMPT.md").write_text(prompt_text, encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "task_id": "fixture.public_change",
        "status": "ready",
        "repository": {"name": "fixture", "base_commit": base_commit},
        "prompt": {
            "path": "PROMPT.md",
            "sha256": sha256_bytes(prompt_text.encode()),
        },
        "budget": {
            "wall_seconds": wall_seconds,
            "token_limit": 1000,
            "tool_call_limit": 20,
        },
        "public_checks": [],
    }
    manifest_path = bundle / "task.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return load_task(manifest_path)


def test_run_attempt_captures_patch_transcript_status_and_hashes(tmp_path: Path) -> None:
    # Given: a dirty source checkout and an agent that changes tracked and untracked files.
    source, base_commit = _source_repo(tmp_path)
    (source / "tracked.txt").write_text("owner-dirty\n", encoding="utf-8")
    task = _task(tmp_path, base_commit)
    script = (
        "from pathlib import Path; "
        "print(input().strip()); "
        "assert Path('tracked.txt').read_text() == 'before\\n'; "
        "Path('tracked.txt').write_text('after\\n'); "
        "Path('new.txt').write_text('new\\n')"
    )
    config = attempt.AttemptConfig(
        task=task,
        source_repo=source,
        candidate_repo=tmp_path / "candidate",
        artifacts_dir=tmp_path / "artifacts",
        agent_command=(sys.executable, "-c", script),
        passed_environment=(),
    )

    # When: the public adapter runs the candidate once.
    record = attempt.run_attempt(config)

    # Then: the exact committed base was isolated and every required artifact is bound.
    assert record.outcome == attempt.AttemptOutcome.COMPLETED
    assert record.repository.base_commit == base_commit
    assert record.repository.head_after == base_commit
    assert record.repository.independent_git_dir is True
    assert record.agent.exit_code == 0
    patch = (config.artifacts_dir / record.artifacts.patch.path).read_text()
    status = (config.artifacts_dir / record.artifacts.status.path).read_text()
    transcript = (config.artifacts_dir / record.artifacts.transcript.path).read_text()
    assert "-before" in patch and "+after" in patch
    assert "new.txt" in patch and "+new" in patch
    assert "tracked.txt" in status and "new.txt" in status
    assert "Implement the public fixture." in transcript
    for artifact in (
        record.artifacts.patch,
        record.artifacts.status,
        record.artifacts.transcript,
    ):
        artifact_path = config.artifacts_dir / artifact.path
        assert artifact.sha256 == sha256_file(artifact_path)
        assert artifact.bytes == artifact_path.stat().st_size


def test_run_attempt_classifies_nonzero_agent_exit_without_losing_artifacts(
    tmp_path: Path,
) -> None:
    # Given: a valid task and an agent process that reports a normal nonzero exit.
    source, base_commit = _source_repo(tmp_path)
    config = attempt.AttemptConfig(
        task=_task(tmp_path, base_commit),
        source_repo=source,
        candidate_repo=tmp_path / "candidate",
        artifacts_dir=tmp_path / "artifacts",
        agent_command=(sys.executable, "-c", "raise SystemExit(7)"),
        passed_environment=(),
    )

    # When: the process completes unsuccessfully.
    record = attempt.run_attempt(config)

    # Then: it is an agent error, not a grader or infrastructure failure.
    assert record.outcome == attempt.AttemptOutcome.AGENT_ERROR
    assert record.agent.exit_code == 7
    assert (config.artifacts_dir / record.artifacts.patch.path).is_file()


def test_run_attempt_classifies_timeout_and_preserves_partial_transcript(
    tmp_path: Path,
) -> None:
    # Given: an agent that emits one event and then blocks beyond the declared budget.
    source, base_commit = _source_repo(tmp_path)
    script = "import signal; print('started', flush=True); signal.pause()"
    config = attempt.AttemptConfig(
        task=_task(tmp_path, base_commit, wall_seconds=1),
        source_repo=source,
        candidate_repo=tmp_path / "candidate",
        artifacts_dir=tmp_path / "artifacts",
        agent_command=(sys.executable, "-c", script),
        passed_environment=(),
    )

    # When: wall-clock enforcement terminates the attempt.
    record = attempt.run_attempt(config)

    # Then: timeout is explicit and the emitted transcript remains available.
    assert record.outcome == attempt.AttemptOutcome.TIMEOUT
    assert record.agent.exit_code is None
    transcript = (config.artifacts_dir / record.artifacts.transcript.path).read_text()
    assert "started" in transcript


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
