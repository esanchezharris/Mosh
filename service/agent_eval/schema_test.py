from __future__ import annotations

# Direct invocation (the gate runs `python3 <file>`): put the repo root on sys.path
# so `service.agent_eval` resolves; pytest collection already has it via rootdir.
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))

from service.agent_eval import schema


def test_schema_bundle_publishes_every_cross_boundary_contract() -> None:
    # Given: the typed public task, attempt, private-result, and grade records.
    # When: a consumer requests the versioned JSON Schema bundle.
    bundle = schema.schema_bundle()

    # Then: all four externally persisted contracts are available together.
    assert set(bundle.root) == {
        "task_manifest",
        "attempt_record",
        "grade_payload",
        "grade_record",
    }
    assert all(value.get("type") == "object" for value in bundle.root.values())


if __name__ == "__main__":
    # The gate runs `python3 <file>` and its CI python has no pytest (the rest of
    # service/ uses plain asserts + a __main__ runner). pytest was only ever the
    # runner here, never a fixture, so call the test directly.
    test_schema_bundle_publishes_every_cross_boundary_contract()
    print("schema_task_test: OK (schema bundle publishes all four cross-boundary contracts)")
