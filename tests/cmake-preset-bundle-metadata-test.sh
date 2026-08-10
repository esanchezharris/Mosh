#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT/CMakePresets.json" <<'PY'
import json
import pathlib
import sys

presets_path = pathlib.Path(sys.argv[1])
presets = json.loads(presets_path.read_text(encoding="utf-8"))["buildPresets"]
by_name = {preset["name"]: preset for preset in presets}

for name in ("macos-arm64-app", "macos-arm64-release-app"):
    targets = by_name[name]["targets"]
    assert "MoshRefreshBundleMetadata" in targets, (
        f"{name} must run the final bundle metadata/signature target after staging"
    )

print("cmake app presets include the final bundle metadata/signature target")
PY
