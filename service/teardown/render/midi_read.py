from __future__ import annotations

import struct
from pathlib import Path


def _read_vlq(data: bytes, i: int) -> tuple[int, int]:
    n = 0
    while True:
        b = data[i]
        i += 1
        n = (n << 7) | (b & 0x7F)
        if not (b & 0x80):
            return n, i


def read_midi(path) -> list[dict]:
    data = Path(path).read_bytes()
    if data[:4] != b"MThd":
        raise ValueError("not a SMF (missing MThd)")
    _hlen, _fmt, ntrk, division = struct.unpack(">IHHH", data[4:14])
    ppq = division if division > 0 else 480
    pos = 14
    notes: list[dict] = []
    for _ in range(max(1, ntrk)):
        if data[pos:pos + 4] != b"MTrk":
            break
        tlen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        pos += 8
        end = pos + tlen
        i = pos
        tick = 0
        status = 0
        active: dict[int, tuple[int, int]] = {}
        while i < end:
            dt, i = _read_vlq(data, i)
            tick += dt
            b = data[i]
            if b & 0x80:
                status = b
                i += 1
            ev = status & 0xF0
            if status == 0xFF:
                _mtype = data[i]; i += 1
                mlen, i = _read_vlq(data, i)
                i += mlen
            elif status in (0xF0, 0xF7):
                slen, i = _read_vlq(data, i)
                i += slen
            elif ev in (0x80, 0x90):
                pitch = data[i]; vel = data[i + 1]; i += 2
                if ev == 0x90 and vel > 0:
                    active[pitch] = (tick, vel)
                else:
                    on = active.pop(pitch, None)
                    if on is not None:
                        on_tick, on_vel = on
                        notes.append({"pitch": int(pitch),
                                      "start": on_tick / ppq,
                                      "length": max(tick - on_tick, 1) / ppq,
                                      "velocity": int(on_vel)})
            elif ev in (0xA0, 0xB0, 0xE0):
                i += 2
            elif ev in (0xC0, 0xD0):
                i += 1
            else:
                i += 1
        pos = end
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes
