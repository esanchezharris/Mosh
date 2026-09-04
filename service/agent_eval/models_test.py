from __future__ import annotations

import json
from pathlib import Path

import pytest

# Direct invocation (the gate runs `python3 <file>`): put the repo root on sys.path
# so `service.agent_eval` resolves; pytest collection already has it via rootdir.
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))

from service.agent_eval import models


def _write_task(tmp_path: Path, *, status: str = "ready", prompt_sha256: str) -> Path:
    prompt = tmp_path / "PROMPT.md"
    prompt.write_text("Implement the public fixture.\n", encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "task_id": "fixture.public_change",
        "status": status,
        "repository": {
            "name": "fixture",
            "base_commit": "a" * 40,
        },
        "prompt": {
            "path": "PROMPT.md",
            "sha256": prompt_sha256,
        },
        "budget": {
            "wall_seconds": 30,
            "token_limit": 1000,
            "tool_call_limit": 20,
        },
        "public_checks": [
            {
                "id": "fixture-test",
                "command": ["python3", "-m", "pytest", "-q"],
                "timeout_seconds": 10,
            }
        ],
    }
    path = tmp_path / "task.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def test_load_task_returns_verified_prompt_when_manifest_matches(tmp_path: Path) -> None:
    # Given: a ready manifest whose prompt hash is exact.
    prompt_sha = models.sha256_bytes(b"Implement the public fixture.\n")
    path = _write_task(tmp_path, prompt_sha256=prompt_sha)

    # When: the task crosses the manifest boundary.
    loaded = models.load_task(path)

    # Then: callers receive typed, hash-bound task and prompt identities.
    assert loaded.manifest.task_id == "fixture.public_change"
    assert loaded.prompt_text == "Implement the public fixture.\n"
    assert loaded.prompt_sha256 == prompt_sha
    assert len(loaded.manifest_sha256) == 64


def test_load_task_rejects_prompt_when_hash_does_not_match(tmp_path: Path) -> None:
    # Given: a manifest pointing at content different from its registered hash.
    path = _write_task(tmp_path, prompt_sha256="0" * 64)

    # When/Then: parsing refuses the unregistered prompt.
    with pytest.raises(models.TaskManifestError, match="prompt sha256 mismatch"):
        models.load_task(path)


def test_require_ready_rejects_draft_task_before_candidate_execution(tmp_path: Path) -> None:
    # Given: a valid but explicitly draft task bundle.
    prompt_sha = models.sha256_bytes(b"Implement the public fixture.\n")
    loaded = models.load_task(
        _write_task(tmp_path, status="draft", prompt_sha256=prompt_sha)
    )

    # When/Then: the execution boundary fails closed.
    with pytest.raises(models.TaskManifestError, match="task is draft"):
        models.require_ready(loaded)


def test_load_task_preserves_typed_error_when_manifest_file_is_missing(
    tmp_path: Path,
) -> None:
    # Given: a task path whose manifest file does not exist.
    # When/Then: the boundary raises its typed error without a traceback mutation failure.
    with pytest.raises(models.TaskManifestError, match="No such file"):
        models.load_task(tmp_path / "missing.json")


def test_manifest_error_allows_python_to_attach_traceback(tmp_path: Path) -> None:
    # Given: the typed exception used at the file boundary.
    error = models.TaskManifestError(path=tmp_path / "task.json", reason="broken")

    # When: Python's exception machinery attaches traceback state.
    error.__traceback__ = None

    # Then: the original typed fields remain readable.
    assert error.reason == "broken"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
