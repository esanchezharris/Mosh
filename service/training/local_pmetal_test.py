"""Tests for the local pmetal trainer backend.

The progress-parsing fixtures below are REAL lines captured from a live
training run (ANSI colour codes and tracing prefix included, byte for byte).
That matters: a parser written against idealised `step=N loss=F` lines reads
zero progress from real output and the job silently looks hung.
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # service/training/
import local_pmetal as LP  # noqa: E402

# Verbatim from ~/mosh-loras/work/ken6900-train.log — do NOT tidy these up.
REAL_LEG = (
    "\x1b[2m2026-08-16T05:09:43.300887Z\x1b[0m \x1b[32m INFO\x1b[0m "
    "\x1b[2mpmetal::commands::train_audio\x1b[0m\x1b[2m:\x1b[0m auto-chunk: leg 1/14 -> step 600"
)
REAL_PROBE = (
    "\x1b[2m2026-08-16T05:09:51.213665Z\x1b[0m \x1b[32m INFO\x1b[0m "
    "\x1b[2mpmetal_trainer::audio_diffusion::train_loop\x1b[0m\x1b[2m:\x1b[0m "
    "probe step=250 mean_loss=0.903025 (7.02s)"
)
REAL_STEP = (
    "\x1b[2m2026-08-16T05:19:19.207234Z\x1b[0m \x1b[32m INFO\x1b[0m "
    "\x1b[2mpmetal_trainer::audio_diffusion::train_loop\x1b[0m\x1b[2m:\x1b[0m "
    "step=1200 loss=0.645397 lr=1.000e-4 (18.621s/step)"
)


def test_step_line_parses_from_real_tracing_output():
    m = LP._RE_STEP.search(REAL_STEP)
    assert m, "the real stderr format must parse — a naive startswith('step=') reads nothing"
    assert int(m.group(1)) == 1200
    assert abs(float(m.group(2)) - 0.645397) < 1e-9
    assert abs(float(m.group(3)) - 18.621) < 1e-9


def test_probe_and_leg_lines_parse_from_real_output():
    mp = LP._RE_PROBE.search(REAL_PROBE)
    assert mp and int(mp.group(1)) == 250 and abs(float(mp.group(2)) - 0.903025) < 1e-9
    ml = LP._RE_LEG.search(REAL_LEG)
    assert ml and (int(ml.group(1)), int(ml.group(2))) == (1, 14)


def test_step_line_without_s_per_step_still_parses():
    # Not every log line carries the timing suffix.
    m = LP._RE_STEP.search("INFO whatever: step=7 loss=1.5")
    assert m and int(m.group(1)) == 7 and m.group(3) is None


def test_probe_line_is_not_mistaken_for_a_step_line():
    # "probe step=250" contains "step=250"; if the step regex wins, the UI shows
    # a step counter that jumps backwards every probe.
    assert LP._RE_STEP.search(REAL_PROBE) is None, "probe lines must not match the step regex"


def test_argv_omits_the_settings_that_measured_worse():
    argv = LP.build_argv("/bin/pmetal", "/base.safetensors", "/m.json", "/run", {"steps": 1200})
    assert "--ot-coupling" not in argv, "ot_coupling measured -0.04/-0.10 at ~3.5x the step time"
    assert "--inpainting-mix" not in argv, "inpainting_mix is a train/serve mismatch"
    assert "--export-mosh" in argv, "without this there is no adapter the render path can load"
    assert "--use-dora" in argv
    assert argv[argv.index("--steps") + 1] == "1200"


def test_argv_defaults_to_the_memory_safe_batch():
    argv = LP.build_argv("/bin/pmetal", "/b", "/m", "/r", {})
    b = int(argv[argv.index("--batch-size") + 1])
    a = int(argv[argv.index("--grad-accum") + 1])
    assert (b, a) == (2, 2), "batch 4 is ~49GB and thrashes a 64GB machine"


def test_readiness_reports_actionable_blockers_when_nothing_is_installed() -> None:
  with tempfile.TemporaryDirectory() as td:
    tmp_path = Path(td)
    os.environ["MOSH_TRAINER_BIN"] = str(tmp_path / "nope")
    os.environ["MOSH_SA3_BASE_DIT"] = str(tmp_path / "nope.safetensors")
    ready, blockers = LP.readiness()
    assert not ready
    assert any("Trainer binary" in b for b in blockers)
    assert any("base checkpoint" in b for b in blockers)
    # Every blocker must name a fix, not just a fact.
    assert all(("MOSH_" in b) or ("setup-trainer" in b) or ("MLX" in b) for b in blockers), blockers


def test_readiness_rejects_a_truncated_base_checkpoint() -> None:
  with tempfile.TemporaryDirectory() as td:
    tmp_path = Path(td)
    # An LFS pointer or half-downloaded checkpoint trains happily and produces
    # garbage — catching it here is much cheaper than after a 20-minute run.
    binp = tmp_path / "pmetal"
    binp.write_text("#!/bin/sh\n")
    binp.chmod(0o755)
    (tmp_path / "mlx.metallib").write_bytes(b"x")
    small = tmp_path / "dit.safetensors"
    small.write_bytes(b"0" * 1024)
    os.environ["MOSH_TRAINER_BIN"] = str(binp)
    os.environ["MOSH_SA3_BASE_DIT"] = str(small)
    _, blockers = LP.readiness()
    assert any("truncated" in b for b in blockers), blockers


def test_cancel_kills_the_whole_process_group() -> None:
  with tempfile.TemporaryDirectory() as td:
    tmp_path = Path(td)
    """A cancelled run must leave no orphan.

    The trainer spawns child legs; killing only the parent leaves a child
    holding ~31GB and the GPU. This spawns a parent that forks a long-lived
    child, cancels, and asserts BOTH are gone.
    """
    parent = tmp_path / "parent.sh"
    parent.write_text(
        "#!/bin/sh\n"
        f"sh -c 'echo child > {tmp_path}/child.pid; sleep 120' &\n"
        "echo $! > " + str(tmp_path / "child_pid.txt") + "\n"
        "echo 'auto-chunk: leg 1/2' >&2\n"
        "sleep 120\n"
    )
    parent.chmod(0o755)

    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cancelled = {"v": False}

    result: dict[str, int] = {}

    def go() -> None:
        result["code"] = LP.run_training([str(parent)], run_dir, total_steps=10,
                                         should_cancel=lambda: cancelled["v"])

    t = threading.Thread(target=go, daemon=True)
    t.start()
    time.sleep(1.5)
    cancelled["v"] = True
    t.join(timeout=20)

    assert not t.is_alive(), "cancel did not return within 20s"
    child_pid_file = tmp_path / "child_pid.txt"
    if child_pid_file.is_file():
        pid = int(child_pid_file.read_text().strip())
        alive = True
        try:
            os.kill(pid, 0)
        except OSError:
            alive = False
        assert not alive, f"child leg {pid} survived cancel — killpg did not reach it"


def test_progress_json_is_written_and_parseable() -> None:
  with tempfile.TemporaryDirectory() as td:
    tmp_path = Path(td)
    emitter = tmp_path / "emit.sh"
    emitter.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' 'INFO x: auto-chunk: leg 1/1' >&2\n"
        "printf '%s\\n' 'INFO x: step=5 loss=0.5 lr=1e-4 (2.0s/step)' >&2\n"
    )
    emitter.chmod(0o755)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    code = LP.run_training([str(emitter)], run_dir, total_steps=10)
    assert code == 0
    import json
    st = json.loads((run_dir / "progress.json").read_text())
    assert st["step"] == 5
    assert st["legs"] == 1
    assert st["phase"] == "ready"
    # 5 of 10 steps left at 2.0 s/step
    assert st["etaSeconds"] == 10


def main() -> None:
    saved = {k: os.environ.get(k) for k in ("MOSH_TRAINER_BIN", "MOSH_SA3_BASE_DIT")}
    fails = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                fails.append(f"{name}: {type(exc).__name__}: {exc}")
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    for f in fails:
        print("FAIL", f)
    if fails:
        sys.exit(1)
    print("local_pmetal_test: OK (real-stderr parsing, argv policy, readiness blockers, killpg cancel, progress.json)")


if __name__ == "__main__":
    main()
