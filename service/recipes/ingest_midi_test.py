#!/usr/bin/env python3
"""Golden test for the MIDI-pack ingester's no-rhythm refusal (pack-002 audition:
"all the notes hitting at once on the downbeat" — 277 scale-reference MIDIs, every
note at t=0, entered the library as pad/lead phrases).

Builds two minimal SMFs in a temp dir: a 6-note single-instant chord stack (must be
REFUSED) and the same pitches spread across beats (must ingest).
"""
from __future__ import annotations

import os
import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from recipes.ingest_midi import ingest_file  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
    if not cond:
        fails.append(name)


def _vlq(n: int) -> bytes:
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def write_smf(path: str, notes: list, ppq: int = 480):
    """notes: [(start_beats, pitch, dur_beats)] → single-track SMF with a 140 BPM tempo."""
    events = [(0, b"\xff\x51\x03" + (60_000_000 // 140).to_bytes(3, "big"))]
    for start, pitch, dur in notes:
        on = int(start * ppq)
        events.append((on, bytes([0x90, pitch, 100])))
        events.append((on + int(dur * ppq), bytes([0x80, pitch, 0])))
    events.sort(key=lambda e: e[0])
    track = b""
    t = 0
    for tick, data in events:
        track += _vlq(tick - t) + data
        t = tick
    track += _vlq(0) + b"\xff\x2f\x00"
    with open(path, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 0, 1, ppq))
        f.write(b"MTrk" + struct.pack(">I", len(track)) + track)


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        pitches = [60, 62, 64, 65, 67, 69]
        stack = os.path.join(td, "C - Major Scale pad 140bpm.mid")
        write_smf(stack, [(0.0, p, 4.0) for p in pitches])
        rec, reason = ingest_file(Path(stack), pack="testpack")
        check("single-instant 6-note stack is REFUSED", rec is None, str(reason))
        check("refusal reason names the no-rhythm class", "rhythm" in (reason or ""), str(reason))

        phrase = os.path.join(td, "C - Major phrase pad 140bpm.mid")
        write_smf(phrase, [(float(i), p, 1.0) for i, p in enumerate(pitches)])
        rec2, reason2 = ingest_file(Path(phrase), pack="testpack")
        check("the same pitches WITH rhythm ingest fine", rec2 is not None, str(reason2))
        if rec2 is not None:
            starts = {round(float(n.start_beats), 4)
                      for e in rec2.elements for n in e.midi.notes}
            check("ingested phrase keeps its distinct onsets", len(starts) == 6, str(starts))

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
    return len(fails)


if __name__ == "__main__":
    raise SystemExit(main())
