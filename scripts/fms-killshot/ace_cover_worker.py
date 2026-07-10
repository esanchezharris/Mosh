#!/usr/bin/env python3
"""ACE-Step cover worker for the Used2 asserted-proof spike.

Runs ONLY under the ACE-Step venv (~/AI/ace-step-1.5-mac/.venv) — no
toolkit imports here, and no ACE imports at module top so the request
validation stays importable/testable from the toolkit side. File-in/
file-out (ACE logs freely to stdout, so the JSON contract lives in files):

    <ACE_PY> ace_cover_worker.py --request <in.json> --output <out.json>

The worker fails closed before any model load: request problems and an
ACE git-rev mismatch are structured failures. Per-seed generation errors
are recorded without aborting the remaining seeds.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REQUIRED_TOP_LEVEL = ("version", "aceRoot", "expectedGitRev", "configPath", "device", "saveDir", "audioFormat", "seeds", "params")


def validate_request(request: dict) -> list[str]:
    problems = [f"missing key: {key}" for key in REQUIRED_TOP_LEVEL if key not in request]
    if "seeds" in request:
        seeds = request["seeds"]
        if not isinstance(seeds, list) or not seeds or not all(isinstance(seed, int) and not isinstance(seed, bool) for seed in seeds):
            problems.append("seeds must be a non-empty list of ints")
    params = request.get("params")
    if not isinstance(params, dict):
        if "params" in request:
            problems.append("params must be an object")
        return problems
    if params.get("task_type") != "cover":
        problems.append(f"task_type must be cover, got {params.get('task_type')!r}")
    if params.get("reference_audio") is not None:
        problems.append("reference_audio must be null: voice identity is out of scope for the cover spike")
    src_audio = params.get("src_audio")
    if not src_audio or not Path(str(src_audio)).is_file():
        problems.append(f"src_audio is not an existing file: {src_audio!r}")
    return problems


def _git_rev(ace_root: Path) -> str:
    result = subprocess.run(["git", "-C", str(ace_root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"could not read ACE git rev: {result.stderr.strip()}")
    return result.stdout.strip()


def _generate(request: dict) -> dict:
    ace_root = Path(request["aceRoot"])
    sys.path.insert(0, str(ace_root))
    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    handler = AceStepHandler()
    status, ok = handler.initialize_service(project_root=str(ace_root), config_path=str(request["configPath"]), device=str(request["device"]))
    if not ok:
        raise RuntimeError(f"initialize_service failed: {status}")
    save_dir = Path(request["saveDir"])
    save_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for seed in request["seeds"]:
        entry = {"seed": seed, "ok": False, "audioPath": None, "audioKey": None, "sampleRate": None, "timeCosts": None, "error": None}
        try:
            params = GenerationParams(**request["params"])
            config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[int(seed)], audio_format=str(request["audioFormat"]))
            result = generate_music(handler, None, params, config, save_dir=str(save_dir))
            if not result.success or not result.audios:
                raise RuntimeError(result.error or "generation returned no audio")
            audio = result.audios[0]
            if not audio.get("path"):
                raise RuntimeError("generation saved no audio file")
            entry.update(
                {
                    "ok": True,
                    "audioPath": str(Path(audio["path"]).resolve()),
                    "audioKey": audio.get("key"),
                    "sampleRate": audio.get("sample_rate"),
                    "timeCosts": (result.extra_outputs or {}).get("time_costs"),
                }
            )
        except Exception as error:  # per-seed isolation: record and continue
            entry["error"] = f"{type(error).__name__}: {error}"
        results.append(entry)
    return {"device": getattr(handler, "device", None), "results": results}


def main() -> int:
    parser = argparse.ArgumentParser(description="ACE-Step cover batch worker (runs under the ACE venv)")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    def fail(error: str) -> int:
        payload = {"ok": False, "error": error, "results": []}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"error: {error}", file=sys.stderr)
        return 1

    try:
        request = json.loads(args.request.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return fail(f"unreadable request: {error}")
    problems = validate_request(request)
    if problems:
        return fail("invalid request: " + "; ".join(problems))
    try:
        actual_rev = _git_rev(Path(request["aceRoot"]))
        if actual_rev != request["expectedGitRev"]:
            return fail(f"ACE git rev mismatch: expected {request['expectedGitRev']}, found {actual_rev}")
        payload = _generate(request)
    except Exception as error:  # fatal init/runtime error
        return fail(f"{type(error).__name__}: {error}")
    payload.update({"ok": True, "aceGitRev": actual_rev, "checkpointConfigPath": request["configPath"]})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
