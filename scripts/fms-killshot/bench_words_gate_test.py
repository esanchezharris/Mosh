#!/usr/bin/env python3
"""Goldens for the take-calibrated ASR word gate (pure matching cores, no audio).

The gate's contract (registered in docs/superpowers/specs/2026-07-18-fms-word-campaign-
design.md): every lyric word the TAKE's transcription yields must appear in the render
transcript (fuzzy, time-localized); lyric words the take does NOT yield are adjudicated
by SYLLABLE COUNT in their anchor gap (take-heard syllables vs render-heard syllables) —
that is how pinata-class words (which whisper can't read even from the human take) stay
in scope.

Run:  python3 scripts/fms-killshot/bench_words_gate_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_words_gate as bwg  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def W(word, start, end=None, conf=0.9):
    return {"word": word, "start": start, "end": end if end is not None else start + 0.2,
            "confidence": conf}


# ── normalization ───────────────────────────────────────────────────────────────────────
check("norm strips punctuation/case and folds diacritics",
      bwg.norm_word(" Piñata,") == "pinata", bwg.norm_word(" Piñata,"))
check("norm strips contractions ('ve)", bwg.norm_word("I've") == "i", bwg.norm_word("I've"))
check("norm handles typographic apostrophe", bwg.norm_word("don’t") == bwg.norm_word("don't"))

# ── fuzzy matching ──────────────────────────────────────────────────────────────────────
check("fuzzy: god/good match (distance 1, len>=3)", bwg.fuzzy("god", "good"))
check("fuzzy: sleep/asleep match (distance 1)", bwg.fuzzy("sleep", "asleep"))
check("fuzzy: lit/literally do NOT match", not bwg.fuzzy("lit", "literally"))
check("fuzzy: short words exact-only (da/the)", not bwg.fuzzy("da", "the"))
check("fuzzy: I've/I match via contraction strip", bwg.fuzzy("I've", "I"))
check("fuzzy: identical after norm", bwg.fuzzy("Smashing", "smashing"))

# ── the pinata scenario (the round-r11 microscope, as fixtures) ─────────────────────────
LYRIC = "I been smashing the piñata my whole life".split()
TAKE = [W("I've", 0.00), W("been", 0.30), W("smashing", 0.60), W("the", 1.10),
        W("pin", 1.30, conf=0.78), W("yet", 1.50, conf=0.90),
        W("my", 1.90), W("whole", 2.10), W("life", 2.40)]
SPAN = (0.0, 3.0)

anchors = bwg.align_lyric(LYRIC, TAKE)
check("alignment anchors every take-yielded lyric word, monotonic",
      [LYRIC[i] for i, _ in anchors] == ["I", "been", "smashing", "the", "my", "whole", "life"],
      str(anchors))
check("piñata is NOT an anchor (take reads 'pin yet')",
      all(LYRIC[i] != "piñata" for i, _ in anchors))

demands, gaps = bwg.demand_and_gaps(LYRIC, TAKE, SPAN)
check("demand set = the 7 anchored words with take times",
      len(demands) == 7 and demands[2]["word"] == "smashing"
      and abs(demands[2]["t"] - 0.60) < 1e-9, json.dumps(demands))
check("one gap: piñata, carrying the take's own heard words pin+yet",
      len(gaps) == 1 and gaps[0]["lyricWords"] == ["piñata"]
      and [w["word"] for w in gaps[0]["takeWords"]] == ["pin", "yet"], json.dumps(gaps))
check("gap take syllables = 2 (pin + yet)", gaps[0]["takeSyl"] == 2, str(gaps[0]))

# render that collapses pinata to one syllable but sings every anchor word
RENDER_BAD = [W("I've", 0.02), W("been", 0.31), W("smashing", 0.62), W("the", 1.12),
              W("da", 1.35, conf=0.17), W("my", 1.91), W("whole", 2.12), W("life", 2.41)]
rep_bad = bwg.gate_song(LYRIC, TAKE, RENDER_BAD, SPAN)
check("bad render: zero missing anchor words", rep_bad["missing"] == [], json.dumps(rep_bad["missing"]))
check("bad render: pinata gap flagged as syllable deficit (take 2 vs render 1)",
      len(rep_bad["sylDeficits"]) == 1 and rep_bad["sylDeficits"][0]["lyricWords"] == ["piñata"]
      and rep_bad["sylDeficits"][0]["takeSyl"] == 2 and rep_bad["sylDeficits"][0]["renderSyl"] == 1,
      json.dumps(rep_bad["sylDeficits"]))
check("bad render: gate FAILS", rep_bad["pass"] is False)
check("anchor words flanking the gap do not inflate the gap's render syllables",
      rep_bad["sylDeficits"][0]["renderHeard"] == "da", json.dumps(rep_bad["sylDeficits"]))

# render that articulates the word (3 heard syllables in the gap)
RENDER_GOOD = [W("I've", 0.02), W("been", 0.31), W("smashing", 0.62), W("the", 1.12),
               W("pinata", 1.32), W("my", 1.91), W("whole", 2.12), W("life", 2.41)]
rep_good = bwg.gate_song(LYRIC, TAKE, RENDER_GOOD, SPAN)
check("good render: no misses, no deficits, gate PASSES",
      rep_good["missing"] == [] and rep_good["sylDeficits"] == [] and rep_good["pass"] is True,
      json.dumps({k: rep_good[k] for k in ("missing", "sylDeficits", "pass")}))

# a missing word: 'smashing' absent near its slot (sung nowhere / elsewhere)
RENDER_MISS = [W("I've", 0.02), W("been", 0.31), W("the", 1.12), W("pinata", 1.32),
               W("my", 1.91), W("whole", 2.12), W("life", 2.41), W("smashing", 5.0)]
rep_miss = bwg.gate_song(LYRIC, TAKE, RENDER_MISS, (0.0, 6.0))
check("missing word: 'smashing' flagged despite appearing far away (time-localized)",
      [m["word"] for m in rep_miss["missing"]] == ["smashing"], json.dumps(rep_miss["missing"]))
check("missing row reports what the render DID sing nearby",
      "renderHeard" in rep_miss["missing"][0])
check("gate fails on a missing word", rep_miss["pass"] is False)

# ── melisma calibration: the demand is the WORD's syllables, not the take's ornament ───
# (registered gate refinement, 2026-07-19: "lacoste" = 2 lexical syllables; the take's 9
# ornamented pulses are melisma, not lexical content — a render that articulates la-coste
# sounds like the word and must PASS)
LYRIC_M = "must be lacoste".split()
TAKE_M = [W("must", 0.0), W("be", 0.3),
          W("like", 0.6), W("awww", 0.9), W("way", 1.2), W("up", 1.5), W("on", 1.8),
          W("the", 2.1), W("top", 2.4), W("rope", 2.7)]      # whisper's ornament read: 9+ syl
REND_M = [W("must", 0.0), W("be", 0.3), W("lacoste", 0.8)]   # 2 heard syllables: the word
rep_m = bwg.gate_song(LYRIC_M, TAKE_M, REND_M, (0.0, 3.2))
check("melisma gap demands min(takeSyl, lyricSyl): la-coste (2) passes vs 9 ornament pulses",
      rep_m["sylDeficits"] == [] and rep_m["pass"] is True, json.dumps(rep_m["sylDeficits"]))
rep_m2 = bwg.gate_song(LYRIC_M, TAKE_M, [W("must", 0.0), W("be", 0.3), W("love", 0.8)], (0.0, 3.2))
check("but a 1-syllable collapse ('love') still fails the 2-syllable word",
      len(rep_m2["sylDeficits"]) == 1 and rep_m2["sylDeficits"][0]["demandSyl"] == 2,
      json.dumps(rep_m2["sylDeficits"]))

# ── gap with no take words = unsupported (never demanded) ──────────────────────────────
LYRIC2 = "we ride tonight".split()
TAKE2 = [W("we", 0.0), W("tonight", 1.0)]     # 'ride' never voiced by the take
rep2 = bwg.gate_song(LYRIC2, TAKE2, [W("we", 0.0), W("tonight", 1.0)], (0.0, 2.0))
check("unvoiced lyric word (take yields nothing there) is NOT demanded",
      rep2["pass"] is True and rep2["sylDeficits"] == [], json.dumps(rep2))

# ── repeated words stay monotonic ──────────────────────────────────────────────────────
LYRIC3 = "been tough been rough been god".split()
TAKE3 = [W("been", 0.0), W("tough", 0.3), W("been", 0.6), W("rough", 0.9),
         W("been", 1.2), W("good", 1.5)]
a3 = bwg.align_lyric(LYRIC3, TAKE3)
check("repeated 'been's align 1:1 in order; god~good fuzzy-anchors",
      len(a3) == 6 and [t for _, t in a3] == [0, 1, 2, 3, 4, 5], str(a3))

# ── determinism ────────────────────────────────────────────────────────────────────────
det = {hashlib.sha256(json.dumps(bwg.gate_song(LYRIC, TAKE, RENDER_BAD, SPAN),
                                 sort_keys=True).encode()).hexdigest() for _ in range(3)}
check("gate_song deterministic (3x)", len(det) == 1)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
