from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# Direct invocation (the gate runs `python3 <file>`): put the repo root on sys.path
# so `service.agent_eval` resolves; pytest collection already has it via rootdir.
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))

_NAME = "cli_test"

# The gate runs py tests as `python3 <file>` on a CI interpreter that carries only
# numpy/soundfile — agent_eval needs pydantic + typer (and this file's siblings need
# pytest). Skip LOUDLY there rather than failing the gate, the same posture as
# service/teardown/drummatch/drummatch_test.py and sa3_precompute_parity_test.py:
# this test is MANDATORY on a dev machine, it must never look green by vanishing.
try:
    import pydantic  # noqa: F401
    import pytest  # noqa: F401  (sibling modules this file imports use it at import time)
    import typer  # noqa: F401
except ImportError as exc:  # pragma: no cover — CI-only path
    print(f"SKIP {_NAME}: agent_eval deps not importable ({exc})")
    print("     (this test is MANDATORY on a dev machine — do not let it skip silently in CI)")
    raise SystemExit(0)

from service.agent_eval.attempt_test import _source_repo, _task


def test_attempt_cli_runs_isolated_fixture_through_public_surface(tmp_path: Path) -> None:
    # Given: a ready task bundle and a harmless coding-agent command.
    source, base_commit = _source_repo(tmp_path)
    task = _task(tmp_path, base_commit)
    candidate = tmp_path / "candidate"
    artifacts = tmp_path / "artifacts"
    config_path = tmp_path / "attempt-config.json"
    config_path.write_text(
        json.dumps(
            {
                "task": str(task.manifest_path),
                "source_repo": str(source),
                "candidate_repo": str(candidate),
                "artifacts_dir": str(artifacts),
                "agent_command": [
                    sys.executable,
                    "-c",
                    "from pathlib import Path; Path('new.txt').write_text('new\\n')",
                ],
                "passed_environment": [],
            }
        ),
        encoding="utf-8",
    )

    # When: a caller invokes the installed module surface.
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "service.agent_eval.cli",
            "attempt",
            "--config",
            str(config_path),
        ],
        check=False,
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
    )

    # Then: JSON output and durable artifacts describe the completed attempt.
    assert result.returncode == 0, result.stderr
    record = json.loads(result.stdout)
    assert record["outcome"] == "completed"
    assert record["repository"]["independent_git_dir"] is True
    assert (artifacts / "attempt.json").is_file()
    assert "new.txt" in (artifacts / "patch.diff").read_text()


if __name__ == "__main__":
    # Same reason as schema_test.py. The test takes pytest's `tmp_path` fixture, so
    # direct invocation supplies an equivalent throwaway directory.
    import tempfile

    with tempfile.TemporaryDirectory() as _tmp:
        test_attempt_cli_runs_isolated_fixture_through_public_surface(Path(_tmp))
    print("cli_test: OK (attempt CLI runs an isolated fixture through the public surface)")
