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


_KEYSIG_MAJ = {0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
               -1: "F", -2: "A#", -3: "D#", -4: "G#", -5: "C#", -6: "F#", -7: "B"}
_KEYSIG_MIN = {0: "A", 1: "E", 2: "B", 3: "F#", 4: "C#", 5: "G#", 6: "D#", 7: "A#",
               -1: "D", -2: "G", -3: "C", -4: "F", -5: "A#", -6: "D#", -7: "G#"}


def read_midi_meta(path) -> dict:
    """SMF meta events the note reader skips: {'tempo': bpm|None, 'key': 'F# minor'|None}
    — the first FF 51 set_tempo and FF 59 key signature (r8 pack ingestion: file meta is
    the highest-trust key/tempo source, ahead of filename convention)."""
    data = Path(path).read_bytes()
    if data[:4] != b"MThd":
        raise ValueError("not a SMF (missing MThd)")
    _hlen, _fmt, ntrk, _division = struct.unpack(">IHHH", data[4:14])
    pos = 14
    out = {"tempo": None, "key": None}
    for _ in range(max(1, ntrk)):
        if data[pos:pos + 4] != b"MTrk":
            break
        tlen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        pos += 8
        end = pos + tlen
        i = pos
        status = 0
        while i < end:
            _dt, i = _read_vlq(data, i)
            b = data[i]
            if b & 0x80:
                status = b
                i += 1
            ev = status & 0xF0
            if status == 0xFF:
                mtype = data[i]; i += 1
                mlen, i = _read_vlq(data, i)
                if mtype == 0x51 and mlen == 3 and out["tempo"] is None:
                    usec = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
                    if usec > 0:
                        out["tempo"] = round(60_000_000 / usec, 2)
                elif mtype == 0x59 and mlen == 2 and out["key"] is None:
                    sf_ = struct.unpack(">b", data[i:i + 1])[0]
                    minor = data[i + 1] == 1
                    tonic = (_KEYSIG_MIN if minor else _KEYSIG_MAJ).get(sf_)
                    if tonic:
                        out["key"] = f"{tonic} {'minor' if minor else 'major'}"
                i += mlen
            elif status in (0xF0, 0xF7):
                slen, i = _read_vlq(data, i)
                i += slen
            elif ev in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                i += 2
            elif ev in (0xC0, 0xD0):
                i += 1
            else:
                i += 1
        pos = end
        if out["tempo"] is not None and out["key"] is not None:
            break
    return out
