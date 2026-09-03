#!/usr/bin/env python3
"""Mosh-owned brain supervisor: spawn mlx_lm.server as a child, record both PIDs,
and guarantee the server dies with the Mosh app on EVERY exit path.

The old exec-based wrapper left the server orphaned whenever the app exited
without running its destructor (crash/force-quit) — on 2026-09-01 four such
17GB fused-model servers accumulated ~70GB of swap. Now the wrapper stays
resident as a watchdog: it forwards SIGTERM/SIGINT to the server, and if it is
ever reparented (the app died without signalling us) it terminates the server
and exits."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys


def server_command(python: str, model: str, port: str) -> list[str]:
    return [python, "-m", "mlx_lm.server", "--model", model,
            "--host", "127.0.0.1", "--port", port]


def _write_pidfile(pidfile: str, wrapper: int, server: int) -> None:
    os.makedirs(os.path.dirname(pidfile), exist_ok=True)
    tmp = f"{pidfile}.{wrapper}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"wrapper": wrapper, "server": server}, handle)
    os.replace(tmp, pidfile)


def supervise(cmd: list[str], pidfile: str, env=None, poll_seconds: float = 0.5) -> int:
    holder: list[subprocess.Popen] = []

    def forward(_signum, _frame):
        for p in holder:
            p.terminate()

    # Handlers go in before the spawn so a shutdown signal can never slip
    # through the gap and leave the server unwatched.
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)

    proc = subprocess.Popen(cmd, env=env)
    holder.append(proc)
    _write_pidfile(pidfile, os.getpid(), proc.pid)

    parent = os.getppid()
    while True:
        try:
            return proc.wait(timeout=poll_seconds)
        except subprocess.TimeoutExpired:
            pass
        ppid = os.getppid()
        # ppid == 1 also counts as dead even if it was 1 from the start: a race
        # where the parent died before we sampled it must still reap the server.
        if ppid != parent or ppid == 1:
            proc.terminate()
            try:
                proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            return 0


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: launch_local_brain.py PIDFILE PYTHON MODEL PORT")
    pidfile, python, model, port = sys.argv[1:]
    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    raise SystemExit(supervise(server_command(python, model, port), pidfile, env=env))


if __name__ == "__main__":
    main()
