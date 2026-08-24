#!/usr/bin/env python3
import json
import os
import signal
import socket
import sys

descriptor = os.environ["MOSH_DAWN_DESCRIPTOR"]
secret = os.environ["MOSH_DAWN_SECRET"]
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(("127.0.0.1", 0))
listener.listen(1)
os.makedirs(os.path.dirname(descriptor), mode=0o700, exist_ok=True)
fd = os.open(descriptor, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump({"protocol": 1, "host": "127.0.0.1",
               "port": listener.getsockname()[1], "secret": secret}, handle)
pid_file = os.environ.get("MOSH_FAKE_PID_FILE")
if pid_file:
    with open(pid_file, "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))

def stop(_signal, _frame):
    listener.close()
    try:
        os.unlink(descriptor)
    except FileNotFoundError:
        pass
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
while True:
    signal.pause()
