#!/usr/bin/env python3
"""Golden tests for the product-side frequency-ranked rhyme pipeline (freq.py).

The FMS lyrics bench proved (PROGRAM.md, 2026-07-28) that rhyme_search's
(grade, syllables, ALPHABETICAL) sort + cap keeps the alphabetically-early slice
of a rime family: truth-in-pool coverage at cap 200 was 40.0% alphabetical vs
89.3% with a corpus-frequency tiebreak. freq.py is the PRODUCT port: a vendored
general-English rank table + the proven truncation pipeline (uncapped scan,
stopword/len>=3 filter BEFORE the cap, then cap).

The pipeline fixture is built so a rime family is LARGER than the cap — a small
family makes cap semantics invisible (a filter-after-cap sabotage would pass).
Alphabetical and frequency orders genuinely differ, stopwords carry top
frequency, and a 2-syllable word carries an astronomical count, so each ranking
rule is individually falsifiable.

Run:  python3 service/phonology/phonology_freq_test.py     (exit 0 = all pass)
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from phonology import core, freq  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── 1. The stop list is a FROZEN product copy, drift-pinned against the bench's ──
# measured list (400 real floor picks found 'been/an/a/they/but'; PROGRAM.md
# 2026-07-26). A frozen copy + this equality test means a bench edit cannot
# silently change shipped /get_rhymes output — divergence is a red test, i.e. a
# conscious decision (same discipline mask.py applies against style_corpus).
from lyrics.bench.mask import STOP_AND_FILLER as BENCH_STOP  # noqa: E402

check("product stop list is byte-equal to the bench's measured list",
      freq.STOP_AND_FILLER == BENCH_STOP,
      f"±{len(freq.STOP_AND_FILLER ^ BENCH_STOP)} symmetric-difference words")
check("stop list is a frozenset", isinstance(freq.STOP_AND_FILLER, frozenset))

# ── 2. load_freq: rank-implicit table (word → N-i, higher = more frequent) ──────
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "ranks.txt")
    with open(p, "w", encoding="utf-8") as f:
        f.write("alpha\nbravo\ncharlie\n")
    t = freq.load_freq(p)
    check("load_freq ranks descending by line order",
          t == {"alpha": 3, "bravo": 2, "charlie": 1}, str(t))
    check("missing file loads as empty (graceful degradation, never a crash)",
          freq.load_freq(os.path.join(td, "nope.txt")) == {})

    dup = os.path.join(td, "dup.txt")
    with open(dup, "w", encoding="utf-8") as f:
        f.write("alpha\n\nbravo\nalpha\n")
    td_tab = freq.load_freq(dup)
    check("blank lines skipped, first (most frequent) duplicate wins",
          set(td_tab) == {"alpha", "bravo"} and td_tab["alpha"] > td_tab["bravo"] > 0,
          str(td_tab))

    # Env override: points the product at a different table (the owner can aim it
    # at the corpus-derived bench table; users get the vendored default).
    os.environ["MOSH_FREQ_TABLE"] = p
    try:
        check("MOSH_FREQ_TABLE overrides the default path",
              freq.load_freq() == {"alpha": 3, "bravo": 2, "charlie": 1})
    finally:
        del os.environ["MOSH_FREQ_TABLE"]

# ── 3. The vendored table itself (no cmudict needed — pure file smoke) ──────────
real = freq.load_freq()
check("vendored table loads and is big enough to matter", len(real) >= 40000,
      f"{len(real)} entries")
check("'the' is the most frequent word", real.get("the") == max(real.values()))
check("everyday vocabulary is covered", "money" in real and "day" in real)
check("the junk class the fix sinks is NOT in the table",
      "booz" not in real and "brack" not in real)
check("order sanity: money outranks essay", real.get("money", 0) > real.get("essay", 0))
check("load_freq caches (same object back for the same path)",
      freq.load_freq() is real)

# ── 4. ranked_rhymes: the proven truncation pipeline on a synthetic lexicon ─────
# One EY1 rime family, every member a PERFECT rhyme of the query, so the sort is
# decided purely by (syllables, tiebreak) — the axis under test. Family size 16
# vs cap 5: the cap is doing real work.
_JUNK = [f"aaay{c}" for c in "abcdefghij"]          # alphabetically-early, freq 0
LEX = {"day": [["D", "EY1"]],
       "they": [["DH", "EY1"]],                     # stopword — top frequency
       "yea": [["Y", "EY1"]],                       # filler — high frequency
       "fa": [["F", "EY1"]],                        # len<3 — high frequency
       "way": [["W", "EY1"]], "say": [["S", "EY1"]],
       "play": [["P", "L", "EY1"]], "stay": [["S", "T", "EY1"]],
       "gray": [["G", "R", "EY1"]],
       "essay": [["EH0", "S", "EY1"]]}              # 2 syllables, astronomical freq
LEX.update({j: [["B", "EY1"]] for j in _JUNK})
FREQ = {"they": 1000, "fa": 950, "yea": 900, "way": 500, "say": 400,
        "play": 300, "stay": 200, "gray": 100, "essay": 10 ** 9}
P = core.Pronouncer(lexicon=LEX)

alpha_direct = P.rhyme_search("day", "perfect", max_n=5)
check("fixture exhibits the failure: the alpha cap keeps ONLY junk",
      alpha_direct == sorted(_JUNK)[:5], str(alpha_direct))

got = freq.ranked_rhymes(P, "day", "perfect", max_n=5, freq=FREQ)
check("freq pipeline: commonest real words survive the cap, junk+stop+short don't",
      got == ["way", "say", "play", "stay", "gray"], str(got))
check("the cap keeps DIFFERENT words under the two orderings (the whole point)",
      set(got).isdisjoint(alpha_direct))
# Filter order is load-bearing: they/fa/yea out-frequency every real word, so a
# filter-AFTER-cap implementation returns only ['way','say'] here (3 of the 5 cap
# slots consumed then vanished) — the shrunken-pool failure the bench RED-proved.
got3 = freq.ranked_rhymes(P, "day", "perfect", max_n=3, freq=FREQ)
check("stopword/len filter runs BEFORE the cap (no shrunken pool)",
      got3 == ["way", "say", "play"], str(got3))
check("syllable count still dominates frequency (10^9 can't jump the queue)",
      "essay" not in freq.ranked_rhymes(P, "day", "perfect", max_n=10, freq=FREQ))
check("syllables= filter passes through",
      freq.ranked_rhymes(P, "day", "perfect", max_n=5, syllables=2, freq=FREQ)
      == ["essay"])
check("empty table degrades byte-identically to the historical alpha path",
      freq.ranked_rhymes(P, "day", "perfect", max_n=5, freq={}) == alpha_direct)
check("deterministic across calls",
      freq.ranked_rhymes(P, "day", "perfect", max_n=5, freq=FREQ)
      == freq.ranked_rhymes(P, "day", "perfect", max_n=5, freq=FREQ))

# freq=None loads the default table (env-overridden here to the fixture's order,
# so this also proves the default-loading path feeds the pipeline).
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "ranks.txt")
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(["they", "fa", "yea", "way", "say", "play", "stay",
                           "gray"]) + "\n")
    os.environ["MOSH_FREQ_TABLE"] = p
    try:
        got_env = freq.ranked_rhymes(P, "day", "perfect", max_n=5)
        check("freq=None loads the (env-resolved) default table",
              got_env == ["way", "say", "play", "stay", "gray"], str(got_env))
    finally:
        del os.environ["MOSH_FREQ_TABLE"]

# ── 5. get_rhymes serves the pipeline — the single seam behind BOTH /get_rhymes
# paths (server in-process fallback AND the phonology-venv CLI, which calls
# core.get_rhymes too). Wiring here means the UI rhyme helper stops showing the
# alphabetical booz/brack slice with no server.py change at all. ───────────────
with tempfile.TemporaryDirectory() as td:
    p = os.path.join(td, "ranks.txt")
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(["they", "fa", "yea", "way", "say", "play", "stay",
                           "gray"]) + "\n")
    os.environ["MOSH_FREQ_TABLE"] = p
    try:
        env = core.get_rhymes("day", strictness="perfect", max_n=5, pronouncer=P)
        check("get_rhymes candidates are freq-truncated",
              [c["word"] for c in env["candidates"]]
              == ["way", "say", "play", "stay", "gray"],
              str([c["word"] for c in env["candidates"]]))
        check("get_rhymes reports its ranking", env.get("rankedBy") == "freq")
        check("get_rhymes envelope contract unchanged",
              env["ok"] and env["word"] == "day" and env["inDict"]
              and env["queryPhones"] == ["D", "EY1"]
              and all(set(c) == {"word", "syllables", "grade"}
                      for c in env["candidates"]))
    finally:
        del os.environ["MOSH_FREQ_TABLE"]
    os.environ["MOSH_FREQ_TABLE"] = os.path.join(td, "nope.txt")
    try:
        env2 = core.get_rhymes("day", strictness="perfect", max_n=5, pronouncer=P)
        check("get_rhymes with no table is byte-identical alpha, and says so",
              [c["word"] for c in env2["candidates"]] == alpha_direct
              and env2.get("rankedBy") == "alpha",
              str([c["word"] for c in env2["candidates"]]))
    finally:
        del os.environ["MOSH_FREQ_TABLE"]

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
