#!/usr/bin/env python3
"""Tiny Mosh-owned exec wrapper: record our PID, then become mlx_lm.server."""
from __future__ import annotations

import os
import sys


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: launch_local_brain.py PIDFILE PYTHON MODEL PORT")
    pidfile, python, model, port = sys.argv[1:]
    os.makedirs(os.path.dirname(pidfile), exist_ok=True)
    tmp = f"{pidfile}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(f"{os.getpid()}\n")
    os.replace(tmp, pidfile)
    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    os.execve(python, [python, "-m", "mlx_lm.server", "--model", model,
                       "--host", "127.0.0.1", "--port", port], env)


if __name__ == "__main__":
    main()
