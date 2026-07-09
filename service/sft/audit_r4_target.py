#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_R4_SFT_DIR = Path(
    os.environ.get(
        "MOSH_R4_SFT_DIR",
        "/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/"
        "intelligent-banach-25ad5f/service/sft",
    )
)
EXPECTED_TRAIN_ROWS = 12889
EXPECTED_VALID_ROWS = 1650
EXPECTED_OFFSET_ROWS = 155
EXPECTED_RENDER_ROWS = 60


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def jsonl_lines(path: Path) -> list[str]:
    rows: list[str] = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line:
                json.loads(line)
                rows.append(line)
    return rows


def line_hashes(lines: list[str]) -> set[str]:
    return {hashlib.sha256(line.encode("utf-8")).hexdigest() for line in lines}


def read_json_object(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        value = json.load(f)
    if not isinstance(value, dict):
        raise RuntimeError(f"{path} is not a JSON object")
    return value


def latest_training_commands(log_path: Path) -> list[str]:
    if not log_path.exists():
        return []
    commands: list[str] = []
    with log_path.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if line.startswith("$ ") and "mlx_lm lora" in line:
                commands.append(line[2:])
    return commands[-5:]


def active_mlx_lora_commands() -> list[str]:
    proc = subprocess.run(
        ["ps", "-axo", "pid=,command="],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    commands: list[str] = []
    for raw in proc.stdout.splitlines():
        line = raw.strip()
        if "mlx_lm lora" in line and "grep" not in line:
            commands.append(line)
    return commands


def command_points_to_dataset(command: str, base_dir: Path, base_mix: str) -> bool:
    needles = {
        str(base_dir),
        f".sft-data/{base_mix}",
        f"service/sft/.sft-data/{base_mix}",
    }
    return "--data" in command and any(needle in command for needle in needles)


def run_monitor(r4_sft_dir: Path) -> dict[str, Any]:
    script = SCRIPT_DIR / "monitor-r4.sh"
    env = os.environ.copy()
    env["MOSH_R4_SFT_DIR"] = str(r4_sft_dir)
    proc = subprocess.run(
        [str(script), "--no-gate"],
        cwd=SCRIPT_DIR,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    text = proc.stdout.strip()
    parsed: dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        parsed[key.strip()] = value.strip()
    return {
        "command": [str(script), "--no-gate"],
        "exit_code": proc.returncode,
        "stdout": text,
        "stderr": proc.stderr.strip(),
        "parsed": parsed,
    }


def audit(args: argparse.Namespace) -> dict[str, Any]:
    r4_sft_dir = Path(args.r4_sft_dir).expanduser().resolve()
    base_dir = r4_sft_dir / ".sft-data" / args.base_mix
    synth_dir = r4_sft_dir / ".sft-data" / "synth"
    train_path = base_dir / "train.jsonl"
    valid_path = base_dir / "valid.jsonl"
    manifest_path = base_dir / "manifest.json"
    offset_source = synth_dir / "offset-coords.jsonl"
    render_source = synth_dir / "render-routing.jsonl"
    stale_render_source = synth_dir / "r4-renderparam.jsonl"
    train_log_path = r4_sft_dir / ".adapters" / "a3b-r4.train.log"

    missing = [
        str(path)
        for path in (train_path, valid_path, manifest_path, offset_source, render_source)
        if not path.exists()
    ]
    if missing:
        return {
            "created_at": now_iso(),
            "ok": False,
            "restart_decision": "pause-and-investigate",
            "r4_sft_dir": str(r4_sft_dir),
            "base_mix": args.base_mix,
            "missing_paths": missing,
        }

    monitor = run_monitor(r4_sft_dir)
    manifest = read_json_object(manifest_path)
    train_lines = jsonl_lines(train_path)
    valid_lines = jsonl_lines(valid_path)
    offset_lines = jsonl_lines(offset_source)
    render_lines = jsonl_lines(render_source)
    stale_render_rows = len(jsonl_lines(stale_render_source)) if stale_render_source.exists() else None

    train_hashes = line_hashes(train_lines)
    offset_hashes = line_hashes(offset_lines)
    render_hashes = line_hashes(render_lines)

    offset_missing = sorted(offset_hashes - train_hashes)
    render_missing = sorted(render_hashes - train_hashes)
    live_training_commands = active_mlx_lora_commands()
    logged_training_commands = latest_training_commands(train_log_path)
    training_commands = live_training_commands or logged_training_commands
    command_points_to_base = any(
        command_points_to_dataset(command, base_dir, args.base_mix)
        for command in training_commands
    )

    length_filter = manifest.get("lengthFilter")
    length_files = length_filter.get("files") if isinstance(length_filter, dict) else {}
    length_train = length_files.get("train.jsonl") if isinstance(length_files, dict) else {}
    length_valid = length_files.get("valid.jsonl") if isinstance(length_files, dict) else {}
    added = manifest.get("added")
    manifest_checks = {
        "manifest_train_rows_match": manifest.get("train_rows") == EXPECTED_TRAIN_ROWS,
        "manifest_length_train_rows_match": isinstance(length_train, dict)
        and length_train.get("total") == EXPECTED_TRAIN_ROWS
        and length_train.get("kept") == EXPECTED_TRAIN_ROWS,
        "manifest_length_valid_rows_match": isinstance(length_valid, dict)
        and length_valid.get("total") == EXPECTED_VALID_ROWS
        and length_valid.get("kept") == EXPECTED_VALID_ROWS,
        "manifest_offset_source_rows_match": isinstance(added, dict)
        and added.get("offset-coords") == EXPECTED_OFFSET_ROWS,
        "manifest_render_source_rows_match": isinstance(added, dict)
        and added.get("render-routing") == EXPECTED_RENDER_ROWS,
    }

    checks = {
        "monitor_exit_ok": monitor["exit_code"] == 0,
        "training_command_points_to_base_mix": command_points_to_base,
        **manifest_checks,
        "train_rows_match": len(train_lines) == EXPECTED_TRAIN_ROWS,
        "valid_rows_match": len(valid_lines) == EXPECTED_VALID_ROWS,
        "offset_source_rows_match": len(offset_lines) == EXPECTED_OFFSET_ROWS,
        "render_source_rows_match": len(render_lines) == EXPECTED_RENDER_ROWS,
        "offset_rows_present_in_train": not offset_missing,
        "render_rows_present_in_train": not render_missing,
        "stale_r4_renderparam_not_used": stale_render_rows in (0, None),
    }
    ok = all(checks.values())

    return {
        "created_at": now_iso(),
        "ok": ok,
        "restart_decision": "continue-r4" if ok else "pause-and-investigate",
        "restart_policy": {
            "restart_only_if": "v4 target audit proves r4 is training the wrong or incomplete target",
            "do_not_restart_for": [
                "assist demos",
                "evaluator sidecar",
                "r5 prep candidate",
                "cool r5 idea alone",
            ],
        },
        "r4_sft_dir": str(r4_sft_dir),
        "base_mix": args.base_mix,
        "monitor_snapshot": monitor,
        "base_mix_evidence": {
            "manifest": {
                "path": str(manifest_path),
                "sha256": sha256_file(manifest_path),
                "summary": {
                    "train_rows": manifest.get("train_rows"),
                    "base": manifest.get("base"),
                    "added": manifest.get("added"),
                    "lengthFilter": manifest.get("lengthFilter"),
                },
            },
            "training_command": {
                "source": "active_process"
                if live_training_commands
                else "train_log"
                if logged_training_commands
                else "missing",
                "log": str(train_log_path),
                "commands": training_commands,
            },
        },
        "paths": {
            "train": str(train_path),
            "valid": str(valid_path),
            "manifest": str(manifest_path),
            "offset_source": str(offset_source),
            "render_source": str(render_source),
            "stale_render_source": str(stale_render_source),
        },
        "counts": {
            "train": len(train_lines),
            "valid": len(valid_lines),
            "offset_source": len(offset_lines),
            "render_source": len(render_lines),
            "stale_render_source": stale_render_rows,
        },
        "hashes": {
            "train": sha256_file(train_path),
            "valid": sha256_file(valid_path),
            "offset_source": sha256_file(offset_source),
            "render_source": sha256_file(render_source),
            "stale_render_source": sha256_file(stale_render_source)
            if stale_render_source.exists()
            else None,
        },
        "checks": checks,
        "missing_source_hashes": {
            "offset_source": offset_missing[:20],
            "render_source": render_missing[:20],
            "truncated": len(offset_missing) > 20 or len(render_missing) > 20,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Read-only audit for the live a3b-r4 SFT target."
    )
    ap.add_argument("--r4-sft-dir", default=str(DEFAULT_R4_SFT_DIR))
    ap.add_argument("--base-mix", default="s2-mix-v4")
    ap.add_argument("--out", help="optional JSON report path")
    args = ap.parse_args()

    report = audit(args)
    if args.out:
        out = Path(args.out).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
