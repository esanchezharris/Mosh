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

# ── 6. v2: GRADED vowel similarity (mouth space, not symbol equality) ──────────────────
# The owner's mouth-shape verdict: exact-symbol matching can't hear that "bit" is a near
# miss for "beat" while "bot" is not. Vowels live in a mouth space (height/backness/
# rounding); similarity is graded by distance in it.
check("identical vowels are 1.0", sm.vowel_similarity("IY", "IY") == 1.0)
check("stress digits are ignored", sm.vowel_similarity("IY1", "IY0") == 1.0)
check("neighbors are close (IY~IH)", sm.vowel_similarity("IY", "IH") > 0.7,
      f"{sm.vowel_similarity('IY', 'IH'):.2f}")
check("cot~caught are close (AA~AO)", sm.vowel_similarity("AA", "AO") > 0.6,
      f"{sm.vowel_similarity('AA', 'AO'):.2f}")
check("opposite corners are far (IY~AA)", sm.vowel_similarity("IY", "AA") < 0.35,
      f"{sm.vowel_similarity('IY', 'AA'):.2f}")
check("distance is ordered (IH closer to IY than EH, EH closer than AA)",
      sm.vowel_similarity("IY", "IH") > sm.vowel_similarity("IY", "EH") > sm.vowel_similarity("IY", "AA"))

# ── 7. v2: per-syllable sounds — vowel + onset consonant class ─────────────────────────
snd = sm.syllable_sounds("water")        # W AO1 T ER0 -> [WAO][TER]
check("syllable_sounds splits per syllable", len(snd) == 2, str(snd))
check("first syllable carries vowel + onset", snd[0]["vowel"] == "AO" and snd[0]["onset"] == "W", str(snd))
check("second syllable onset is T", snd[1]["onset"] == "T" and snd[1]["vowel"] == "ER", str(snd))
check("vowel-initial syllable has no onset", sm.syllable_sounds("eat")[0]["onset"] is None,
      str(sm.syllable_sounds("eat")))
check("junk word yields no sounds", sm.syllable_sounds("") == [])

check("same-class onsets are close (B~P, both lips)",
      sm.onset_similarity("B", "P") > sm.onset_similarity("B", "K"),
      f"B~P {sm.onset_similarity('B', 'P'):.2f} vs B~K {sm.onset_similarity('B', 'K'):.2f}")
check("identical onset is 1.0", sm.onset_similarity("T", "T") == 1.0)

# ── 8. v2: mouth similarity of a candidate line vs the take's heard sounds ─────────────
# The take heard "top of a cup of water" (junk as words, gold as sounds). A line that
# echoes those mouth shapes must outscore one that ignores them.
targets = sm.text_sounds("top of a cup of water")
check("text_sounds flattens words to ordered syllable sounds", len(targets) == 7, str(len(targets)))
close = sm.mouth_similarity("not a lot of stuff to squander", targets)
far = sm.mouth_similarity("we remain easy tonight please", targets)
check("mouth similarity is in [0,1]", 0.0 <= close <= 1.0 and 0.0 <= far <= 1.0)
check("sound-alike line outscores the unrelated line", close > far + 0.15,
      f"close {close:.2f} vs far {far:.2f}")
check("the heard words themselves score ~perfect",
      sm.mouth_similarity("top of a cup of water", targets) > 0.95,
      f"{sm.mouth_similarity('top of a cup of water', targets):.2f}")
# min-normalization: the line's length is FIXED by the slot grid while Whisper hears the
# take's full activity — a short line fully echoing a stretch of the movie is a full echo
# (max-normalization made the floor unreachable on 10/17 real lines).
check("a short line fully echoing a stretch of the movie scores ~1.0",
      sm.mouth_similarity("cup of water", targets) > 0.95,
      f"{sm.mouth_similarity('cup of water', targets):.2f}")
check("a mouth-blind short line stays low despite min-normalization",
      sm.mouth_similarity("now we strangers", targets) < 0.45,
      f"{sm.mouth_similarity('now we strangers', targets):.2f}")
check("empty targets -> neutral 1.0", sm.mouth_similarity("anything", []) == 1.0)
check("mouth similarity is deterministic",
      sm.mouth_similarity("not a lot of stuff to squander", targets) == close)

# ── 9. adversarial-review fixes (2026-07-12) ───────────────────────────────────────────
# (a) OOV words occupy their syllables as UNMATCHABLE placeholders — a slang-heavy line
# can no longer vanish its unpronounceable words and grade only on its dictionary ones
# (confirmed exploit: "top shmurda skrrt brazy vibin'" scored 1.0 by silently dropping
# 4 of 5 words from the sequence).
oov = sm.syllable_sounds("shmurda")
check("OOV word yields placeholder sounds (counted, unmatchable)",
      len(oov) >= 1 and all(s["vowel"] is None for s in oov), str(oov))
exploit = sm.mouth_similarity("top shmurda skrrt brazy vibin'", targets)
check("the OOV exploit line no longer maxes the metric", exploit < 0.35, f"{exploit:.2f}")

# (b) WINDOWED alignment: a long mouth-blind line can't cherry-pick in-order matches
# across its whole length (confirmed: "never gonna give you up..." scored 0.714 against
# 4 targets under the global free-gap DP). The short side must echo a LOCALIZED stretch.
# Note: a mostly-SCHWA movie ("top of a cup" = AH AH AH + one AA) legitimately scores
# high against any English line — schwa is the neutral mouth; the gate-ARMING rule in
# lyrics.core (>=3 distinctive vowels) is what keeps generic evidence from rejecting.
td = sm.text_sounds("my old flame glows")     # AY OW EY OW — a DISTINCTIVE movie
for blind in ["never gonna give you up never gonna let you down",
              "the moon is high and every star reminds me of her eyes",
              "running through the fire with the feeling in my chest"]:
    v = sm.mouth_similarity(blind, td)
    check(f"long blind line stays under the floor: {blind[:26]}…", v < 0.5, f"{v:.2f}")
check("a genuine echo of the distinctive movie clears it",
      sm.mouth_similarity("why so cold tonight", td) > 0.55,
      f"{sm.mouth_similarity('why so cold tonight', td):.2f}")
check("localized sub-echo survives windowing",
      sm.mouth_similarity("cup of water", targets) > 0.95,
      f"{sm.mouth_similarity('cup of water', targets):.2f}")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
