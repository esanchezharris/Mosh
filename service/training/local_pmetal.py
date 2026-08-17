"""The real local LoRA trainer — drives the bundled `pmetal train-audio` CLI.

Until now `trainer_job.py` had exactly two backends: `fake` (a JSON stub) and
`remote_http` (a rented GPU). This is the third: an actual fine-tune on this
Mac, producing a `.safetensors` adapter the render path can load unmodified.

## Shape of a run

    phase "precompute"  clips + captions -> latents + conditioning   (in-process, MLX)
    phase "training"    pmetal train-audio                            (subprocess)
    phase "exporting"   collect checkpoints + the final mosh_lora     (filesystem)

## Things that are load-bearing and non-obvious

**One invocation, not many.** pmetal auto-chunks itself into <=600-step child
processes to stay under a real macOS Metal per-process resource-ID ceiling
(~700-750 steps), resuming bit-exactly between legs. That orchestration is
test-proven inside pmetal; re-implementing it here would be a second, unproven
copy of the subtlest code in the trainer.

**Progress comes off stderr, not stdout,** and through `tracing_subscriber`'s
formatter, so lines carry a timestamp/level prefix and ANSI colour:

    2026-08-16T20:54:00.123456Z  INFO pmetal_trainer::...: step=100 loss=0.81 lr=1.000e-4 (1.072s/step)

A `startswith("step=")` parser reads zero progress and the job looks hung. We
match with a tolerant regex, and prefer the two structured feeds that survive
the formatter changing under us: `probe_history.jsonl` and the appearance of
`step_<N>/` directories.

**Cancel must kill the process GROUP.** The parent spawns child legs, so
`Popen.kill()` orphans a running leg — a ~31GB orphan holding the GPU. We start
the trainer in its own session and signal the group.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# Tolerant of the tracing prefix, the ANSI codes, and a missing s/step suffix.
_RE_STEP = re.compile(r"\bstep=(\d+)\s+loss=([0-9.eE+-]+)(?:\s+lr=\S+)?(?:\s+\(([0-9.]+)s/step\))?")
_RE_PROBE = re.compile(r"\bprobe step=(\d+)\s+mean_loss=([0-9.eE+-]+)")
_RE_LEG = re.compile(r"\bauto-chunk: leg (\d+)/(\d+)")

_DEFAULT_BASE_DIT = "~/.cache/pmetal-sa3-spike/dit_medium_BASE_f16.safetensors"
_MIN_BASE_DIT_BYTES = 2 * (1 << 30)  # a real SA3-medium DiT is ~2.7GB


def trainer_bin() -> str | None:
    """Resolve the trainer binary.

    An explicit `MOSH_TRAINER_BIN` is EXCLUSIVE: if it is set, that path is the
    only candidate. Falling back to a bundled binary when the user named a
    specific one would silently train with something other than what they
    asked for — the sort of surprise that costs an hour of confusion later, and
    it makes "point at a debug build" impossible to trust.
    """
    env = os.environ.get("MOSH_TRAINER_BIN", "").strip()
    if env:
        p = Path(os.path.expanduser(env))
        return str(p) if p.is_file() and os.access(p, os.X_OK) else None
    here = Path(__file__).resolve()
    for c in (
        # Inside Mosh.app: service/ lives in Resources/, the trainer in Helpers/.
        here.parents[2] / "Helpers" / "trainer" / "pmetal",
        # Dev tree: <repo>/resources/trainer/pmetal
        here.parents[2] / "resources" / "trainer" / "pmetal",
    ):
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def base_dit_path() -> str | None:
    p = Path(os.path.expanduser(os.environ.get("MOSH_SA3_BASE_DIT", "") or _DEFAULT_BASE_DIT))
    return str(p) if p.is_file() else None


def readiness() -> tuple[bool, list[str]]:
    """(ready, blockers). Blockers are user-facing strings naming the fix.

    Returned through /training/capabilities so the UI can explain what is
    missing instead of offering a Train button that errors on click.
    """
    blockers: list[str] = []

    binp = trainer_bin()
    if not binp:
        blockers.append("Trainer binary not found (set MOSH_TRAINER_BIN, or run service/training/setup-trainer.sh)")
    else:
        # MLX's Metal shader library must sit beside the binary or pmetal will
        # reach for the network on first train.
        if not (Path(binp).parent / "mlx.metallib").is_file():
            blockers.append("mlx.metallib missing next to the trainer binary")

    base = base_dit_path()
    if not base:
        blockers.append("SA3 base checkpoint not found (set MOSH_SA3_BASE_DIT, or run service/training/setup-trainer.sh)")
    elif Path(base).stat().st_size < _MIN_BASE_DIT_BYTES:
        # A truncated/LFS-pointer checkpoint trains happily and produces garbage.
        blockers.append(f"SA3 base checkpoint looks truncated ({Path(base).stat().st_size / (1<<30):.1f}GB, expected ~2.7GB)")

    try:
        from sa3 import engine as E
        if not E.engine_available():
            blockers.append("SA3 engine unavailable — precompute needs the MLX venv (MOSH_ENABLE_SA3=1)")
    except Exception:  # noqa: BLE001
        blockers.append("SA3 engine unavailable — precompute needs the MLX venv (MOSH_ENABLE_SA3=1)")

    return (not blockers), blockers


def available() -> bool:
    return readiness()[0]


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write progress so a concurrent reader never sees a half-written file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _scan_checkpoints(run_dir: Path) -> list[dict[str, Any]]:
    """Every `step_<N>/` that carries an exported adapter, oldest first."""
    out: list[dict[str, Any]] = []
    for d in sorted(run_dir.glob("step_*"), key=lambda p: int(p.name.split("_")[-1]) if p.name.split("_")[-1].isdigit() else 0):
        step = d.name.split("_")[-1]
        if not step.isdigit():
            continue
        mosh = d / "mosh_lora.safetensors"
        out.append({
            "step": int(step),
            "dir": str(d),
            "moshLora": str(mosh) if mosh.is_file() else None,
            "createdAt": datetime.fromtimestamp(d.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
        })
    return out


def _read_probes(run_dir: Path) -> list[dict[str, Any]]:
    p = run_dir / "probe_history.jsonl"
    if not p.is_file():
        return []
    out = []
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:  # noqa: BLE001 — a partially-written last line is normal
            continue
    return out


def build_argv(binp: str, base_model: str, manifest: str, run_dir: str,
               cfg: dict[str, Any]) -> list[str]:
    """The trainer command line.

    Deliberately does NOT pass --ot-coupling or --inpainting-mix: both measured
    WORSE in matched single-variable A/Bs (-0.04 and -0.10 taste_sim, the former
    at ~3.5x the step time), despite the upstream reference recipe hardcoding
    ot_coupling ON. See pmetal docs/training/stable-audio-3.md.
    """
    return [
        binp, "train-audio",
        "--base-model", base_model,
        "--dataset", manifest,
        "--output", run_dir,
        "--lora-r", str(int(cfg.get("rank", 16))),
        "--lora-alpha", str(float(cfg.get("alpha", cfg.get("rank", 16)))),
        "--use-dora",
        "--dtype", str(cfg.get("dtype", "bf16")),
        "--learning-rate", str(float(cfg.get("lr", 1e-4))),
        "--weight-decay", str(float(cfg.get("weight_decay", 0.01))),
        "--seed", str(int(cfg.get("seed", 42))),
        "--batch-size", str(int(cfg.get("batch_size", 2))),
        "--grad-accum", str(int(cfg.get("grad_accum", 2))),
        "--steps", str(int(cfg.get("steps", 1200))),
        "--log-every", "10",
        "--checkpoint-every", str(int(cfg.get("checkpoint_every", 200))),
        "--probe-every", str(int(cfg.get("probe_every", 100))),
        "--export-mosh",
    ]


def run_training(argv: list[str], run_dir: Path, total_steps: int,
                 should_cancel: Callable[[], bool] | None = None,
                 on_progress: Callable[[dict[str, Any]], None] | None = None) -> int:
    """Run the trainer to completion. Returns its exit code.

    Streams stderr for step/probe/leg lines, mirrors state into
    `<run_dir>/progress.json`, and cancels by process GROUP.
    """
    progress_path = run_dir / "progress.json"
    state: dict[str, Any] = {
        "phase": "training", "step": 0, "totalSteps": total_steps,
        "loss": None, "sPerStep": None, "etaSeconds": None,
        "leg": None, "legs": None, "checkpoints": [], "probes": [],
        "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    def flush() -> None:
        state["checkpoints"] = _scan_checkpoints(run_dir)
        state["probes"] = _read_probes(run_dir)
        _atomic_write_json(progress_path, state)
        if on_progress:
            on_progress(dict(state))

    flush()
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        start_new_session=True,  # own process group, so cancel reaches child legs
    )

    # Parse stderr on its OWN thread. Iterating `proc.stderr` blocks until the
    # next line arrives, and pmetal is legitimately silent for long stretches —
    # during model load, during precompute, and between --log-every lines (tens
    # of seconds at real step times). Polling cancel inside that loop means Stop
    # is ignored until the trainer happens to speak, which in the quiet phases
    # is effectively never.
    def _pump() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            m = _RE_STEP.search(line)
            if m:
                state["step"] = int(m.group(1))
                state["loss"] = float(m.group(2))
                if m.group(3):
                    state["sPerStep"] = float(m.group(3))
                    remaining = max(0, total_steps - state["step"])
                    state["etaSeconds"] = round(remaining * state["sPerStep"])
            elif (mp := _RE_PROBE.search(line)):
                state["lastProbe"] = {"step": int(mp.group(1)), "meanLoss": float(mp.group(2))}
            elif (ml := _RE_LEG.search(line)):
                state["leg"], state["legs"] = int(ml.group(1)), int(ml.group(2))

    pump = threading.Thread(target=_pump, daemon=True)
    pump.start()

    cancelled = False
    try:
        while True:
            code = proc.poll()
            if code is not None:
                break
            if should_cancel and should_cancel():
                _terminate_group(proc)
                cancelled = True
                code = 130
                break
            flush()
            time.sleep(0.5)
    finally:
        if proc.poll() is None:
            _terminate_group(proc)
        pump.join(timeout=2.0)

    if cancelled:
        state["phase"] = "cancelled"
        flush()
        return 130

    state["phase"] = "ready" if code == 0 else "error"
    state["exitCode"] = code
    flush()
    return code


def _terminate_group(proc: subprocess.Popen) -> None:
    """SIGTERM the whole group, then SIGKILL after a grace period.

    Killing only `proc` orphans the current auto-chunk leg, which keeps holding
    ~31GB and the GPU until it finishes on its own.
    """
    try:
        pgid = os.getpgid(proc.pid)
    except Exception:  # noqa: BLE001 — already gone
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except Exception:  # noqa: BLE001
        return
    deadline = time.time() + 5.0
    while time.time() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        pass
