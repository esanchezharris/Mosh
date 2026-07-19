#!/usr/bin/env python3
"""Goldens for the full-span chunked render path (pure cores only — no SoulX).

The full-span path authors ONE score, splits it with the proven `chunk_score` (≤12 s,
melisma-safe breaks), renders each chunk separately, and reassembles by concatenation on
the span clock. Chunk renders may arrive SELF-PLACED (length ≈ absolute end time — the
used2 GOTCHA: SoulX honors time[0]) or CHUNK-LOCAL (length ≈ chunk span); `place_chunk`
decides per chunk by nearest length and always returns exactly the chunk's span.

Run:  python3 scripts/fms-killshot/bench_pipeline_render_test.py   (exit 0 = all pass)
"""
import hashlib
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_pipeline_render as pr  # noqa: E402
from asserted_proof_score import chunk_score  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


SR = 1000  # 1 kHz test rate: 1 sample = 1 ms, indices readable


def ramp(n, start=0):
    return np.arange(start, start + n, dtype=np.float64)


# ── place_chunk: self-placed renders get their leading placement sliced off ────────────
y_self = ramp(5000)                       # 5.0 s long = absolute end of a [2.0,5.0]s chunk
seg = pr.place_chunk(y_self, 2000, 5000, SR)
check("self-placed render: slice [time0:time1]",
      len(seg) == 3000 and seg[0] == 2000.0 and seg[-1] == 4999.0,
      f"len={len(seg)} first={seg[0]} last={seg[-1]}")

y_local = ramp(3000)                      # 3.0 s long = the chunk's own span
seg = pr.place_chunk(y_local, 2000, 5000, SR)
check("chunk-local render: taken as-is", len(seg) == 3000 and seg[0] == 0.0)

y_long = ramp(3400)                       # local + 0.4 s tail: trimmed to the span
seg = pr.place_chunk(y_long, 2000, 5000, SR)
check("overlong local render trimmed to exact span", len(seg) == 3000)

y_short = ramp(2800)                      # short render: zero-padded to the span
seg = pr.place_chunk(y_short, 2000, 5000, SR)
check("short render zero-padded to exact span",
      len(seg) == 3000 and seg[-1] == 0.0 and seg[2799] == 2799.0)

first = pr.place_chunk(ramp(3000), 0, 3000, SR)   # first chunk: both modes identical
check("first chunk (time0=0): modes coincide, exact span", len(first) == 3000)

# ── assemble_chunks: concatenation on the span clock, exact total length ───────────────
chunks_meta = [{"time": [0, 3000]}, {"time": [3000, 7000]}, {"time": [7000, 9000]}]
rendered = [ramp(3000), ramp(7000), ramp(2000, start=9)]   # self, self, local
audio = pr.assemble_chunks(rendered, chunks_meta, SR)
check("assembled length == span end", len(audio) == 9000, str(len(audio)))
check("chunk 2 self-placed content landed at its offset",
      audio[3000] == 3000.0 and audio[6999] == 6999.0)
check("chunk 3 local content landed after chunk 2", audio[7000] == 9.0)

# ── chunk_chain_ok: the chain-sum guard ────────────────────────────────────────────────
CLIP = {"index": "t", "language": "English", "time": [0, 9000],
        "duration": " ".join(["0.50"] * 18), "text": " ".join(["<SP>", "la"] * 9),
        "phoneme": " ".join(["<SP>", "en_L-AA1"] * 9),
        "note_pitch": " ".join(["0", "60"] * 9), "note_type": " ".join(["1", "2"] * 9)}
chunks = chunk_score([CLIP], max_chunk_s=4.0)
check("chunk_score splits the 9s clip", len(chunks) >= 2, str(len(chunks)))
check("chain-sum guard passes on faithful chunks", pr.chunk_chain_ok([CLIP], chunks))
bad = [dict(c) for c in chunks]
bad[0] = dict(bad[0], duration=bad[0]["duration"].replace("0.50", "0.60", 1))
check("chain-sum guard REJECTS a mutated chunk", not pr.chunk_chain_ok([CLIP], bad))

# ── determinism ────────────────────────────────────────────────────────────────────────
det = {hashlib.sha256(pr.assemble_chunks(rendered, chunks_meta, SR).tobytes()).hexdigest()
       for _ in range(3)}
check("assemble deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
