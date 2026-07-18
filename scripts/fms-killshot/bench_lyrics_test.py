#!/usr/bin/env python3
"""Goldens for the true-lyrics word source (pure parsing + window snapping; no audio).

Run:  python3 scripts/fms-killshot/bench_lyrics_test.py   (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_lyrics as bl  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── normalization: apostrophes are LOAD-BEARING (they carry the syllable count) ──────────
check("keeps the elision apostrophe ('bout is 1 syllable, about is 2)",
      bl.normalize_word("'bout") == "'bout")
check("keeps a word-internal apostrophe", bl.normalize_word("I'm") == "i'm")
check("straightens a curly apostrophe", bl.normalize_word("’em") == "'em")
check("strips trailing punctuation", bl.normalize_word("bottom,") == "bottom")
check("collapses a written-out elongation (a melisma, not a dictionary word)",
      bl.normalize_word("sheee") == "she")
check("leaves a legitimate double letter alone", bl.normalize_word("fumbling") == "fumbling")
check("keeps non-ascii the singer actually wrote", bl.normalize_word("piñata") == "piñata")
check("drops a bare punctuation token", bl.normalize_word("-") == "")

# ── parsing: one line = one phrase; parentheticals are commentary, not lyrics ────────────
toks = bl.parse_lyrics("we been busy 'bout 'em\nlooking back she got a fat (kinda cut off)\n")
check("splits lines into phrases", {t["phrase"] for t in toks} == {0, 1})
check("phrase 0 words", [t["word"] for t in toks if t["phrase"] == 0]
      == ["we", "been", "busy", "'bout", "'em"])
check("parenthetical aside is dropped, lyrics kept",
      [t["word"] for t in toks if t["phrase"] == 1] == ["looking", "back", "she", "got", "a", "fat"])
check("blank lines make no empty phrase", all(t["word"] for t in bl.parse_lyrics("a\n\n\nb")))

# ── phrase windows + snapping (the fixed-stopwatch cut is the bug being fixed) ───────────
W = [{"phrase": 0, "word": "a", "start": 0.5, "end": 1.0},
     {"phrase": 0, "word": "b", "start": 1.0, "end": 4.0},
     {"phrase": 1, "word": "c", "start": 4.5, "end": 8.0},
     {"phrase": 2, "word": "d", "start": 8.5, "end": 13.5}]
check("phrase_windows spans each phrase first→last word",
      bl.phrase_windows(W) == [(0, 0.5, 4.0), (1, 4.5, 8.0), (2, 8.5, 13.5)])
check("phrase_windows ignores unaligned words",
      bl.phrase_windows(W + [{"phrase": 3, "word": "x", "start": None, "end": None}])[-1][0] == 2)

check("snap_window ends on a phrase gap, never mid-phrase",
      bl.snap_window(W, 12.0) == (0.5, 8.0),
      "phrase 2 would end at 13.5 > 12s limit, so stop after phrase 1")
check("snap_window starts at the first sung word, not t=0",
      bl.snap_window(W, 12.0)[0] == 0.5)
check("snap_window takes MORE phrases when the limit allows",
      bl.snap_window(W, 14.0) == (0.5, 13.5))
check("snap_window falls back to the hard limit if phrase 1 alone overruns",
      bl.snap_window([{"phrase": 0, "word": "a", "start": 0.0, "end": 30.0}], 12.0) == (0.0, 12.0))
check("snap_window on no aligned words is the plain limit",
      bl.snap_window([], 12.0) == (0.0, 12.0))

# ── the syllable-count claim this whole module exists for ───────────────────────────────
# (spelling drives the pronouncer; these are the exact pairs measured against Whisper)
check("'bout vs about is a real spelling difference the parser preserves",
      bl.normalize_word("'bout") != bl.normalize_word("about"))
check("piñata survives as one token (Whisper split it into 'pin yet')",
      [t["word"] for t in bl.parse_lyrics("smashing the piñata")] == ["smashing", "the", "piñata"])

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
