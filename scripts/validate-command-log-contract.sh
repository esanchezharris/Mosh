#!/usr/bin/env bash
set -euo pipefail

LOG_PATH="${1:-$HOME/Library/Mosh/session-selftest/mosh-log.jsonl}"
N="${2:-200}"

python3 - "$LOG_PATH" "$N" <<'PY'
import json
import sys
from pathlib import Path

log_path = Path(sys.argv[1]).expanduser()
n = int(sys.argv[2])
required = {
    "ts": int,
    "seq": int,
    "command": str,
    "args": dict,
    "ok": bool,
    "undoable": bool,
}
expected_commands = {
    "create_track",
    "import_clip",
    "set_transport",
    "undo",
    "redo",
    "add_render_layer",
    "render_layer",
    "accept_render",
    "reject_render",
    "export_audio",
}

if not log_path.exists():
    raise SystemExit(f"FAIL: missing command log: {log_path}")

lines = [line.strip() for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
if not lines:
    raise SystemExit(f"FAIL: no command records in {log_path}")

subset = lines[-n:]
errors: list[str] = []
commands: set[str] = set()
last_seq = None
seq_decreases = 0

for offset, line in enumerate(subset, start=len(lines) - len(subset) + 1):
    try:
        record = json.loads(line)
    except Exception as exc:
        errors.append(f"line {offset}: JSON parse error: {exc}")
        continue

    for key, typ in required.items():
        if key not in record:
            errors.append(f"line {offset}: missing {key}")
            continue
        if not isinstance(record[key], typ):
            errors.append(f"line {offset}: {key} has type {type(record[key]).__name__}, expected {typ.__name__}")

    if isinstance(record.get("seq"), int):
        if record["seq"] < 1:
            errors.append(f"line {offset}: seq must be positive")
        if last_seq is not None and record["seq"] <= last_seq:
            seq_decreases += 1
        last_seq = record["seq"]

    command = record.get("command")
    if isinstance(command, str):
        commands.add(command)

missing_commands = sorted(expected_commands - commands)
if missing_commands:
    errors.append("missing expected commands in checked window: " + ", ".join(missing_commands))

if errors:
    print(f"FAIL: {len(errors)} issue(s) in latest {len(subset)} records from {log_path}")
    for error in errors:
        print(error)
    raise SystemExit(1)

print(f"PASS: checked {len(subset)} command records in {log_path}")
print("commands=" + ",".join(sorted(commands)))
if seq_decreases:
    print(f"note: observed {seq_decreases} sequence decrease(s); seq is treated as process-local in append-only selftest logs")
PY
