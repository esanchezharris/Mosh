#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${MOSH_APP_BIN:-$REPO/build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}"
STAMP="$(date +%Y%m%d-%H%M%S)"
EVID="${MOSH_EVID:-$REPO/_preserved_artifacts/$(date +%F)-engine-contract-selection/$STAMP}"
SESSION_LOG="$HOME/Library/Mosh/session-selftest-engine-contract/mosh-log.jsonl"

if [[ ! -x "$APP" ]]; then
  echo "[engine-contract-selection-gate] missing Mosh app binary: $APP" >&2
  exit 2
fi

mkdir -p "$EVID"

run_case() {
  local name="$1"
  shift
  echo "[engine-contract-selection-gate] RUN $name" >&2
  (cd "$REPO" && "$@") > "$EVID/$name.log" 2>&1
  if [[ -f "$SESSION_LOG" ]]; then
    cp "$SESSION_LOG" "$EVID/$name-command-log.jsonl"
  fi
}

run_case default env MOSH_NO_AUDIO=1 MOSH_REPO_ROOT="$REPO" "$APP" -ApplePersistenceIgnoreState YES --selftest-engine-contract
run_case tracktion env MOSH_NO_AUDIO=1 MOSH_REPO_ROOT="$REPO" MOSH_ENGINE_BACKEND=tracktion "$APP" -ApplePersistenceIgnoreState YES --selftest-engine-contract
run_case maolan env MOSH_NO_AUDIO=1 MOSH_REPO_ROOT="$REPO" MOSH_ENGINE_BACKEND=maolan "$APP" -ApplePersistenceIgnoreState YES --selftest-engine-contract

python3 - "$EVID" <<'PY'
import json
import re
import sys
from pathlib import Path

evid = Path(sys.argv[1])
cases = []
status = "PASS"
for name in ("default", "tracktion", "maolan"):
    log_path = evid / f"{name}.log"
    log = log_path.read_text(encoding="utf-8", errors="replace")
    matches = re.findall(r"===== (\d+)/(\d+) .*checks passed, (\d+) failed =====", log)
    if not matches:
        cases.append({"name": name, "status": "FAIL", "error": "missing selftest summary", "log": str(log_path)})
        status = "FAIL"
        continue
    passed, total, failed = map(int, matches[-1])
    case_status = "PASS" if failed == 0 and passed == total else "FAIL"
    if case_status != "PASS":
        status = "FAIL"
    case = {
        "name": name,
        "status": case_status,
        "passed": passed,
        "total": total,
        "failed": failed,
        "log": str(log_path),
    }
    command_log = evid / f"{name}-command-log.jsonl"
    if command_log.exists():
        case["command_log"] = str(command_log)
    cases.append(case)

summary = {
    "status": status,
    "gate": "engine-contract-selection",
    "artifact_dir": str(evid),
    "cases": cases,
    "artifacts": {
        "summary": str(evid / "summary.json"),
        "default_log": str(evid / "default.log"),
        "tracktion_log": str(evid / "tracktion.log"),
        "maolan_log": str(evid / "maolan.log"),
    },
}
(evid / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
if status != "PASS":
    raise SystemExit(1)
PY

echo "[engine-contract-selection-gate] PASS evidence=$EVID"
