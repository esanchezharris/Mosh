#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import audit_r4_target
import build_evaluator_sidecar


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OUT_DIR = SCRIPT_DIR / ".sft-data" / "s2-mix-v5-prep"
DEFAULT_FILTER_PY = Path("/Users/emiliosanchez-harris/Library/Mosh/venvs/sft/bin/python")
DEFAULT_MODEL = Path(
    "/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        value = json.load(f)
    return value if isinstance(value, dict) else {}


def jsonl_lines(path: Path) -> list[str]:
    rows: list[str] = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line:
                json.loads(line)
                rows.append(line)
    return rows


def count_jsonl(path: Path) -> int:
    return len(jsonl_lines(path))


def validate_assist_rows(path: Path, expected: int) -> list[str]:
    rows = jsonl_lines(path)
    if len(rows) != expected:
        raise RuntimeError(f"expected {expected} assist rows, found {len(rows)}")
    for index, line in enumerate(rows, start=1):
        row = json.loads(line)
        messages = row.get("messages")
        if not isinstance(messages, list) or len(messages) != 3:
            raise RuntimeError(f"assist row {index} does not have 3 messages")
        roles = [msg.get("role") for msg in messages if isinstance(msg, dict)]
        if roles != ["system", "user", "assistant"]:
            raise RuntimeError(f"assist row {index} roles are {roles}")
        assistant = messages[2].get("content")
        if not isinstance(assistant, str):
            raise RuntimeError(f"assist row {index} assistant content is not a string")
        parsed = json.loads(assistant)
        if not isinstance(parsed, dict):
            raise RuntimeError(f"assist row {index} assistant JSON is not an object")
    return rows


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def default_filter_python() -> Path:
    env_value = os.environ.get("SFT_PY")
    if env_value:
        return Path(env_value).expanduser()
    if DEFAULT_FILTER_PY.exists():
        return DEFAULT_FILTER_PY
    return Path(sys.executable)


def model_from_base_manifest(base_manifest: dict[str, Any]) -> str:
    length_filter = base_manifest.get("lengthFilter")
    if isinstance(length_filter, dict):
        model = length_filter.get("model")
        if isinstance(model, str) and model:
            return model
    return str(DEFAULT_MODEL)


def run_filter(filter_python: Path, model: str, out_dir: Path, max_seq: int) -> dict[str, Any]:
    cmd = [
        str(filter_python),
        str(SCRIPT_DIR / "filter_by_length.py"),
        "--model",
        model,
        "--data",
        str(out_dir),
        "--max-seq",
        str(max_seq),
    ]
    proc = subprocess.run(
        cmd,
        cwd=SCRIPT_DIR,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return {
        "command": cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
    }


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    r4_sft_dir = Path(args.r4_sft_dir).expanduser().resolve()
    out_dir = Path(args.out).expanduser().resolve()
    assist_path = Path(args.assist).expanduser().resolve()
    base_dir = r4_sft_dir / ".sft-data" / args.base_mix
    base_manifest_path = base_dir / "manifest.json"
    base_manifest = read_json(base_manifest_path)
    train_source = base_dir / "train.jsonl"
    valid_source = base_dir / "valid.jsonl"

    audit_report = audit_r4_target.audit(
        SimpleNamespace(r4_sft_dir=str(r4_sft_dir), base_mix=args.base_mix)
    )
    if not audit_report.get("ok") and not args.allow_failed_audit:
        raise RuntimeError("r4 target audit failed; refusing to build r5 from invalid base")

    assist_rows = validate_assist_rows(assist_path, args.expected_assist_rows)
    if out_dir.exists():
        entries = {path.name for path in out_dir.iterdir()}
        audit_only = entries.issubset({"r4_target_audit.json"})
        if args.force:
            shutil.rmtree(out_dir)
            out_dir.mkdir(parents=True)
        elif not audit_only:
            raise RuntimeError(f"{out_dir} already exists; pass --force to replace it")
    else:
        out_dir.mkdir(parents=True)
    (out_dir / "r4_target_audit.json").write_text(
        json.dumps(audit_report, indent=2) + "\n",
        encoding="utf-8",
    )

    shutil.copy2(train_source, out_dir / "train.jsonl")
    shutil.copy2(valid_source, out_dir / "valid.jsonl")
    with (out_dir / "train.jsonl").open("a", encoding="utf-8") as f:
        for line in assist_rows:
            f.write(line + "\n")

    sidecar_path = out_dir / "evaluator_sidecar.jsonl"
    sidecar_sources = [Path(p).expanduser().resolve() for p in args.evaluator_source]
    if not sidecar_sources:
        sidecar_sources = [Path(p).expanduser().resolve() for p in build_evaluator_sidecar.default_sources()]
    sidecar_manifest = build_evaluator_sidecar.build_sidecar(
        sidecar_sources,
        sidecar_path,
        args.source_run,
        now_iso(),
    )

    manifest_path = out_dir / "manifest.json"
    pre_filter_counts = {
        "train": count_jsonl(out_dir / "train.jsonl"),
        "valid": count_jsonl(out_dir / "valid.jsonl"),
    }
    manifest: dict[str, Any] = {
        "created_at": now_iso(),
        "name": "s2-mix-v5-prep",
        "purpose": "ready-to-run r5 candidate only; not an active training launch",
        "base_mix_source": {
            "name": args.base_mix,
            "dir": str(base_dir),
            "train": str(train_source),
            "valid": str(valid_source),
            "manifest": str(base_manifest_path),
        },
        "base_hashes": {
            "train": sha256_file(train_source),
            "valid": sha256_file(valid_source),
            "manifest": sha256_file(base_manifest_path) if base_manifest_path.exists() else None,
        },
        "assist_demo_rows": len(assist_rows),
        "assist_demo_source": {
            "path": str(assist_path),
            "sha256": sha256_file(assist_path),
        },
        "evaluator_sidecar": {
            "path": str(sidecar_path),
            "manifest": str(sidecar_path.with_suffix(sidecar_path.suffix + ".manifest.json")),
            "rows": sidecar_manifest["rows_written"],
            "gemini_enabled": False,
        },
        "r4_status_snapshot": audit_report.get("monitor_snapshot"),
        "r4_target_audit": audit_report,
        "restart_policy": audit_report.get("restart_policy"),
        "base_manifest": base_manifest,
        "pre_filter_counts": pre_filter_counts,
        "expected_pre_filter_counts": {
            "train": 12889 + len(assist_rows),
            "valid": 1650,
        },
        "post_filter_counts": None,
        "final_hashes": None,
        "filter_run": None,
    }
    write_manifest(manifest_path, manifest)

    if not args.skip_filter:
        filter_run = run_filter(
            Path(args.filter_python).expanduser(),
            args.model,
            out_dir,
            args.max_seq,
        )
        if filter_run["exit_code"] != 0:
            manifest["filter_run"] = filter_run
            write_manifest(manifest_path, manifest)
            raise RuntimeError("filter_by_length.py failed; manifest records stderr")
        manifest = read_json(manifest_path)
        manifest["filter_run"] = filter_run

    manifest["post_filter_counts"] = {
        "train": count_jsonl(out_dir / "train.jsonl"),
        "valid": count_jsonl(out_dir / "valid.jsonl"),
    }
    manifest["final_hashes"] = {
        "train": sha256_file(out_dir / "train.jsonl"),
        "valid": sha256_file(out_dir / "valid.jsonl"),
        "evaluator_sidecar": sha256_file(sidecar_path),
    }
    write_manifest(manifest_path, manifest)
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Prepare s2-mix-v5-prep from live r4 data without starting MLX jobs."
    )
    ap.add_argument("--r4-sft-dir", default=str(audit_r4_target.DEFAULT_R4_SFT_DIR))
    ap.add_argument("--base-mix", default="s2-mix-v4")
    ap.add_argument("--assist", default=str(SCRIPT_DIR / "assist_demonstrations.jsonl"))
    ap.add_argument("--out", default=str(DEFAULT_OUT_DIR))
    ap.add_argument("--expected-assist-rows", type=int, default=15)
    ap.add_argument("--filter-python", default=str(default_filter_python()))
    ap.add_argument("--model", default=None)
    ap.add_argument("--max-seq", type=int, default=4096)
    ap.add_argument("--source-run", default="r5-prep")
    ap.add_argument("--evaluator-source", action="append", default=[])
    ap.add_argument("--skip-filter", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--allow-failed-audit", action="store_true")
    args = ap.parse_args()

    base_manifest = read_json(
        Path(args.r4_sft_dir).expanduser().resolve()
        / ".sft-data"
        / args.base_mix
        / "manifest.json"
    )
    if args.model is None:
        args.model = model_from_base_manifest(base_manifest)

    try:
        manifest = prepare(args)
    except Exception as exc:
        print(f"prepare_r5_prep failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
