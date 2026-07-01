from __future__ import annotations

import struct
from pathlib import Path


def _vlq(n: int) -> bytes:
    n = max(0, int(n))
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def write_midi(notes: list[dict], path, bpm: float = 140.0, ppq: int = 480) -> str:
    events = []
    for nt in notes:
        s = int(round(float(nt["start"]) * ppq))
        e = max(int(round(float(nt["end"]) * ppq)), s + 1)
        v = int(nt.get("velocity", 90))
        events.append((s, 0x90, int(nt["pitch"]), v))
        events.append((e, 0x80, int(nt["pitch"]), 0))
    events.sort(key=lambda x: (x[0], x[1]))

    trk = bytearray()
    mpqn = int(60_000_000 / max(1.0, bpm))
    trk += _vlq(0) + b"\xff\x51\x03" + struct.pack(">I", mpqn)[1:]
    last = 0
    for tick, status, pitch, vel in events:
        trk += _vlq(tick - last) + bytes([status, pitch & 0x7F, vel & 0x7F])
        last = tick
    trk += _vlq(0) + b"\xff\x2f\x00"

    data = b"MThd" + struct.pack(">IHHH", 6, 0, 1, ppq) + b"MTrk" + struct.pack(">I", len(trk)) + bytes(trk)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(data)
    return str(path)
