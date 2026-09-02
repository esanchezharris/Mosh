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
    raise SystemExit(pytest.main([__file__, "-q"]))

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
