#!/usr/bin/env python3
"""Golden tests for the Phase-2 mumble -> rhythmic SKELETON core (Finish-My-Song roadmap §2).

The producer hums/mumbles GIBBERISH (no words); we turn the take into a rhythmic *skeleton*
— syllable count + onsets + a stress contour — and emit the SAME `LineSpec` the Phase-1 engine
already consumes (every slot a `___` gap; the engine fills the words). NO voice synthesis.

This is the deterministic IP: PURE functions over note/F0 lists (stdlib only), so it golden-tests
3× identical with no audio and no model. The note-onset-only path (no F0) MUST equal the existing,
already-trusted `lyrics.mumble.build_spec_from_take(notes, [])` binning — that equivalence is the
safety guarantee (a missing FCPE venv degrades to #178-quality rhythm, never breaks). With an F0
contour, a sustained note that re-articulates (a pitch jump mid-note) splits into N nuclei, raising
the syllable target.

Run:  python3 service/skeleton/skeleton_core_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from skeleton import core  # noqa: E402
from lyrics import core as lyr  # noqa: E402
from lyrics import mumble  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# Four note onsets: three close together (bar 0) + one a bar later (bar 1) @ 120bpm/4/4 (2s/bar).
NOTES = [
    {"start": 0.00, "end": 0.20, "velocity": 110},
    {"start": 0.30, "end": 0.45, "velocity": 80},
    {"start": 0.60, "end": 0.80, "velocity": 95},
    {"start": 2.10, "end": 2.35, "velocity": 100},
]


def _line0(spec):
    ls = spec.get("lines", [])
    return ls[0] if ls else {}


# ── 1. No-F0 path == the trusted mumble binning (the safety equivalence) ───────────────
sk = core.build_skeleton_spec(NOTES, f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8")
mb = mumble.build_spec_from_take(NOTES, [], 120.0, time_sig=(4, 4), grid="1/8")
check("no-F0 skeleton lines == mumble.build_spec_from_take lines",
      sk.get("lines") == mb.get("lines"),
      f"{len(sk.get('lines', []))} vs {len(mb.get('lines', []))} lines")
check("skeleton is ok with 2 bars -> 2 lines", sk.get("ok") and len(sk.get("lines", [])) == 2,
      str(len(sk.get("lines", []))))

# ── 2. It's a WORDLESS skeleton: every slot a gap, no words ever ───────────────────────
seeds = [ln.get("seedText", "") for ln in sk.get("lines", [])]
check("every seedText is all-gaps (no words leak in)",
      all(s.replace("_", "").replace(" ", "") == "" and "_" in s for s in seeds), str(seeds))
check("bar-0 syllableTarget == note count in bar 0 (3)", _line0(sk).get("syllableTarget") == 3,
      str(_line0(sk).get("syllableTarget")))

# ── 3. The skeleton is tagged editable (the human-in-the-loop grid gate) ───────────────
check("spec.source == 'skeleton'", sk.get("source") == "skeleton")
check("spec.editable is True", sk.get("editable") is True)

# ── 4. With an F0 contour, a re-articulated sustained note splits into >1 nucleus ──────
# One long note [0,1.0] held in bar 0; the F0 jumps ~+4 semitones at t=0.5 (a new syllable).
sustained = [{"start": 0.0, "end": 1.0, "velocity": 100}]
f0 = ([{"t": t / 100.0, "hz": 220.0} for t in range(0, 50)]       # A3 for the first half
      + [{"t": t / 100.0, "hz": 277.18} for t in range(50, 100)])  # ~C#4 for the second half
nuc = core.nuclei_from_notes(sustained, f0)
check("F0 re-articulation splits one sustained note into 2 nuclei", len(nuc) == 2, str(len(nuc)))
sk_f0 = core.build_skeleton_spec(sustained, f0=f0, bpm=120.0, time_sig=(4, 4), grid="1/8")
check("F0-split raises the bar-0 syllable target to 2", _line0(sk_f0).get("syllableTarget") == 2,
      str(_line0(sk_f0).get("syllableTarget")))
# …and with NO F0 the same sustained note is a single nucleus (identity).
check("no-F0 sustained note stays 1 nucleus", len(core.nuclei_from_notes(sustained, None)) == 1)

# ── 5. The emitted spec is loop-valid: the Phase-1 engine fills it (fake backend) ──────
done = lyr.complete(sk, backend="fake")
props0 = (done.get("lines", [{}])[0] or {}).get("proposals", []) if done.get("ok") else []
check("Phase-1 complete(skeleton spec) returns proposals", done.get("ok") and len(props0) > 0,
      f"ok={done.get('ok')} props={len(props0)}")

# ── 6. No-notes guard ──────────────────────────────────────────────────────────────────
empty = core.build_skeleton_spec([], f0=None, bpm=120.0)
check("no notes -> no_melody_detected", (not empty.get("ok")) and empty.get("error") == "no_melody_detected")

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print(f"\nOK: 0 failure(s)")
