#!/usr/bin/env python3
"""Golden tests for the deterministic phonology core (Finish-My-Song §4).

Two layers, both stdlib-only and DETERMINISTIC (run 3x -> identical):
  1. The ALGORITHM (rime extraction, slant grading, syllable-from-phones, stress
     contour) tested on injected ARPAbet phone lists — no dictionary dependency, so
     it is hermetic and reproducible on any machine.
  2. The stdlib HEURISTIC fallback (vowel-group syllables) used when no dictionary
     is present — also hermetic.

A third, BONUS layer exercises the real `pronouncing`/cmudict path end-to-end when
that package is importable (it is on the owner's machine, where the gate runs); it is
skipped-with-note otherwise so the golden gate never fails for a missing optional dep.

The load-bearing requirement: rhyme is PHONEME-based, never spelling-based —
'love'/'move' look like a rhyme but are NOT a perfect rhyme (AH-V vs UW-V).

Run:  python3 service/phonology/phonology_core_test.py     (exit 0 = all pass)
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from phonology import core  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def skip(name, detail=""):
    print(f"[SKIP] {name}" + (f" — {detail}" if detail else ""))


# ── 1. Syllable count from phones = number of vowel phones (stress-digit carriers) ──
check("syllables(cat=K AE1 T) == 1", core.syllable_count_phones(["K", "AE1", "T"]) == 1)
check("syllables(table=T EY1 B AH0 L) == 2",
      core.syllable_count_phones(["T", "EY1", "B", "AH0", "L"]) == 2)
check("syllables(banana=B AH0 N AE1 N AH0) == 3",
      core.syllable_count_phones(["B", "AH0", "N", "AE1", "N", "AH0"]) == 3)
check("syllables(empty) == 0", core.syllable_count_phones([]) == 0)

# ── 2. Stress contour: X = primary/secondary (1/2), x = unstressed (0), per syllable ──
check("stress(banana) == 'xXx'",
      core.stress_contour_phones(["B", "AH0", "N", "AE1", "N", "AH0"]) == "xXx")
check("stress(cat) == 'X'", core.stress_contour_phones(["K", "AE1", "T"]) == "X")
check("stress(secondary 2 counts as stressed)",
      core.stress_contour_phones(["S", "EH2", "K", "AH0"]) == "Xx")

# ── 3. Rime = from the last STRESSED vowel to the end ─────────────────────────────
check("rime(flame=F L EY1 M) == [EY1, M]",
      core.rime_phones(["F", "L", "EY1", "M"]) == ["EY1", "M"])
check("rime(banana) starts at the last stressed vowel AE1",
      core.rime_phones(["B", "AH0", "N", "AE1", "N", "AH0"]) == ["AE1", "N", "AH0"])

# ── 4. Rhyme grade — PHONEME-based, graded perfect -> slant -> none ───────────────
def g(a, b):
    return core.rhyme_grade(a, b)


cat = ["K", "AE1", "T"]; hat = ["HH", "AE1", "T"]; bad = ["B", "AE1", "D"]
dog = ["D", "AO1", "G"]; flame = ["F", "L", "EY1", "M"]; name = ["N", "EY1", "M"]
love = ["L", "AH1", "V"]; move = ["M", "UW1", "V"]

check("perfect: cat/hat (AE1 T == AE1 T)", g(cat, hat) == "perfect")
check("perfect: flame/name (EY1 M == EY1 M)", g(flame, name) == "perfect")
check("perfect ignores the stress DIGIT (AE1 T vs AE2 T)",
      g(cat, ["B", "AE2", "T"]) == "perfect")
check("slant (assonance): cat/bad — same vowel AE, diff coda", g(cat, bad) == "slant")
check("slant (consonance): love/move — diff vowel, shared coda V", g(love, move) == "slant")
check("love/move is NOT a perfect rhyme (spelling would say it is)",
      g(love, move) != "perfect")
check("none: cat/dog — different vowel AND coda", g(cat, dog) == "none")
check("rhyme_grade is symmetric", g(love, move) == g(move, love))

# ── 5. Stdlib heuristic syllables (OOV / no-dict path) — reliable vowel-group cases ──
check("heuristic 'beat' == 1 (one vowel group 'ea')", core.heuristic_syllables("beat") == 1)
check("heuristic 'rapping' == 2", core.heuristic_syllables("rapping") == 2)
check("heuristic 'hello' == 2", core.heuristic_syllables("hello") == 2)
check("heuristic 'money' == 2 (trailing y is a vowel)", core.heuristic_syllables("money") == 2)
# Diacritics fold to their base letter instead of being deleted — "piñata" used to strip to
# "piata" (2 vowel groups) and, worse, reach g2p with the N deleted (the sung nonsense word).
check("fold_diacritics: piñata -> pinata", core.fold_diacritics("piñata") == "pinata")
check("fold_diacritics: naïve -> naive", core.fold_diacritics("naïve") == "naive")
check("fold_diacritics is identity on ASCII", core.fold_diacritics("rapping") == "rapping")
check("heuristic 'piñata' == 3 (ñ folds, not deleted)", core.heuristic_syllables("piñata") == 3)
check("fold_diacritics deterministic", core.fold_diacritics("piñata") == core.fold_diacritics("piñata"))
check("heuristic no-vowel token clamps to 1 ('skrt')", core.heuristic_syllables("skrt") == 1)
check("heuristic empty token == 0", core.heuristic_syllables("") == 0)

# ── 6. Pronouncer over an INJECTED dict — deterministic, no real-dict dependency ──
mini = {
    "flame": [["F", "L", "EY1", "M"]],
    "name": [["N", "EY1", "M"]],
    "blame": [["B", "L", "EY1", "M"]],
    "cat": [["K", "AE1", "T"]],
    "table": [["T", "EY1", "B", "AH0", "L"]],
}
p = core.Pronouncer(lexicon=mini)
check("Pronouncer.syllables('table') == 2", p.syllables("table") == 2)
check("Pronouncer.rhyme('flame','name', slant) is True", p.rhyme("flame", "name", "slant") is True)
check("Pronouncer.rhyme('flame','cat') is False", p.rhyme("flame", "cat", "slant") is False)
check("Pronouncer.rhyme perfect-strictness rejects a slant pair",
      p.rhyme("cat", "table", "perfect") is False)
rs = p.rhyme_search("flame", strictness="slant", max_n=10)
check("rhyme_search('flame') returns ranked words incl. name & blame",
      "name" in rs and "blame" in rs and "flame" not in rs, str(rs))
rs2 = p.rhyme_search("flame", strictness="slant", max_n=10)
check("rhyme_search is deterministic (same order across calls)", rs == rs2, f"{rs} vs {rs2}")

# ── 7. Pronouncer OOV falls back to the heuristic (no crash, sensible count) ───────
check("Pronouncer.syllables(OOV 'skrrt') uses heuristic >= 1", p.syllables("skrrt") >= 1)

# ── 8. BONUS: real pronouncing/cmudict path (skipped if the package is absent) ─────
if importlib.util.find_spec("pronouncing") is not None:
    rp = core.Pronouncer()  # default lookup = real dictionary
    check("real: syllables('banana') == 3", rp.syllables("banana") == 3)
    check("real: 'cat'/'hat' perfect", rp.rhyme("cat", "hat", "perfect") is True)
    check("real: 'love'/'move' NOT perfect", rp.rhyme("love", "move", "perfect") is False)
    real_rhymes = rp.rhyme_search("cat", strictness="perfect", max_n=50)
    check("real: rhyme_search('cat', perfect) contains 'hat'", "hat" in real_rhymes, str(real_rhymes[:10]))
else:
    skip("real pronouncing/cmudict path", "pronouncing not importable (run setup-phonology.sh)")

# ── 9. LAYERED pronouncer (Bar IQ A): user-lexicon → cmudict → g2p → heuristic ─────
# Injected fake g2p (deterministic) proves the LAYER logic without g2p_en installed.
def fake_g2p(word):
    return {
        "skrrt": ["S", "K", "R", "AA1", "R", "T"],
        "drip": ["D", "R", "IH1", "P"],
        "whip": ["W", "IH1", "P"],
    }.get(word.lower())


lp = core.Pronouncer(lexicon=mini, user_lexicon={"flame": ["F", "L", "AA1", "M"]}, g2p=fake_g2p)
check("user-lexicon OVERRIDES cmudict (flame → AA1, not cmudict EY1)",
      lp.phones("flame") == ["F", "L", "AA1", "M"])
check("cmudict still used when not overridden (name → EY1 M)", lp.phones("name") == ["N", "EY1", "M"])
check("g2p fills an OOV word (skrrt → real phones, not None)", lp.phones("skrrt") == ["S", "K", "R", "AA1", "R", "T"])
check("g2p OOV syllable count is phoneme-precise (skrrt → 1)", lp.syllables("skrrt") == 1)
check("OOV-vs-OOV rhyme works via g2p (drip/whip → perfect)", lp.rhyme("drip", "whip", "perfect") is True)
check("a word in NEITHER lexicon nor g2p → heuristic (no crash)", lp.syllables("zzqxj") >= 1)
# precedence: a callable returning None disables the g2p layer (heuristic for OOV).
lp_nog2p = core.Pronouncer(lexicon=mini, g2p=lambda w: None)
check("g2p disabled ⇒ OOV phones None (heuristic syllables)", lp_nog2p.phones("skrrt") is None and lp_nog2p.syllables("skrrt") >= 1)

# ── 10. BONUS: REAL g2p (g2p_en) — any slang word rhymes/scans (skipped if absent) ──
if importlib.util.find_spec("g2p_en") is not None:
    rg = core.Pronouncer()   # default: real cmudict + lazy-loaded g2p_en
    check("real g2p: OOV 'skrrt' gets phones (not None)", rg.phones("skrrt") is not None)
    check("real g2p: slang 'drip'/'whip' perfect-rhyme", rg.rhyme("drip", "whip", "perfect") is True)
    check("real g2p: coined 'flexin' scans (>=2 syllables)", rg.syllables("flexin") >= 2)
else:
    skip("real g2p_en path", "g2p_en not importable (run setup-phonology.sh)")

# ── 11. Rhyme CRAFT (Bar IQ C): multisyllabic depth + internal-rhyme detection ────
# multisyllabic depth = length of the longest common TRAILING vowel run (the essence of
# multisyllabic / assonant rhyme). depth 1 = a plain end-rhyme; depth >= 2 = multisyllabic.
city = ["S", "IH1", "T", "IY0"]; pity = ["P", "IH1", "T", "IY0"]
make_it = ["M", "EY1", "K", "IH0", "T"]; take_it = ["T", "EY1", "K", "IH0", "T"]
check("vowels_of(banana) == [AH, AE, AH]",
      core.vowels_of(["B", "AH0", "N", "AE1", "N", "AH0"]) == ["AH", "AE", "AH"])
check("multisyllabic depth: city/pity == 2 (IH, IY)", core.multisyllabic_depth(city, pity) == 2)
check("multisyllabic depth: 'make it'/'take it' == 2 (EY, IH)", core.multisyllabic_depth(make_it, take_it) == 2)
check("multisyllabic depth: cat/hat == 1 (single end vowel)", core.multisyllabic_depth(cat, hat) == 1)
check("multisyllabic depth: cat/dog == 0 (no shared trailing vowel)", core.multisyllabic_depth(cat, dog) == 0)
check("multisyllabic depth is symmetric", core.multisyllabic_depth(city, pity) == core.multisyllabic_depth(pity, city))

# internal rhyme: rhyming word pairs WITHIN a line (a hallmark of skilled flow).
line = [("money", ["M", "AH1", "N", "IY0"]), ("sunny", ["S", "AH1", "N", "IY0"]),
        ("today", ["T", "AH0", "D", "EY1"])]
pairs = core.internal_rhyme_pairs(line, "slant")
check("internal_rhyme_pairs finds money~sunny (indices 0,1)", (0, 1) in pairs, str(pairs))
check("internal_rhyme_pairs excludes the non-rhyming 'today'", (0, 2) not in pairs and (1, 2) not in pairs, str(pairs))
check("internal_rhyme_pairs is deterministic", core.internal_rhyme_pairs(line, "slant") == pairs)

# ── 12. Syllabify phones (FMS sung-render fix): split a word's ARPAbet into per-syllable
# phone groups so a multi-slot word PROGRESSES ("gon"→"na") instead of re-articulating the
# whole word on every slot. Onset-maximal for singletons; a cluster keeps its last consonant
# as the next syllable's onset. LOSSLESS: the groups concatenate back to the input. ────────
check("syllabify(cat=K AE1 T) == one group (1 syllable)",
      core.syllabify_phones(["K", "AE1", "T"]) == [["K", "AE1", "T"]])
check("syllabify(gonna=G AA1 N AH0) == [[G,AA1],[N,AH0]] (single consonant → next onset)",
      core.syllabify_phones(["G", "AA1", "N", "AH0"]) == [["G", "AA1"], ["N", "AH0"]])
check("syllabify(table=T EY1 B AH0 L) == [[T,EY1],[B,AH0,L]]",
      core.syllabify_phones(["T", "EY1", "B", "AH0", "L"]) == [["T", "EY1"], ["B", "AH0", "L"]])
check("syllabify(again=AH0 G EH1 N) == [[AH0],[G,EH1,N]]",
      core.syllabify_phones(["AH0", "G", "EH1", "N"]) == [["AH0"], ["G", "EH1", "N"]])
check("syllabify(winter=W IH1 N T ER0) splits the cluster [[W,IH1,N],[T,ER0]] (last consonant → onset)",
      core.syllabify_phones(["W", "IH1", "N", "T", "ER0"]) == [["W", "IH1", "N"], ["T", "ER0"]])
check("syllabify(empty) == []", core.syllabify_phones([]) == [])
check("syllabify(no-vowel gibberish) == one group, never crashes",
      core.syllabify_phones(["ZZ", "QX"]) == [["ZZ", "QX"]])
_banana = ["B", "AH0", "N", "AE1", "N", "AH0"]
check("syllabify is LOSSLESS (groups concatenate back to input)",
      [p for g in core.syllabify_phones(_banana) for p in g] == _banana)
check("syllabify group count == syllable count",
      len(core.syllabify_phones(_banana)) == core.syllable_count_phones(_banana))
check("syllabify is deterministic", core.syllabify_phones(_banana) == core.syllabify_phones(_banana))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
