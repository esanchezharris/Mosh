import os
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).with_name("watch-r8-4b-cont7500.sh")


def run_check(tmp_path: Path, text: str) -> subprocess.CompletedProcess[str]:
    log = tmp_path / "train.log"
    log.write_text(text)
    return subprocess.run(
        ["/bin/zsh", str(SCRIPT), "--check-log", str(log)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_accepts_finite_train_and_validation_losses(tmp_path: Path) -> None:
    result = run_check(
        tmp_path,
        "Iter 10: Train loss 0.103, Learning Rate 1.000e-05\n"
        "Iter 1: Val loss 2.67e-01, Val took 1.0s\n",
    )
    assert result.returncode == 0


def test_rejects_nan_train_loss(tmp_path: Path) -> None:
    result = run_check(tmp_path, "Iter 20: Train loss nan, Learning Rate 1e-5\n")
    assert result.returncode != 0


def test_rejects_infinite_validation_loss(tmp_path: Path) -> None:
    result = run_check(tmp_path, "Iter 1: Val loss inf, Val took 1.0s\n")
    assert result.returncode != 0


def test_nonfinite_loss_boots_out_keepalive_job_before_exit(tmp_path: Path) -> None:
    log = tmp_path / "train.log"
    alert = tmp_path / "nan-alert.txt"
    exit_alert = tmp_path / "exit-alert.txt"
    calls = tmp_path / "launchctl-calls.txt"
    fake_launchctl = tmp_path / "launchctl"
    log.write_text("Iter 30: Train loss NaN, Learning Rate 1e-5\n")
    fake_launchctl.write_text(
        "#!/bin/zsh\n"
        "if [[ $1 == print ]]; then\n"
        "  print 'state = running'\n"
        "  exit 0\n"
        "fi\n"
        f"print -r -- \"$@\" >> {calls!s}\n"
    )
    fake_launchctl.chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "R8_CONT_LOG": str(log),
            "R8_CONT_ALERT": str(alert),
            "R8_CONT_EXIT_ALERT": str(exit_alert),
            "R8_CONT_LAUNCHCTL_BIN": str(fake_launchctl),
        }
    )
    result = subprocess.run(
        ["/bin/zsh", str(SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )

    assert result.returncode == 2
    assert alert.exists()
    assert calls.read_text().splitlines() == [
        f"bootout gui/{os.getuid()}/com.mosh.r8-4b-cont7500",
        f"bootout gui/{os.getuid()}/com.mosh.r8-4b-cont7500-guard",
    ]
    assert not exit_alert.exists()
