#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path


REQUIRED_TOP_LEVEL = {
    "schemaVersion",
    "generatedAt",
    "mode",
    "cwd",
    "trunk",
    "stopSentinel",
    "dirtyWorktree",
    "truthSources",
    "threads",
    "prs",
    "backlog",
    "decisions",
    "actionsTaken",
}

VALID_MODES = {"dry-run", "live"}
VALID_PR_CLASSES = {"merge-candidate", "needs-gate", "draft", "parked", "human-gated"}
VALID_RISK_TIERS = {"auto-eligible", "needs-local-gate", "human-gated", "parked"}
VALID_THREAD_ROLES = {
    "coordinator",
    "canonical-input",
    "non-core",
    "duplicate-candidate",
    "parked",
}


def load_json(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as exc:
        raise SystemExit(f"FAIL {path}: invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"FAIL {path}: expected top-level object")
    return data


def require_keys(label: str, data: dict, keys: set[str]) -> None:
    missing = sorted(keys - set(data))
    if missing:
        raise SystemExit(f"FAIL {label}: missing keys: {', '.join(missing)}")


def require_list(label: str, data: dict, key: str) -> list:
    value = data.get(key)
    if not isinstance(value, list):
        raise SystemExit(f"FAIL {label}: {key} must be a list")
    return value


def validate_state(path: Path, schema: dict) -> None:
    state = load_json(path)
    require_keys(str(path), state, REQUIRED_TOP_LEVEL)

    if state["schemaVersion"] != schema.get("properties", {}).get("schemaVersion", {}).get("const"):
        raise SystemExit(f"FAIL {path}: schemaVersion does not match schema const")

    if state["mode"] not in VALID_MODES:
        raise SystemExit(f"FAIL {path}: invalid mode {state['mode']!r}")

    if not isinstance(state["stopSentinel"].get("present"), bool):
        raise SystemExit(f"FAIL {path}: stopSentinel.present must be boolean")

    for item in require_list(str(path), state, "prs"):
        if item.get("classification") not in VALID_PR_CLASSES:
            raise SystemExit(f"FAIL {path}: PR {item.get('number')} has invalid classification")
        if item.get("riskTier") not in VALID_RISK_TIERS:
            raise SystemExit(f"FAIL {path}: PR {item.get('number')} has invalid riskTier")

    for item in require_list(str(path), state, "threads"):
        if item.get("role") not in VALID_THREAD_ROLES:
            raise SystemExit(f"FAIL {path}: thread {item.get('threadId')} has invalid role")

    for item in require_list(str(path), state, "backlog"):
        if item.get("riskTier") not in VALID_RISK_TIERS:
            raise SystemExit(f"FAIL {path}: backlog {item.get('id')} has invalid riskTier")

    if not require_list(str(path), state, "truthSources"):
        raise SystemExit(f"FAIL {path}: truthSources must not be empty")
    if not require_list(str(path), state, "decisions"):
        raise SystemExit(f"FAIL {path}: decisions must not be empty")
    if not require_list(str(path), state, "actionsTaken"):
        raise SystemExit(f"FAIL {path}: actionsTaken must not be empty")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate demo-loop coordinator state snapshots.")
    parser.add_argument(
        "snapshots",
        nargs="*",
        type=Path,
        default=[Path("docs/demo-loop/passes/2026-07-09-pass-000-dry-run.json")],
    )
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path("docs/demo-loop/state.schema.json"),
    )
    args = parser.parse_args()

    schema = load_json(args.schema)
    for snapshot in args.snapshots:
        validate_state(snapshot, schema)
        print(f"PASS {snapshot}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
