#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEGACY="${1:-${MOSH_LEGACY_SA3_BUNDLE:-$REPO/_preserved_artifacts/2026-06-08-consolidation/mosh/sa3-colors-steering-data-20260608}}"
CURRENT="${2:-$REPO/service/colors/COLORRACK_DATA}"

python3 - "$LEGACY" "$CURRENT" <<'PY'
import json
import sys
from pathlib import Path

legacy = Path(sys.argv[1])
current = Path(sys.argv[2])

def load_current_colors(path: Path) -> tuple[set[str], set[str]]:
    colors_file = path / "colors.json"
    data = json.loads(colors_file.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        if "colors" in data and isinstance(data["colors"], dict):
            names = {str(k) for k in data["colors"].keys()}
            aliases = {
                str(value.get("source"))
                for value in data["colors"].values()
                if isinstance(value, dict) and value.get("source")
            }
            return names, aliases
        if "colors" in data and isinstance(data["colors"], list):
            names = {str(item.get("name") or item.get("id")) for item in data["colors"] if item}
            return names, set()
        return {str(k) for k in data.keys()}, set()
    raise SystemExit(f"Unsupported current colors shape: {colors_file}")

def load_legacy_colors(path: Path) -> set[str]:
    names: set[str] = set()
    for file in sorted((path / "data").glob("steer_vec_*.npz")):
        names.add(file.stem.removeprefix("steer_vec_"))
    for meta in sorted((path / "data").glob("myaxis_*/meta.json")):
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            names.add(str(data.get("name") or data.get("slug") or meta.parent.name))
        except Exception:
            names.add(meta.parent.name)
    axis = path / "data" / "axis_library.json"
    if axis.exists():
        data = json.loads(axis.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for key, value in data.items():
                names.add(str(key))
                if isinstance(value, dict):
                    for field in ("name", "slug", "label"):
                        if value.get(field):
                            names.add(str(value[field]))
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    for field in ("name", "slug", "label", "id"):
                        if item.get(field):
                            names.add(str(item[field]))
    return {n for n in names if n and n != "None"}

if not current.exists():
    raise SystemExit(f"Missing current Color Rack data: {current}")
if not legacy.exists():
    print("# SA3 Color Rack Compare")
    print(f"legacy_bundle={legacy}")
    print(f"current_runtime={current}")
    print("result=SKIP_LEGACY_BUNDLE_ABSENT")
    print()
    print("Current Color Rack data exists, but the historical preserved SA3 bundle is absent.")
    print("Skipping only the legacy comparison; current SA3/color gates must still run separately.")
    raise SystemExit(0)

legacy_names = load_legacy_colors(legacy)
current_names, current_aliases = load_current_colors(current)
covered = current_names | current_aliases

print("# SA3 Color Rack Compare")
print(f"legacy_bundle={legacy}")
print(f"current_runtime={current}")
print(f"legacy_count={len(legacy_names)}")
print(f"current_count={len(current_names)}")
print()

print("## Current Runtime Colors")
for name in sorted(current_names):
    print(f"- {name}")

print()
print("## Current Source Aliases")
for name in sorted(current_aliases):
    print(f"- {name}")

print()
print("## Legacy Candidates Not Covered By Runtime Name Or Source Alias")
for name in sorted(legacy_names - covered):
    print(f"- {name}")

print()
print("## Shared")
for name in sorted(legacy_names & covered):
    print(f"- {name}")
PY
