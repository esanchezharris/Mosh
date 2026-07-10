#!/usr/bin/env python3
"""REAL forced-alignment test (owner-gated): runs MMS_FA on actual audio.

Needs torch+torchaudio+uroman in the skeleton venv AND the MMS_FA weights cached. SKIPS
cleanly when the stack or the fixture audio is absent, so the hermetic gate never fails for
a missing optional model (mirrors the transcribe/whisper real-path tests).

Fixture: the calibrate excerpt (~/mosh-fms-ksb/calibrate/excerpt.wav, "I'm going down…").

Run:  ~/Library/Mosh/venvs/skeleton/bin/python service/skeleton/align_real_test.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from skeleton import align  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


EXCERPT = os.path.expanduser("~/mosh-fms-ksb/calibrate/excerpt.wav")

if not align.available():
    print("[SKIP] forced-alignment stack not importable (torch/torchaudio/uroman)")
    sys.exit(0)
if not os.path.exists(EXCERPT):
    print(f"[SKIP] fixture audio absent: {EXCERPT}")
    sys.exit(0)

# First sung line of the pella.
WORDS = "I'm going down down down down down".split()

res = align.align_words(EXCERPT, WORDS)
check("align_words returns a result on real audio", res is not None, str(type(res)))
if res:
    check("every input word aligned (none dropped)", len(res) == len(WORDS), f"{len(res)}/{len(WORDS)}")
    check("each span has start < end", all(w["start"] < w["end"] for w in res),
          str([(round(w["start"], 2), round(w["end"], 2)) for w in res]))
    starts = [w["start"] for w in res]
    check("word starts are monotonic non-decreasing (aligned in order)",
          all(b >= a - 1e-6 for a, b in zip(starts, starts[1:])), str([round(s, 2) for s in starts]))
    check("all spans inside the excerpt (0..~22s)", all(0.0 <= w["start"] and w["end"] <= 23.0 for w in res),
          str([(round(w["start"], 2), round(w["end"], 2)) for w in res]))
    res2 = align.align_words(EXCERPT, WORDS)
    check("forced alignment is deterministic (same spans twice)",
          [round(w["start"], 4) for w in res] == [round(w["start"], 4) for w in res2])
    print("\naligned word spans (s):")
    for w in res:
        print(f"  {w['word']:8} {w['start']:6.2f} .. {w['end']:6.2f}  (score {w['score']:.2f})")

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
