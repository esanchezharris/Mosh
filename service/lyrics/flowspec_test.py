#!/usr/bin/env python3
"""Golden tests for FlowSpec — a rhythm/pitch-GROUNDED LineSpec (Finish-My-Song).

A mumbled back half is a *specification*: the skeleton's `lineScores` carry every
syllable's real onset, duration, velocity and MIDI pitch. The old path fed the brain a
bare syllable count and then collapsed 32 fragments into arbitrary bars — severing the
`lineScores` link, so no word was ever tied to the note it must land on. FlowSpec fixes
the context:
  1. group_by_rest merges the mumble's fragments into writable PHRASE-lines split on the
     take's REAL rests, keeping each phrase's true slots attached (absolute times).
  2. build_flow_spec derives, per phrase, the exact syllable count, velocity-stress,
     pitch contour, a theme hint from the mumble's own ASR, and an end-rhyme scheme.
  3. the attached `score` blob is author_score-compatible, so the written words can be
     placed back on the mumble's grid and rendered — the workability harness.

Pure + deterministic (3x identical). Run:  python3 service/lyrics/flowspec_test.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import flowspec as fs  # noqa: E402
from soulx import score as sx  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def SLOT(a, b, vel, *pitches):
    segs, n = [], len(pitches)
    for i, p in enumerate(pitches):
        segs.append({"start": a + (b - a) * i / n, "end": a + (b - a) * (i + 1) / n, "pitch": p})
    return {"start": a, "end": b, "velocity": float(vel), "kind": "gap", "segments": segs}


def LS(bar, slots):
    return {"v": 1, "algo": "v4", "bar": bar, "bpm": 138.0, "timeSig": [4, 4],
            "grid": "1/16", "clamped": False, "slots": slots}


def HEARD(bar, *pairs):
    return {"v": 1, "bar": bar,
            "words": [{"word": w, "kept": k, "conf": 0.9, "syl": 1, "slot": 0} for (w, k) in pairs]}


# A tiny 4-bar mumble: phrase A = bars 0+1 (small 0.1s gap keeps them together),
# a 1.5s rest splits to phrase B (bar 2), a 1.3s rest splits to phrase C (bar 3).
SKELETON = {
    "lineScores": [
        LS(0, [SLOT(0.5, 0.8, 60, 55), SLOT(0.8, 1.1, 100, 59)]),
        LS(1, [SLOT(1.2, 1.5, 70, 57)]),
        LS(2, [SLOT(3.0, 3.4, 90, 60), SLOT(3.4, 3.7, 50, 52)]),
        LS(3, [SLOT(5.0, 5.3, 80, 55), SLOT(5.3, 5.6, 85, 55)]),
    ],
    "lineHeard": [
        HEARD(0, ("scars", True), ("yeah", False)),
        HEARD(1, ("feel", True), ("like", True)),
        HEARD(2, ("family", True), ("world", False)),
        HEARD(3, ("strangers", True)),
    ],
}

# ── 1. group_by_rest splits on the REAL rests, preserving slots (absolute times) ──────
phrases = fs.group_by_rest(SKELETON["lineScores"], gap_s=0.35)
check("group_by_rest yields 3 phrases (2 rests split 4 bars)", len(phrases) == 3, str([len(p['slots']) for p in phrases]))
check("phrase A concatenates bars 0+1 (3 slots)", len(phrases[0]["slots"]) == 3)
check("phrase A tracks its source bars", phrases[0]["bars"] == [0, 1])
check("phrase B is bar 2 (2 slots)", len(phrases[1]["slots"]) == 2 and phrases[1]["bars"] == [2])
check("phrase C is bar 3 (2 slots)", len(phrases[2]["slots"]) == 2 and phrases[2]["bars"] == [3])
check("slots preserved verbatim (segments + pitch intact)",
      phrases[0]["slots"][0]["segments"][0]["pitch"] == 55 and phrases[0]["slots"][1]["velocity"] == 100.0)
check("phrase carries absolute start/end", abs(phrases[0]["start"] - 0.5) < 1e-6 and abs(phrases[0]["end"] - 1.5) < 1e-6)

# ── 2. build_flow_spec: exact counts, clean gaps, determinism ─────────────────────────
spec = fs.build_flow_spec(SKELETON, chorus="got hella close", theme="drifted apart")
spec_b = fs.build_flow_spec(SKELETON, chorus="got hella close", theme="drifted apart")
lines = spec["lines"]
check("build_flow_spec ok + 3 lines", spec.get("ok") and len(lines) == 3)
check("syllableTarget == real slot count per phrase", [l["syllableTarget"] for l in lines] == [3, 2, 2])
check("syllableTol is EXACT (0) — the hand-fit discipline (owner-certified d5)",
      all(l["syllableTol"] == 0 for l in lines), str([l["syllableTol"] for l in lines]))
check("seedText is CLEAN (no mumble word-salad as required words)", all(l["seedText"] == "" for l in lines))
check("build_flow_spec is deterministic", spec == spec_b)
check("carries chorus + theme for coherence", spec.get("chorus") == "got hella close" and spec.get("theme") == "drifted apart")

# ── 3. stress from velocity (loud slot -> 'X') ────────────────────────────────────────
# phrase A velocities 60/100/70, mean 76.7 -> only the loud middle slot is stressed
check("stress marks the loud slot 'X' (velocity-derived)", lines[0]["stress"] == "xXx", lines[0]["stress"])
check("stress length == syllable count", all(len(l["stress"]) == l["syllableTarget"] for l in lines))

# ── 4. pitch contour names the sung high note + the held note ─────────────────────────
# phrase A pitches 55/59/57 -> peak on syllable 2; equal durations -> first is longest
contour = lines[0]["pitchContour"]
check("pitchContour names the highest note's syllable", "highest pitch on syllable 2" in contour, contour)
check("pitchContour names the held (longest) note's syllable", "held note on syllable 1" in contour, contour)
check("pitchContour states a direction", any(w in contour for w in ("rise", "fall", "level")), contour)

# ── 5. theme hint from the mumble's OWN ASR (inspiration, not required words) ──────────
check("themeHint carries the phrase's kept mumble words", all(w in lines[0]["themeHint"] for w in ("scars", "feel", "like")), lines[0]["themeHint"])
check("themeHint drops un-kept low-confidence words", "world" not in lines[1]["themeHint"] and "family" in lines[1]["themeHint"], lines[1]["themeHint"])

# ── 6. end-rhyme scheme paired across phrases (AABB couplets) ──────────────────────────
check("rhymeGroup pairs phrases into couplets (A A B)", [l["rhymeGroup"] for l in lines] == ["A", "A", "B"], str([l["rhymeGroup"] for l in lines]))

# ── 7. INTEGRATION: the attached score blob feeds author_score on the ABSOLUTE grid ───
# Give each line an asserted text of exactly its slot count (monosyllables → 1:1 fit).
texts = ["one two three", "four five", "six seven"]
authored_lines = [{"text": t, "asserted": True, "score": l["score"]} for t, l in zip(texts, lines)]
r = sx.author_score(authored_lines)
check("flow score blobs author_score cleanly", r.get("ok") and r.get("linesUsed") == 3, str(r.get("error")))
if r.get("ok"):
    toks = r["score"][0]["text"].split()
    types = r["score"][0]["note_type"].split()
    durs = [float(d) for d in r["score"][0]["duration"].split()]
    check("timeline is ABSOLUTE: leading <SP> == first slot start (0.5s)",
          toks[0] == "<SP>" and types[0] == "1" and abs(durs[0] - 0.5) < 0.02, f"{toks[:2]} {durs[:2]}")
    # phrase A ends at 1.5, phrase B starts at 3.0 -> a ~1.5s inter-phrase rest must appear
    inter = [durs[i] for i, t in enumerate(toks) if t == "<SP>" and abs(durs[i] - 1.5) < 0.05]
    check("inter-phrase rest preserves the mumble's silence (~1.5s gap)", len(inter) >= 1, str([round(d, 2) for d in durs]))
    check("all written words land in the score", all(w in toks for w in ("one", "two", "three", "four", "five", "six", "seven")))

# ── 8. min_syllables merges un-writable tiny fragments into their NEAREST neighbor ────
# A 1-note mumble fragment can't be a standalone rhyming line — the brain crams a whole
# line onto one note (fit 0.00). Merging it into the closer neighbor keeps the take's
# timing while giving the brain a writable line. Default (min_syllables=1) is a no-op.
MERGE_SKEL = {
    "lineScores": [
        LS(0, [SLOT(0.5, 0.8, 80, 55), SLOT(0.8, 1.0, 80, 55)]),        # phrase P (2 slots), ends 1.0
        LS(1, [SLOT(1.9, 2.1, 80, 57)]),                                # tiny (1 slot), gap 0.9 from P
        LS(2, [SLOT(2.6, 2.9, 80, 59), SLOT(2.9, 3.2, 80, 59)]),        # phrase Q (2 slots), gap 0.5 from tiny
    ],
    "lineHeard": [],
}
no_merge = fs.group_by_rest(MERGE_SKEL["lineScores"], gap_s=0.35)
check("default min_syllables=1 is a no-op (3 phrases: P, tiny, Q)", len(no_merge) == 3, str([len(p['slots']) for p in no_merge]))
merged = fs.group_by_rest(MERGE_SKEL["lineScores"], gap_s=0.35, min_syllables=2)
check("min_syllables absorbs the 1-note fragment (3 -> 2 phrases)", len(merged) == 2, str([len(p['slots']) for p in merged]))
check("tiny fragment merges into the NEARER neighbor (Q, gap 0.2 < 0.9)",
      len(merged[0]["slots"]) == 2 and len(merged[1]["slots"]) == 3, str([len(p['slots']) for p in merged]))
check("merged phrase keeps time order + absolute span", merged[1]["start"] == 1.9 and abs(merged[1]["end"] - 3.2) < 1e-6)
mspec = fs.build_flow_spec(MERGE_SKEL, min_syllables=2)
check("build_flow_spec honors min_syllables (no 1-syllable lines)", all(l["syllableTarget"] >= 2 for l in mspec["lines"]))

# ── 9. preserve_words carries the mumble's KEPT words into the phrase seedText ────────
# The take's confident words (from extract.py -> mumble.py seedText anchors) must survive
# into the phrase so complete_verse fills only the GAPS. Default = blank (invent-freely).
PRESERVE_SKEL = {
    "lineScores": [
        LS(0, [SLOT(0.5, 0.8, 80, 55), SLOT(0.8, 1.1, 80, 57)]),        # bar 0
        LS(1, [SLOT(1.2, 1.5, 80, 59), SLOT(1.5, 1.8, 80, 55)]),        # bar 1 (gap 0.1 -> same phrase P)
        LS(2, [SLOT(3.5, 3.8, 80, 55), SLOT(3.8, 4.1, 80, 55)]),        # bar 2 (gap 1.7 -> phrase Q)
    ],
    "lines": [
        {"index": 0, "role": "verse", "seedText": "keep ___", "syllableTarget": 2},   # word + gap
        {"index": 1, "role": "verse", "seedText": "the fire", "syllableTarget": 2},    # two words
        {"index": 2, "role": "verse", "seedText": "___ ___", "syllableTarget": 2},     # all filler
    ],
    "lineHeard": [],
}
kept = fs.build_flow_spec(PRESERVE_SKEL, preserve_words=True)
blank = fs.build_flow_spec(PRESERVE_SKEL)   # default
check("preserve_words groups to 2 phrases (P=bars0+1, Q=bar2)", len(kept["lines"]) == 2, str([l["syllableTarget"] for l in kept["lines"]]))
check("phrase P concatenates the real words + gap across bars (slot order)",
      kept["lines"][0]["seedText"] == "keep ___ the fire", repr(kept["lines"][0]["seedText"]))
check("a filler-only phrase stays all gaps", kept["lines"][1]["seedText"] == "___ ___", repr(kept["lines"][1]["seedText"]))
check("default (preserve_words off) still blanks the seed (invent-freely)",
      all(l["seedText"] == "" for l in blank["lines"]))
check("syllableTarget unchanged by preserve_words", [l["syllableTarget"] for l in kept["lines"]] == [4, 2])

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
