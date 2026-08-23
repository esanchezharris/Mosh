import os
import plistlib
import subprocess
from pathlib import Path


ROOT = Path(__file__).parent
GUARD = ROOT / "watch-r8-4b-cont12300.sh"
TRAINER_PLIST = ROOT / "com.mosh.r8-4b-cont12300.plist"
GUARD_PLIST = ROOT / "com.mosh.r8-4b-cont12300-guard.plist"


def _run_check(tmp_path: Path, text: str) -> subprocess.CompletedProcess[str]:
    log = tmp_path / "train.log"
    log.write_text(text)
    return subprocess.run(
        ["/bin/zsh", str(GUARD), "--check-log", str(log)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_guard_accepts_only_finite_losses(tmp_path: Path) -> None:
    assert _run_check(tmp_path, "Iter 10: Train loss 0.103, Learning Rate 1e-5\n").returncode == 0
    assert _run_check(tmp_path, "Iter 10: Train loss nan, Learning Rate 1e-5\n").returncode != 0
    assert _run_check(tmp_path, "Iter 1: Val loss inf, Val took 1s\n").returncode != 0


def test_nonfinite_guard_boots_out_exact_nonrestarting_jobs(tmp_path: Path) -> None:
    log = tmp_path / "train.log"
    alert = tmp_path / "nan-alert.txt"
    exit_alert = tmp_path / "exit-alert.txt"
    calls = tmp_path / "launchctl-calls.txt"
    fake_launchctl = tmp_path / "launchctl"
    log.write_text("Iter 20: Train loss NaN, Learning Rate 1e-5\n")
    fake_launchctl.write_text(
        "#!/bin/zsh\n"
        "if [[ $1 == print ]]; then print 'state = running'; exit 0; fi\n"
        f"print -r -- \"$@\" >> {calls!s}\n"
    )
    fake_launchctl.chmod(0o755)
    env = os.environ.copy()
    env.update(
        {
            "R8_TAIL_LOG": str(log),
            "R8_TAIL_ALERT": str(alert),
            "R8_TAIL_EXIT_ALERT": str(exit_alert),
            "R8_TAIL_LAUNCHCTL_BIN": str(fake_launchctl),
            "R8_TAIL_POLL_SECONDS": "0",
        }
    )

    result = subprocess.run(
        ["/bin/zsh", str(GUARD)], env=env, check=False, timeout=5
    )

    assert result.returncode == 2
    assert calls.read_text().splitlines() == [
        f"bootout gui/{os.getuid()}/com.mosh.r8-4b-cont12300",
        f"bootout gui/{os.getuid()}/com.mosh.r8-4b-cont12300-guard",
    ]
    assert alert.exists()
    assert not exit_alert.exists()


def test_launchd_jobs_explicitly_disable_restart() -> None:
    for path in (TRAINER_PLIST, GUARD_PLIST):
        with path.open("rb") as stream:
            job = plistlib.load(stream)
        assert job["RunAtLoad"] is True
        assert job["KeepAlive"] is False
        assert job["ThrottleInterval"] == 0
