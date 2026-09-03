"""The local-brain supervisor must record the SERVER pid and reap the server on
every app-exit path — including the app dying without ever signalling us
(crash/force-quit), which is what orphaned four 17GB mlx servers on 2026-09-01."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# A stand-in "model server": just stays alive until someone terminates it.
SLEEPER = "import time\ntime.sleep(120)"


def _driver_code(pidfile: str) -> str:
    """A process that runs supervise() over the sleeper, like the app's spawn does."""
    return (
        f"import sys; sys.path.insert(0, {str(HERE)!r})\n"
        "import launch_local_brain as l\n"
        f"l.supervise([sys.executable, '-c', {SLEEPER!r}], {pidfile!r}, poll_seconds=0.1)\n"
    )


def _wait(cond, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(0.05)
    return cond()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def _read_pids(pidfile: str):
    data = json.loads(Path(pidfile).read_text())
    return int(data["wrapper"]), int(data["server"])


def test_pidfile_records_wrapper_and_server(tmp_path):
    pidfile = str(tmp_path / "local-brain.pid")
    driver = subprocess.Popen([sys.executable, "-c", _driver_code(pidfile)])
    try:
        assert _wait(lambda: os.path.exists(pidfile)), "pidfile never appeared"
        wrapper, server = _read_pids(pidfile)
        assert wrapper == driver.pid
        assert server != wrapper
        assert _alive(server)
    finally:
        driver.terminate()
        driver.wait(timeout=10)


def test_sigterm_reaps_the_server(tmp_path):
    pidfile = str(tmp_path / "local-brain.pid")
    driver = subprocess.Popen([sys.executable, "-c", _driver_code(pidfile)])
    assert _wait(lambda: os.path.exists(pidfile))
    _, server = _read_pids(pidfile)
    assert _alive(server)
    driver.terminate()  # the app's clean-shutdown path: SIGTERM the wrapper
    driver.wait(timeout=10)
    assert _wait(lambda: not _alive(server)), "server survived wrapper SIGTERM"


def test_parent_death_reaps_the_server(tmp_path):
    # An intermediate parent (standing in for the Mosh app) spawns the supervisor
    # and then dies WITHOUT signalling it. The supervisor must notice the
    # reparenting and terminate the server — no orphaned multi-GB mlx process.
    pidfile = str(tmp_path / "local-brain.pid")
    inter_code = (
        "import subprocess, sys, time\n"
        f"subprocess.Popen([sys.executable, '-c', {_driver_code(pidfile)!r}])\n"
        "time.sleep(1.0)\n"  # let the supervisor record THIS process as its parent
    )
    inter = subprocess.Popen([sys.executable, "-c", inter_code])
    assert _wait(lambda: os.path.exists(pidfile))
    wrapper, server = _read_pids(pidfile)
    assert _alive(server)
    inter.wait(timeout=10)  # parent exits -> supervisor is orphaned
    assert _wait(lambda: not _alive(server)), "server orphaned after parent death"
    assert _wait(lambda: not _alive(wrapper)), "wrapper lingered after reaping"
