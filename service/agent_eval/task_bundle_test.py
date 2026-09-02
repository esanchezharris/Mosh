from __future__ import annotations

from pathlib import Path

import pytest

# Direct invocation (the gate runs `python3 <file>`): put the repo root on sys.path
# so `service.agent_eval` resolves; pytest collection already has it via rootdir.
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))

from service.agent_eval.models import (
    TaskManifestError,
    TaskStatus,
    load_task,
    require_ready,
)


def test_duplicate_time_bundle_is_hash_bound_but_refuses_execution_while_draft() -> None:
    # Given: the repository's public Duplicate Time task bundle.
    task_path = Path(__file__).parent / "tasks" / "duplicate_time" / "task.json"

    # When: its manifest and prompt identity are parsed.
    task = load_task(task_path)

    # Then: it is structurally valid but cannot launch before behavior is frozen.
    assert task.manifest.task_id == "mosh.duplicate_time"
    assert task.manifest.status == TaskStatus.DRAFT
    with pytest.raises(TaskManifestError, match="task is draft"):
        require_ready(task)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
