#!/usr/bin/env python3
"""Goldens for the dynamics probe (synthetic audio; no models, no venv beyond numpy-free stdlib).

Run:  python3 scripts/fms-killshot/bench_dynamics_probe_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_dynamics_probe as dp  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


SR = 16000


def tone(dur_s, amp, f=220.0):
    return [amp * math.sin(2 * math.pi * f * (i / SR)) for i in range(int(dur_s * SR))]


# A "take": loud note, quiet note. A "render": both notes at the SAME level (the model
# invented flat dynamics — exactly the failure the probe measures).
TAKE = tone(0.5, 0.8) + tone(0.5, 0.15)
REND = tone(0.5, 0.5) + tone(0.5, 0.5)
CLIP = {"duration": "0.5 0.5", "note_type": "2 2"}

# ── the strength=0 contract (matches duration.py's byte-identity pin) ───────────────────
check("frame: strength=0 is byte-identical",
      dp.transfer_envelope_frame(TAKE, REND, SR, strength=0.0) == REND)
check("note: strength=0 is byte-identical",
      dp.transfer_envelope_note(TAKE, REND, SR, CLIP, strength=0.0) == REND)

# ── note_spans (pure) ──────────────────────────────────────────────────────────────────
check("note_spans lays authored durations end to end",
      dp.note_spans({"duration": "0.2 0.3", "note_type": "2 3"}, 10.0) == [(0.0, 0.2), (0.2, 0.5)])
check("note_spans EXCLUDES rests (note_type 1)",
      dp.note_spans({"duration": "0.2 0.3 0.4", "note_type": "1 2 1"}, 10.0) == [(0.2, 0.5)])
check("note_spans clamps to the render length",
      dp.note_spans({"duration": "0.2 5.0", "note_type": "2 2"}, 1.0) == [(0.0, 0.2), (0.2, 1.0)])
check("note_spans on a malformed clip is empty, not a crash",
      dp.note_spans({"duration": "x y", "note_type": "2 2"}, 1.0) == [])
check("note_spans on an empty clip is empty", dp.note_spans({}, 1.0) == [])

# ── both transfers move the render toward the take's dynamics ──────────────────────────
def rms(x):
    return math.sqrt(sum(v * v for v in x) / len(x)) if x else 0.0


half = int(0.5 * SR)
for name, out in (("frame", dp.transfer_envelope_frame(TAKE, REND, SR)),
                  ("note", dp.transfer_envelope_note(TAKE, REND, SR, CLIP))):
    loud, quiet = rms(out[:half]), rms(out[half:])
    src_ratio = rms(REND[:half]) / max(rms(REND[half:]), 1e-9)
    check(f"{name}: restores the take's loud/quiet contrast",
          loud / max(quiet, 1e-9) > 2.0 and src_ratio < 1.2,
          f"ratio {loud / max(quiet, 1e-9):.2f} (render was {src_ratio:.2f})")
    check(f"{name}: preserves length exactly", len(out) == len(REND))

# ── THE distinguishing property: does the take's INTRA-note shape get imported? ─────────
# One note. The take swells across it; the render is flat. The frame version tracks the
# take's envelope hop by hop, so the render inherits a shape it never performed — that
# imported shape IS the "volume automation" percept. The note version imports only the
# note's LEVEL, so the render keeps its own (here flat) interior.
#
# (An earlier version of this test asserted the frame variant would FLATTEN a render's own
# swell. That was wrong and the test caught it: the voicing gate reads a swell's soft start
# as non-voicing and refuses to boost it, so nothing moved. Asserting the definitional
# mechanism instead of a signal-dependent side effect.)
TAKE1 = [0.8 * (0.15 + 0.85 * (i / (0.6 * SR))) * math.sin(2 * math.pi * 220 * (i / SR))
         for i in range(int(0.6 * SR))]
REND1 = tone(0.6, 0.5)
CLIP1 = {"duration": "0.6", "note_type": "2"}
third = len(REND1) // 3


def swell(x):
    return rms(x[-third:]) / max(rms(x[:third]), 1e-9)


sw_take, sw_src = swell(TAKE1), swell(REND1)
sw_frame = swell(dp.transfer_envelope_frame(TAKE1, REND1, SR))
sw_note = swell(dp.transfer_envelope_note(TAKE1, REND1, SR, CLIP1))
check("take genuinely swells / render genuinely flat (fixture sanity)",
      sw_take > 2.5 and 0.9 < sw_src < 1.1, f"take {sw_take:.2f}, render {sw_src:.2f}")
check("frame version IMPORTS the take's intra-note shape (the automation percept)",
      sw_frame > sw_src * 1.8, f"render swell {sw_src:.2f} → {sw_frame:.2f}")
check("note version imports LEVEL only, leaving the note's interior alone",
      sw_note < sw_src * 1.5, f"render swell {sw_src:.2f} → {sw_note:.2f}")
check("the two variants are genuinely different (not the same function twice)",
      sw_frame > sw_note * 1.5, f"frame {sw_frame:.2f} vs note {sw_note:.2f}")

# ── determinism ────────────────────────────────────────────────────────────────────────
det = {hashlib.sha256(json.dumps([round(v, 9) for v in
                                  dp.transfer_envelope_note(TAKE, REND, SR, CLIP)]).encode()).hexdigest()
       for _ in range(3)}
check("note transfer deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
