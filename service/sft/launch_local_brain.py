#!/usr/bin/env python3
"""Record an exact Mosh-owned process identity, then become mlx_lm.server."""
from __future__ import annotations

import json
import os
import pwd
import sys


def _atomic_write(path: str, content: str) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.replace(tmp, path)


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit(
            "usage: launch_local_brain.py PIDFILE RECORD_DIR PYTHON MODEL PORT"
        )
    pidfile, record_dir, python, model, port = sys.argv[1:]
    os.makedirs(os.path.dirname(pidfile), exist_ok=True)
    os.makedirs(record_dir, mode=0o700, exist_ok=True)
    os.chmod(record_dir, 0o700)
    pid = os.getpid()
    record = {
        "owner": "Mosh",
        "user": pwd.getpwuid(os.getuid()).pw_name,
        "pythonRuntime": python,
        "modelPath": model,
        "host": "127.0.0.1",
        "port": int(port),
        "pid": pid,
    }
    _atomic_write(
        os.path.join(record_dir, f"{pid}.json"),
        json.dumps(record, separators=(",", ":")),
    )
    _atomic_write(pidfile, f"{pid}\n")
    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    os.execve(python, [python, "-m", "mlx_lm.server", "--model", model,
                       "--host", "127.0.0.1", "--port", port], env)


if __name__ == "__main__":
    main()
