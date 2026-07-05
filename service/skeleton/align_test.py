#!/usr/bin/env python3
"""Golden tests for the forced-alignment slot builder (FMS sung-render root fix).

The PURE layer (this file, hermetic — no model, no torch): grouping flat CTC token spans
back into per-word audio spans, and splitting a word's audio span into syllable slots.
These are what turn MMS_FA forced-alignment output into the score author's `slots` so held
notes are timed from the AUDIO, not over-segmented by the blind nuclei detector.

The REAL forced-alignment path (align.align_words, needs torch+torchaudio+MMS_FA in the
skeleton venv) is exercised separately by align_real_test.py, owner-gated like transcribe.

Run:  python3 service/skeleton/align_test.py     (exit 0 = all pass)
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


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


# ── 1. group_word_spans: flat CTC token spans → per-word [start,end] seconds ────────────
# Two words: "down" (4 chars) then "up" (2 chars); token spans are frame indices.
spans = [(0, 3), (3, 6), (6, 9), (9, 12), (20, 25), (25, 30)]
words = align.group_word_spans(spans, [4, 2], sec_per_frame=0.02)
check("2 words grouped from 6 token spans", len(words) == 2, str(words))
check("word 0 span = first token start .. last token end (× sec/frame)",
      approx(words[0]["start"], 0.0) and approx(words[0]["end"], 0.24), str(words[0]))
check("word 1 span picks up the gap (frames 20..30)",
      approx(words[1]["start"], 0.40) and approx(words[1]["end"], 0.60), str(words[1]))
check("group_word_spans is deterministic",
      align.group_word_spans(spans, [4, 2], sec_per_frame=0.02) == words)
# a single-token word must not crash
one = align.group_word_spans([(2, 5)], [1], sec_per_frame=0.01)
check("single-token word span", approx(one[0]["start"], 0.02) and approx(one[0]["end"], 0.05), str(one))

# ── 2. slots_for_word: split a word's audio span into `syl` syllable slots ──────────────
# 2 syllables over a 0.0..1.0s span → two 0.5s slots, contiguous, covering the whole span.
sl = align.slots_for_word(0.0, 1.0, 2)
check("2-syllable word → 2 slots", len(sl) == 2, str(sl))
check("slots are contiguous and cover the span",
      approx(sl[0]["start"], 0.0) and approx(sl[0]["end"], 0.5)
      and approx(sl[1]["start"], 0.5) and approx(sl[1]["end"], 1.0), str(sl))
check("each slot carries one segment spanning it (render-ready)",
      all(len(s["segments"]) == 1 and approx(s["segments"][0]["start"], s["start"])
          and approx(s["segments"][0]["end"], s["end"]) for s in sl), str(sl))
# a 1-syllable HELD note stays ONE slot (the fix for over-segmentation → no re-attack)
one_syl = align.slots_for_word(0.3, 1.5, 1)
check("1-syllable held note stays ONE slot (no over-segmentation)",
      len(one_syl) == 1 and approx(one_syl[0]["start"], 0.3) and approx(one_syl[0]["end"], 1.5),
      str(one_syl))
check("slots_for_word never returns zero slots (min 1)", len(align.slots_for_word(0.0, 0.5, 0)) == 1)

# ── 3. pitch from F0: each slot takes the median F0 (semitone) over its own span ─────────
f0 = [{"t": 0.1, "hz": 220.0}, {"t": 0.2, "hz": 220.0},   # A3 = MIDI 57 over slot 0
      {"t": 0.7, "hz": 440.0}, {"t": 0.8, "hz": 440.0}]   # A4 = MIDI 69 over slot 1
sl_p = align.slots_for_word(0.0, 1.0, 2, f0=f0)
check("slot 0 pitched from its own F0 window (220Hz → MIDI 57)",
      sl_p[0]["segments"][0]["pitch"] == 57, str(sl_p[0]))
check("slot 1 pitched from its own F0 window (440Hz → MIDI 69)",
      sl_p[1]["segments"][0]["pitch"] == 69, str(sl_p[1]))
check("no F0 in a slot's window → default pitch 69 (never crashes)",
      align.slots_for_word(5.0, 6.0, 1, f0=f0)[0]["segments"][0]["pitch"] == 69)

# ── 4. lines_from_aligned: aligned words + per-line word counts → author_score lines ────
# Each word gets its phonology syllable count of slots, timed within its aligned span; the
# lines feed score.author_score unchanged. This is the alignment-driven replacement for the
# over-segmented skeleton lineScores.
aligned = [{"word": "gonna", "start": 0.0, "end": 1.0, "score": 0.5},
           {"word": "down", "start": 1.0, "end": 3.0, "score": 0.5}]
lines = align.lines_from_aligned(aligned, [2], bpm=91.0)
check("one line built from a 2-word count", len(lines) == 1, str(len(lines)))
ln = lines[0]
check("line text is the aligned words joined", ln["text"] == "gonna down", ln["text"])
check("gonna(2 syl)+down(1 syl) → 3 slots total", len(ln["score"]["slots"]) == 3,
      str(len(ln["score"]["slots"])))
check("slots stay inside each word's aligned span (down's slot spans 1..3)",
      approx(ln["score"]["slots"][2]["start"], 1.0) and approx(ln["score"]["slots"][2]["end"], 3.0),
      str(ln["score"]["slots"][2]))
check("bar index tracks the line", ln["score"]["bar"] == 0)
check("lines_from_aligned is deterministic", align.lines_from_aligned(aligned, [2], bpm=91.0) == lines)

# legato: a small inter-word gap (the aligner leaves the sustain unattributed on singing) is
# BRIDGED — the note extends to the next word's onset so a phrase stays legato, not chopped by
# spurious rests. A large gap is a genuine pause and stays.
gapped = [{"word": "down", "start": 0.0, "end": 0.4, "score": 0.5},
          {"word": "down", "start": 0.6, "end": 1.0, "score": 0.5}]   # 0.2s gap → bridge
lines_b = align.lines_from_aligned(gapped, [2], bpm=91.0, bridge_gap_s=0.35)
check("small inter-word gap is bridged (note extends to next onset, no rest)",
      approx(lines_b[0]["score"]["slots"][0]["end"], 0.6), str(lines_b[0]["score"]["slots"][0]))
paused = [{"word": "down", "start": 0.0, "end": 0.4, "score": 0.5},
          {"word": "up", "start": 1.2, "end": 1.6, "score": 0.5}]     # 0.8s gap → stays a pause
lines_p = align.lines_from_aligned(paused, [2], bpm=91.0, bridge_gap_s=0.35)
check("large inter-word gap stays a pause (note end unchanged)",
      approx(lines_p[0]["score"]["slots"][0]["end"], 0.4), str(lines_p[0]["score"]["slots"][0]))

# ── 5. round-trip through the score author: the held 'down' is ONE clean note ───────────
# A long held 'down' (2s span, 1 syllable) → ONE slot → ONE type-2 onset, NOT a re-attacked
# "down down". This is the whole point of aligning known words to the audio.
from soulx import score as sx  # noqa: E402
held = [{"word": "down", "start": 0.0, "end": 6.0, "score": 0.5}]
lines_h = align.lines_from_aligned(held, [1], bpm=91.0)
clip = sx.author_score(lines_h, name="t")["score"][0]
check("held 'down' renders as ONE onset, no re-articulation",
      clip["text"].split() == ["down"] and clip["note_type"].split() == ["2"], str(clip["text"]))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
