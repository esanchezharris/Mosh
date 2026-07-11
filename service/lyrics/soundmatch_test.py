#!/usr/bin/env python3
"""Golden tests for soundmatch — how much does a written line ECHO the mumble's sound?

The old fit metric only counted syllables, so an invented line unrelated to the take could
score 100%. soundmatch compares the VOWEL BACKBONE (assonance) of two lines — so we can pick
real words that sound like what was mumbled, and give an honest "sounds like your take"
score. Deterministic (difflib over ARPAbet vowels from the phonology core).

Run:  python3 service/lyrics/soundmatch_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import soundmatch as sm  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


TARGET = "cats in hats"                 # vowels ~ AE IH AE
ECHO = "bats and rats"                  # vowels ~ AE AH AE  (close)
UNRELATED = "who chose blue"            # vowels ~ UW OW UW  (far)

s_echo = sm.similarity(ECHO, TARGET)
s_unrel = sm.similarity(UNRELATED, TARGET)

# ── 1. range + self-similarity ────────────────────────────────────────────────────────
check("similarity is in [0,1]", 0.0 <= s_echo <= 1.0 and 0.0 <= s_unrel <= 1.0, f"{s_echo:.2f}/{s_unrel:.2f}")
check("a line is a perfect echo of itself", sm.similarity(TARGET, TARGET) == 1.0)

# ── 2. the vowel-echo scores higher than the unrelated line (the whole point) ─────────
check("echo scores higher than unrelated", s_echo > s_unrel, f"echo {s_echo:.2f} > unrelated {s_unrel:.2f}")

# ── 3. empty handling ─────────────────────────────────────────────────────────────────
check("both empty -> 1.0", sm.similarity("", "") == 1.0)
check("one empty -> 0.0", sm.similarity("", "cats") == 0.0)
# a line with no pronounceable vowels (pure gaps) doesn't crash
check("gap-only text is handled", 0.0 <= sm.similarity("___ ___", TARGET) <= 1.0)

# ── 4. deterministic ──────────────────────────────────────────────────────────────────
check("similarity is deterministic", sm.similarity(ECHO, TARGET) == s_echo)

# ── 5. rank puts the closest-sounding candidate first ─────────────────────────────────
ranked = sm.rank([UNRELATED, ECHO, "cats in hats"], TARGET)
check("rank returns (text, score) sorted desc", [r[1] for r in ranked] == sorted((r[1] for r in ranked), reverse=True))
check("the exact echo ranks first", ranked[0][0] == "cats in hats" and ranked[0][1] == 1.0, str(ranked[0]))
check("the vowel-echo outranks the unrelated line", ranked[1][0] == ECHO, str([r[0] for r in ranked]))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
