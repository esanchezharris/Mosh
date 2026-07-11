#!/usr/bin/env python3
"""Golden tests for the lyric generation loop (Finish-My-Song §6, L2, fake-first).

The loop is propose → validate(phonology) → retry/repair → rank → top-N. The FAKE
backend is deterministic (constraint-aware template filler) so the whole loop — and
the automatable quality FLOOR (the validator pass-rate) — runs with zero LLM/venv and
is reproducible (run 3x -> identical). Stdlib + the phonology core only.

This proves FIT (syllables within tol, rhyme group end-words rhyme, locked words kept),
not taste — taste is the human gate (spec §11).

Run:  python3 service/lyrics/lyric_gen_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from lyrics import core  # noqa: E402
from phonology import core as _ph  # noqa: E402

fails = []

# RHYME grading needs a real pronunciation dictionary: the fake generator searches cmudict for
# rhyming end words (core._P.rhyme_search), and rhymes() grades phoneme rimes. cmudict is an
# OPTIONAL dep (setup-phonology.sh; the core degrades to a spelling heuristic) — so, like
# phonology_core_test.py's real-cmudict layer, the rhyme-satisfaction checks are guarded and
# skipped-with-note when the dict is absent, "so the golden gate never fails for a missing
# optional dep." FIT along the OTHER axes (syllable target, locked/anchor-word preservation,
# determinism, gap/grid handling) is asserted unconditionally.
HAVE_DICT = _ph.Pronouncer().phones("flame") == ["F", "L", "EY1", "M"]


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def skip(name, detail=""):
    print(f"[SKIP] {name}" + (f" — {detail}" if detail else ""))


def check_dict(name, ok, detail=""):
    """A check that depends on real cmudict rhyme grading; skipped-with-note when absent."""
    if HAVE_DICT:
        check(name, ok, detail)
    else:
        skip(name, "needs cmudict (optional dep) — run setup-phonology.sh")


# A "comeback" verse/hook seed: line 0 has a FIXED end word ("flame") that anchors
# rhyme group A; lines 1–2 must rhyme to it. Line 3 is LOCKED (never regenerated).
SPEC = {
    "bpm": 142, "grid": "1/16", "topic": "comeback", "mood": "defiant",
    "explicit": "allow", "rhymeStrictness": "slant",
    "lines": [
        {"index": 0, "role": "hook", "seedText": "yeah I came back ___ ___ the flame",
         "text": "", "syllableTarget": 9, "syllableTol": 1, "stress": "",
         "rhymeGroup": "A", "rhymeStrictness": "slant", "locked": False},
        {"index": 1, "role": "verse", "seedText": "they counted me out ___ ___",
         "text": "", "syllableTarget": 8, "syllableTol": 1, "stress": "",
         "rhymeGroup": "A", "rhymeStrictness": "slant", "locked": False},
        {"index": 2, "role": "verse", "seedText": "",
         "text": "", "syllableTarget": 8, "syllableTol": 1, "stress": "",
         "rhymeGroup": "A", "rhymeStrictness": "slant", "locked": False},
        {"index": 3, "role": "verse", "seedText": "", "text": "this one stays exactly as I wrote it",
         "syllableTarget": 10, "syllableTol": 1, "stress": "",
         "rhymeGroup": "B", "rhymeStrictness": "slant", "locked": True},
    ],
}


def syl(word_or_line):
    return core.syllables(word_or_line)


# ── 1. complete() returns proposals for the fillable lines; skips the locked one ──
res = core.complete(SPEC, backend="fake")
check("complete ok", res.get("ok") is True)
lines = {l["index"]: l for l in res.get("lines", [])}
check("proposes for line 0 (fixed-end anchor)", 0 in lines and len(lines[0]["proposals"]) >= 1)
check("proposes for line 1", 1 in lines and len(lines[1]["proposals"]) >= 1)
check("proposes for line 2 (empty seed, generate from scratch)", 2 in lines and len(lines[2]["proposals"]) >= 1)
check("does NOT propose for the LOCKED line 3", 3 not in lines)

# ── 2. Each top proposal hits its syllable target within tolerance ───────────────
def top(idx):
    return lines[idx]["proposals"][0]

for idx, tgt, tol in [(0, 9, 1), (1, 8, 1), (2, 8, 1)]:
    p = top(idx)
    n = p["syllables"]
    check(f"line {idx} top proposal hits {tgt}±{tol} syllables (got {n})", abs(n - tgt) <= tol, p["text"])
    check(f"line {idx} top proposal reports syllableOk", p.get("syllableOk") is True)

# ── 3. The producer's locked seed words survive in line 0 + its fixed end is kept ─
check("line 0 keeps the fixed end word 'flame'", top(0)["endWord"] == "flame", top(0)["text"])
check("line 0 keeps a locked seed word ('came')", "came" in top(0)["text"].lower().split(), top(0)["text"])

# ── 4. Rhyme group A: lines 1 & 2 rhyme to the anchor end word ('flame') ─────────
for idx in (1, 2):
    p = top(idx)
    check_dict(f"line {idx} end word rhymes with the group-A anchor 'flame'",
               core.rhymes(p["endWord"], "flame", "slant"),
               f"{p['endWord']} :: {p['text']}")
    check_dict(f"line {idx} top proposal reports rhymeOk", p.get("rhymeOk") is True)

# ── 5. Determinism: identical spec -> identical proposals, 3x ─────────────────────
a = core.complete(SPEC, backend="fake")
b = core.complete(SPEC, backend="fake")
check("complete is deterministic (run a == run b)",
      [ [pp["text"] for pp in l["proposals"]] for l in a["lines"] ]
      == [ [pp["text"] for pp in l["proposals"]] for l in b["lines"] ])

# ── 6. Validator PASS-RATE floor — the automatable quality floor (spec §11) ──────
top_props = [top(i) for i in (0, 1, 2)]
passed = sum(1 for p in top_props if p.get("passes"))
rate = passed / len(top_props)
# pass = syllableOk AND rhymeOk AND lockedOk — so the FULL-pass floor needs real rhyme grading.
check_dict(f"validator pass-rate >= 0.8 over the top proposals (got {rate:.2f})", rate >= 0.8)

# ── 7. regenerate (a different seed) varies the proposal for one line ─────────────
r0 = core.complete(SPEC, regen={2: 0}, backend="fake")
r1 = core.complete(SPEC, regen={2: 1}, backend="fake")
check("a different regen counter varies line 2's proposal",
      r0["lines"][[l["index"] for l in r0["lines"]].index(2)]["proposals"][0]["text"]
      != r1["lines"][[l["index"] for l in r1["lines"]].index(2)]["proposals"][0]["text"])

# ── 8. fill_gap() returns just one line; suggest_next_line() the line after ───────
fg = core.fill_gap(SPEC, 1, backend="fake")
check("fill_gap(1) returns exactly line 1", [l["index"] for l in fg["lines"]] == [1])
sn = core.suggest_next_line(SPEC, after_index=0, backend="fake")
check("suggest_next_line(after=0) returns line 1", [l["index"] for l in sn["lines"]] == [1])

# ── 9. grid-inferred target when a line leaves syllableTarget at 0 ───────────────
spec2 = {"grid": "1/8", "rhymeStrictness": "slant", "topic": "night",
         "lines": [{"index": 0, "role": "verse", "seedText": "", "text": "",
                    "syllableTarget": 0, "syllableTol": 2, "rhymeGroup": "", "locked": False}]}
res2 = core.complete(spec2, backend="fake")
p2 = res2["lines"][0]["proposals"][0]
check("grid 1/8 ⇒ inferred ~8-syllable target", abs(p2["syllables"] - 8) <= 2, p2["text"])

# ── 10. EXTRACTION pins (pipeline correction 2026-07-04): his words survive the loop ──
# An extracted verbatim line (text set, gapless seed — how build_skeleton_from_clip lands
# a "sung" line) must be SKIPPED by complete() and must ANCHOR its rhyme group; a partial
# line regenerates but keeps every heard anchor word.
spec3 = {"grid": "1/16", "rhymeStrictness": "slant", "topic": "", "mood": "",
         "lines": [
             {"index": 0, "role": "verse", "seedText": "cold nights taught me how to hold the flame",
              "text": "cold nights taught me how to hold the flame",
              "syllableTarget": 9, "syllableTol": 1, "rhymeGroup": "A", "locked": False},
             {"index": 1, "role": "verse", "seedText": "they ___ me ___ ___",
              "text": "", "syllableTarget": 8, "syllableTol": 1, "rhymeGroup": "A", "locked": False},
         ]}
res3 = core.complete(spec3, backend="fake")
out_idx = [l["index"] for l in res3["lines"]]
check("extracted verbatim line is SKIPPED (never regenerated)", 0 not in out_idx, str(out_idx))
gap_line = res3["lines"][out_idx.index(1)]
props3 = gap_line["proposals"]
check("gap line still generates", len(props3) >= 1)
check("partial line keeps every heard anchor word",
      all(w in props3[0]["text"].split() for w in ("they", "me")), props3[0]["text"])
check_dict("gap line rhymes against the EXTRACTED line's end word (group A anchored by 'flame')",
           bool(props3[0].get("passes")), str(props3[0]))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
