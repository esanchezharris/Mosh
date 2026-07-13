#!/usr/bin/env python3
"""Golden tests for flow_units — the flexible 'rapper-moves' allocator.

The rigid _word_units holds the last word over leftover slots (a tone sustained through the
singer's silence) and never rests. flow_units instead, when there are MORE notes than
syllables, KEEPS the strongest slots (loud/long/on-beat) for the syllables and leaves the
weak ones UNALLOCATED — author_score then renders those as rests (silence), not a hold. It
returns the same [(word|[words], [slots]), …] shape the score author consumes.

Pure + deterministic. Run:  python3 service/soulx/flowfit_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from soulx import flowfit as ff  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOT(start, vel, dur=0.18, pitch=57):
    return {"start": start, "end": start + dur, "velocity": float(vel), "kind": "gap",
            "segments": [{"start": start, "end": start + dur, "pitch": pitch}]}


def alloc_starts(units):
    return sorted(round(s["start"], 4) for _, ss in units for s in ss)


BPM, TS = 138.0, (4, 4)
# five notes on an even grid; the loud ones are 0/2/4, the quiet ones 1/3
FIVE = [SLOT(0.0, 90), SLOT(0.2174, 40), SLOT(0.4348, 95), SLOT(0.6522, 45), SLOT(0.8696, 100)]

# ── 1. fewer syllables than notes: keep the STRONGEST, rest the weak (no hold) ────────
u = ff.flow_units(["one", "two", "three"], FIVE, BPM, TS)
check("one unit per word (3)", len(u) == 3, str([(w, len(s)) for w, s in u]))
check("each word takes exactly one slot (no held-over-leftover)", all(len(s) == 1 for _, s in u))
check("keeps the 3 STRONGEST slots (0,2,4)", alloc_starts(u) == sorted([0.0, 0.4348, 0.8696]), str(alloc_starts(u)))
allocated = {round(s["start"], 4) for _, ss in u for s in ss}
check("the 2 weakest slots (1,3) are left UNALLOCATED -> rests", 0.2174 not in allocated and 0.6522 not in allocated)

# ── 2. a single word lands on the accented note ──────────────────────────────────────
u2 = ff.flow_units(["go"], [SLOT(0.0, 30), SLOT(0.2, 99), SLOT(0.4, 30)], BPM, TS)
check("lone word sits on the loud/accented slot", len(u2) == 1 and abs(u2[0][1][0]["start"] - 0.2) < 1e-6, str(alloc_starts(u2)))

# ── 3. syllables == notes: fill it, no rests, no squeeze ─────────────────────────────
u3 = ff.flow_units(["one", "two", "three"], FIVE[:3], BPM, TS)
check("exact fit covers every slot", len(u3) == 3 and alloc_starts(u3) == sorted(s["start"] for s in FIVE[:3]))
check("exact fit holds nothing", all(len(s) == 1 for _, s in u3))

# ── 4. more words than notes: squeeze tail (slot-starved, can't rest) ─────────────────
u4 = ff.flow_units(["a", "b", "c", "d"], FIVE[:2], BPM, TS)
check("squeeze: last unit shares the final slot as a LIST", isinstance(u4[-1][0], list) and u4[-1][0] == ["b", "c", "d"], str(u4[-1][0]))

# ── 5. multisyllable word takes contiguous slots for its syllables ───────────────────
u5 = ff.flow_units(["hello", "world"], FIVE[:3], BPM, TS)   # hello=2 syl, world=1 -> S=3=N
byword = {w: len(s) for w, s in u5}
check("multisyllable word consumes its syllables (hello->2, world->1)", byword.get("hello") == 2 and byword.get("world") == 1, str(byword))

# ── 6. deterministic ──────────────────────────────────────────────────────────────────
check("flow_units is deterministic", ff.flow_units(["one", "two", "three"], FIVE, BPM, TS) == u)

# ── 7. condition_slots: cap an over-long slot so a tone can't sustain over silence ────
# The skeleton sometimes captures a long span (e.g. 1.9s) as ONE slot; sung whole it holds a
# tone through what is really the singer's silence. Capping the sung length frees the tail,
# which author_score then renders as a REST. Consecutive real notes are untouched.
from soulx import score as sx  # noqa: E402

LONG = [{"start": 0.0, "end": 1.9, "velocity": 80.0, "kind": "gap",
         "segments": [{"start": 0.0, "end": 1.9, "pitch": 55}]},
        {"start": 2.0, "end": 2.3, "velocity": 80.0, "kind": "gap",
         "segments": [{"start": 2.0, "end": 2.3, "pitch": 57}]}]
cond = ff.condition_slots(LONG, bpm=120.0, max_beats=1.0)   # beat=0.5s -> cap 0.5s
check("over-long slot capped to max_beats", abs(cond[0]["end"] - 0.5) < 1e-6, str(cond[0]["end"]))
check("its segments are trimmed to the cap", all(s["end"] <= 0.5 + 1e-9 for s in cond[0]["segments"]))
check("a short slot is left untouched", cond[1]["end"] == 2.3 and cond[1]["start"] == 2.0)
check("condition_slots is deterministic", ff.condition_slots(LONG, bpm=120.0, max_beats=1.0) == cond)

# round-trip: the freed tail becomes a real rest in the authored score
clip = sx.author_score([{"text": "aah yeah", "asserted": True,
                         "score": {"slots": cond}}])["score"][0]
toks = clip["text"].split()
durs = [float(d) for d in clip["duration"].split()]
big_rest = [durs[i] for i, t in enumerate(toks) if t == "<SP>" and durs[i] > 1.0]
check("capping turns the long tail into a >1s REST (silence, not a held tone)", len(big_rest) >= 1, str([round(d, 2) for d in durs]))

# ── 8. snap_slots_to_key: pitch hygiene (owner-certified via demo d5, 2026-07-11) ─────
# Basic Pitch leaves measurement noise in the skeleton's pitches; snapping to the SONG KEY
# cleans the sour notes. The B-major label manufactured wrong notes (owner ear, demo d4);
# D major (= B minor pitch set) fixed them (demo d5). Octave outliers clamp to the median.
NOISY = [{"start": 0.0, "end": 0.3, "velocity": 80.0,
          "segments": [{"start": 0.0, "end": 0.3, "pitch": 56}]},      # G#3 -> off-key in D
         {"start": 0.4, "end": 0.7, "velocity": 80.0,
          "segments": [{"start": 0.4, "end": 0.7, "pitch": 59}]},      # B3 -> in key, untouched
         {"start": 0.8, "end": 1.1, "velocity": 80.0,
          "segments": [{"start": 0.8, "end": 1.1, "pitch": 42},        # F#1 octave outlier
                       {"start": 1.05, "end": 1.1, "pitch": 61}]}]     # C#4 in key
snapped = ff.snap_slots_to_key(NOISY, key="D major")
ps = [g["pitch"] for s in snapped for g in s["segments"]]
DMAJ = {2, 4, 6, 7, 9, 11, 1}
check("every snapped pitch lands in D major", all(p % 12 in DMAJ for p in ps), str(ps))
check("in-key note untouched", snapped[1]["segments"][0]["pitch"] == 59)
check("octave outlier clamped toward the median", abs(snapped[2]["segments"][0]["pitch"] - 59) <= 7, str(ps))
check("input slots not mutated", NOISY[0]["segments"][0]["pitch"] == 56)
check("snap is deterministic", ff.snap_slots_to_key(NOISY, key="D major") == snapped)
check("B minor == D major pitch set (relative keys)",
      ff.snap_slots_to_key(NOISY, key="B minor") == snapped)
import re as _re  # noqa: E402
try:
    ff.snap_slots_to_key(NOISY, key="H sharp mixolydian")
    check("unknown key raises", False)
except ValueError:
    check("unknown key raises", True)

# ── 9. tidy_segments: pitch hygiene v2 — clean Basic-Pitch jitter BEFORE cap+snap ─────
# The owner still hears wrong notes after the key snap ("correct notes" axis): micro-glitch
# segments (<40ms) create spurious glides, and ornament mis-tracks scatter a slot across a
# wide interval. Drop the glitches; collapse a wide slot to its duration-weighted median.
JIT = [
    # slot A: a solid note + a 20ms glitch two octaves off -> glitch dropped
    {"start": 0.0, "end": 0.5, "velocity": 80.0,
     "segments": [{"start": 0.0, "end": 0.48, "pitch": 57},
                  {"start": 0.48, "end": 0.5, "pitch": 81}]},
    # slot B: an ornament mis-track spread over 9 st -> collapsed to the weighted median
    {"start": 0.6, "end": 1.2, "velocity": 80.0,
     "segments": [{"start": 0.6, "end": 1.05, "pitch": 57},
                  {"start": 1.05, "end": 1.2, "pitch": 66}]},
    # slot C: a genuine 2-st melisma with substantial segments -> untouched
    {"start": 1.3, "end": 1.9, "velocity": 80.0,
     "segments": [{"start": 1.3, "end": 1.6, "pitch": 57},
                  {"start": 1.6, "end": 1.9, "pitch": 59}]},
]
tidy = ff.tidy_segments(JIT)
check("micro-glitch segment dropped", len(tidy[0]["segments"]) == 1 and tidy[0]["segments"][0]["pitch"] == 57,
      str(tidy[0]["segments"]))
check("dropped glitch's span is re-covered (no time hole)", abs(tidy[0]["segments"][-1]["end"] - 0.5) < 1e-9)
check("wide-spread slot collapsed to ONE weighted-median pitch",
      len(tidy[1]["segments"]) == 1 and tidy[1]["segments"][0]["pitch"] == 57, str(tidy[1]["segments"]))
check("genuine small melisma untouched", [g["pitch"] for g in tidy[2]["segments"]] == [57, 59])
check("tidy_segments does not mutate input", len(JIT[0]["segments"]) == 2)
check("tidy_segments is deterministic", ff.tidy_segments(JIT) == tidy)
# an all-glitch slot (every segment tiny) keeps ONE representative segment, never empties
tiny = [{"start": 0.0, "end": 0.03, "velocity": 70.0,
         "segments": [{"start": 0.0, "end": 0.03, "pitch": 60}]}]
check("all-glitch slot keeps a representative segment", len(ff.tidy_segments(tiny)[0]["segments"]) == 1)

# ── 10. snap tiebreaker: NEAREST, ties resolve UP (owner, 2026-07-12) ──────────────────
# The old tiebreaker sorted(range(-6,7), key=(abs,k)) iterates 0,-1,+1,-2,+2 — every
# equidistant off-key note FLOORS to the lower scale degree ("high notes are a whole step
# down from reality"). In a major scale EVERY off-key pitch class is exactly 1 semitone from
# two degrees (a genuine tie), so the floor bias transposes every off-key note DOWN. F0
# detection reads sustained/high notes slightly FLAT, so a true E heard as Eb then floored to
# D lands a whole step low. Fix: ties resolve UP (a flat-detected note lands on its intended
# higher degree). Single-slot inputs (median == the note) isolate the snap from the octave clamp.
def snap1(p):
    return ff.snap_slots_to_key([{"segments": [{"start": 0, "end": 1, "pitch": p}]}],
                                "D major")[0]["segments"][0]["pitch"]
# D major = {D,E,F#,G,A,B,C#} = pcs {2,4,6,7,9,11,1}; off-key pcs {0,3,5,8,10} are all ties.
check("off-key Eb (pc3) snaps UP to E, not down to D", snap1(63) == 64, str(snap1(63)))
check("off-key G# (pc8) snaps UP to A, not down to G", snap1(68) == 69, str(snap1(68)))
check("off-key F (pc5) snaps UP to F#, not down to E", snap1(65) == 66, str(snap1(65)))
check("off-key Bb (pc10) snaps UP to B, not down to A", snap1(70) == 71, str(snap1(70)))
check("off-key C (pc0) snaps UP to C#, not down to B", snap1(60) == 61, str(snap1(60)))
check("in-key notes are never moved by the tiebreaker",
      [snap1(p) for p in (62, 64, 66, 67, 69, 71, 61)] == [62, 64, 66, 67, 69, 71, 61])
# a flat-detected HIGH note (true E5=76 read as Eb5=75) now recovers UP to E5, not down to D5
check("a flat-read high note recovers to the intended degree", snap1(75) == 76, str(snap1(75)))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
