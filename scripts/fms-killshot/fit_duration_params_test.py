#!/usr/bin/env python3
"""Golden tests for the B1-lite fit_duration_params PURE core (no venvs, no network, no
lab-artifact dependency — synthetic inputs only; the real fit is exercised by running
`fit_duration_params.py` directly against the mechanism-verify artifacts).

Pins: median (odd/even), the content/function word split (FUNCTION_WORDS, case/punct
normalization), each per-param fitter's clamping (both directions) and degenerate-input
fallback (-> default, provenance raw=None), final_lengthen's is_last-flag vs. list-order
fallback, and a full fit_params() integration pin using the REAL V1 gold-line-2 word spans
(hardcoded here as literals — not read from disk) plus synthetic V0 rows. Deterministic
(3x identical digest).

Run:  python3 scripts/fms-killshot/fit_duration_params_test.py     (exit 0 = all pass)
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import fit_duration_params as fdp  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def close(a, b, tol=1e-6):
    return a is not None and b is not None and abs(a - b) <= tol


# ── median ───────────────────────────────────────────────────────────────────────────────
check("median odd", fdp.median([3, 1, 2]) == 2)
check("median even", fdp.median([1, 2, 3, 4]) == 2.5)
check("median empty -> None", fdp.median([]) is None)
check("median single", fdp.median([5]) == 5)

# ── is_function_word ───────────────────────────────────────────────────────────────────
check("'we' is function", fdp.is_function_word("we"))
check("'so' is function", fdp.is_function_word("so"))
check("'the' is function", fdp.is_function_word("the"))
check("'time' is content", not fdp.is_function_word("time"))
check("'shared' is content", not fdp.is_function_word("shared"))
check("case-insensitive 'We'", fdp.is_function_word("We"))
check("punctuation stripped 'so,'", fdp.is_function_word("so,"))
check("punctuation stripped '\"The\"'", fdp.is_function_word('"The"'))
check("empty string is not function", not fdp.is_function_word(""))

# ── fit_consonant_ms ───────────────────────────────────────────────────────────────────
spec_c = fdp.PARAM_SPECS["consonant_ms"]

val, prov = fdp.fit_consonant_ms([], spec_c)
check("consonant_ms empty rows -> default", val == spec_c["default"], str((val, prov)))
check("consonant_ms empty rows -> raw None, not clamped",
      prov["raw"] is None and prov["clamped"] is False, str(prov))

# cluster_len 0 excluded, non-finite excluded, non-numeric excluded
rows_junk = [
    {"cluster_len": 0, "est_cluster_dur": 999.0},
    {"cluster_len": 2, "est_cluster_dur": float("nan")},
    {"cluster_len": 2, "est_cluster_dur": float("inf")},
    {"cluster_len": None, "est_cluster_dur": 40.0},
    {"cluster_len": 1, "est_cluster_dur": None},
]
val, prov = fdp.fit_consonant_ms(rows_junk, spec_c)
check("consonant_ms all-junk rows -> default", val == spec_c["default"], str((val, prov)))

# in-range median: per-consonant = [40, 40, 60] -> median 40 (within [20,90], unclamped)
rows_mid = [
    {"cluster_len": 1, "est_cluster_dur": 40.0},
    {"cluster_len": 2, "est_cluster_dur": 80.0},
    {"cluster_len": 1, "est_cluster_dur": 60.0},
]
val, prov = fdp.fit_consonant_ms(rows_mid, spec_c)
check("consonant_ms in-range median", close(val, 40.0), str((val, prov)))
check("consonant_ms in-range not clamped", prov["clamped"] is False, str(prov))
check("consonant_ms in-range n=3 in source", "n=3" in prov["source"], prov["source"])

# clamp low: all rows give 10ms/consonant -> raw 10 < lo 20 -> clamp to 20
rows_low = [{"cluster_len": 1, "est_cluster_dur": 10.0} for _ in range(4)]
val, prov = fdp.fit_consonant_ms(rows_low, spec_c)
check("consonant_ms clamps low", val == spec_c["lo"], str((val, prov)))
check("consonant_ms clamp-low flagged + raw preserved",
      prov["clamped"] is True and close(prov["raw"], 10.0), str(prov))

# clamp high: all rows give 150ms/consonant -> raw 150 > hi 90 -> clamp to 90
rows_high = [{"cluster_len": 1, "est_cluster_dur": 150.0} for _ in range(4)]
val, prov = fdp.fit_consonant_ms(rows_high, spec_c)
check("consonant_ms clamps high", val == spec_c["hi"], str((val, prov)))
check("consonant_ms clamp-high flagged + raw preserved",
      prov["clamped"] is True and close(prov["raw"], 150.0), str(prov))

# multi-consonant cluster divides correctly
rows_multi = [{"cluster_len": 3, "est_cluster_dur": 90.0}]  # 30ms/consonant
val, prov = fdp.fit_consonant_ms(rows_multi, spec_c)
check("consonant_ms divides by cluster_len", close(val, 30.0), str((val, prov)))

# ── fit_stress_and_function ─────────────────────────────────────────────────────────────
spec_s, spec_f = fdp.PARAM_SPECS["stress_ratio"], fdp.PARAM_SPECS["function_compress"]

sv, sp, fv, fp = fdp.fit_stress_and_function([], spec_s, spec_f)
check("stress/function empty gold -> defaults",
      sv == spec_s["default"] and fv == spec_f["default"], str((sv, fv)))
check("stress/function empty gold -> raw None", sp["raw"] is None and fp["raw"] is None)

# degenerate: all content, no function words
all_content = [{"word": "time", "start": 0.0, "end": 0.4, "syllables": 1},
              {"word": "shared", "start": 0.5, "end": 0.9, "syllables": 1}]
sv, sp, fv, fp = fdp.fit_stress_and_function(all_content, spec_s, spec_f)
check("stress/function degenerate (no function words) -> defaults",
      sv == spec_s["default"] and fv == spec_f["default"], str((sv, fv)))

# clamp-triggering example: content words much longer per-syllable than function words
extreme = [
    {"word": "time", "start": 0.0, "end": 1.0, "syllables": 1},     # content 1.0
    {"word": "shared", "start": 1.0, "end": 2.0, "syllables": 1},   # content 1.0
    {"word": "we", "start": 2.0, "end": 2.1, "syllables": 1},       # function 0.1
    {"word": "so", "start": 2.1, "end": 2.2, "syllables": 1},       # function 0.1
]
sv, sp, fv, fp = fdp.fit_stress_and_function(extreme, spec_s, spec_f)
check("stress_ratio clamps high (raw 10.0 > hi 1.8)",
      sv == spec_s["hi"] and sp["clamped"] and close(sp["raw"], 10.0), str((sv, sp)))
check("function_compress clamps low (raw 0.1 < lo 0.5)",
      fv == spec_f["lo"] and fp["clamped"] and close(fp["raw"], 0.1), str((fv, fp)))

# in-range example (function words modestly shorter, not extreme)
modest = [
    {"word": "time", "start": 0.0, "end": 0.5, "syllables": 1},    # content 0.5
    {"word": "shared", "start": 0.5, "end": 1.0, "syllables": 1},  # content 0.5
    {"word": "we", "start": 1.0, "end": 1.3, "syllables": 1},      # function 0.3
    {"word": "so", "start": 1.3, "end": 1.6, "syllables": 1},      # function 0.3
]
sv, sp, fv, fp = fdp.fit_stress_and_function(modest, spec_s, spec_f)
check("stress_ratio in-range (0.5/0.3=1.667)",
      close(sv, 1.6667, 1e-3) and not sp["clamped"], str((sv, sp)))
check("function_compress in-range (0.3/0.5=0.6)",
      close(fv, 0.6, 1e-6) and not fp["clamped"], str((fv, fp)))

# multi-syllable word divides duration by syllable count
multi_syl = [
    {"word": "wonderful", "start": 0.0, "end": 0.9, "syllables": 3},  # content 0.3/syl
    {"word": "the", "start": 0.9, "end": 1.0, "syllables": 1},        # function 0.1/syl
]
sv, sp, fv, fp = fdp.fit_stress_and_function(multi_syl, spec_s, spec_f)
check("multi-syllable per-syl division (0.3/0.1=3.0 -> clamps to 1.8)",
      sv == spec_s["hi"] and close(sp["raw"], 3.0), str((sv, sp)))

# ── fit_final_lengthen ──────────────────────────────────────────────────────────────────
spec_fl = fdp.PARAM_SPECS["final_lengthen"]

val, prov = fdp.fit_final_lengthen([{"word": "solo", "start": 0.0, "end": 1.0, "syllables": 1}],
                                    spec_fl)
check("final_lengthen <2 words -> default", val == spec_fl["default"], str((val, prov)))

# is_last flag honored even if not the last list item
flagged_mid = [
    {"word": "a", "start": 0.0, "end": 0.5, "syllables": 1, "is_last": False},
    {"word": "b", "start": 0.5, "end": 1.4, "syllables": 1, "is_last": True},   # dur 0.9
    {"word": "c", "start": 1.4, "end": 1.9, "syllables": 1, "is_last": False},  # dur 0.5
]
val, prov = fdp.fit_final_lengthen(flagged_mid, spec_fl)
# others = [0.5 (a), 0.5 (c)] median 0.5; last(b)=0.9 -> raw 1.8 -> clamps to hi 1.6
check("final_lengthen honors is_last flag not list position",
      val == spec_fl["hi"] and close(prov["raw"], 1.8), str((val, prov)))

# no is_last flags -> falls back to list-order last item
no_flag = [
    {"word": "a", "start": 0.0, "end": 0.5, "syllables": 1},
    {"word": "b", "start": 0.5, "end": 1.0, "syllables": 1},
    {"word": "c", "start": 1.0, "end": 1.6, "syllables": 1},  # last item, dur 0.6
]
val, prov = fdp.fit_final_lengthen(no_flag, spec_fl)
# others = [0.5, 0.5] median 0.5; last(c)=0.6 -> raw 1.2 (in range)
check("final_lengthen falls back to list-order last when unflagged",
      close(val, 1.2) and not prov["clamped"], str((val, prov)))

# clamp low: final word SHORTER than the others -> raw < 1.0 -> clamps to lo
short_final = [
    {"word": "a", "start": 0.0, "end": 1.0, "syllables": 1},
    {"word": "b", "start": 1.0, "end": 2.0, "syllables": 1},
    {"word": "c", "start": 2.0, "end": 2.1, "syllables": 1, "is_last": True},  # dur 0.1
]
val, prov = fdp.fit_final_lengthen(short_final, spec_fl)
check("final_lengthen clamps low", val == spec_fl["lo"] and prov["clamped"], str((val, prov)))

# ── fit_floor_ms ────────────────────────────────────────────────────────────────────────
spec_fm = fdp.PARAM_SPECS["floor_ms"]

val, prov = fdp.fit_floor_ms([], spec_fm)
check("floor_ms empty gold -> default", val == spec_fm["default"], str((val, prov)))
check("floor_ms empty gold -> raw None", prov["raw"] is None and prov["clamped"] is False)

in_range_words = [{"word": "a", "start": 0.0, "end": 0.10, "syllables": 1},
                  {"word": "b", "start": 0.10, "end": 0.22, "syllables": 1}]
val, prov = fdp.fit_floor_ms(in_range_words, spec_fm)
check("floor_ms in-range (min 100ms)", close(val, 100.0) and not prov["clamped"],
      str((val, prov)))

low_words = [{"word": "a", "start": 0.0, "end": 0.03, "syllables": 1}]  # 30ms
val, prov = fdp.fit_floor_ms(low_words, spec_fm)
check("floor_ms clamps low (30ms < 80ms)",
      val == spec_fm["lo"] and prov["clamped"] and close(prov["raw"], 30.0), str((val, prov)))

high_words = [{"word": "a", "start": 0.0, "end": 0.5, "syllables": 1}]  # 500ms
val, prov = fdp.fit_floor_ms(high_words, spec_fm)
check("floor_ms clamps high (500ms > 140ms)",
      val == spec_fm["hi"] and prov["clamped"] and close(prov["raw"], 500.0), str((val, prov)))

# ── fit_params integration: real V1 gold-line-2 word spans (hardcoded, no I/O) ──────────
# "time we shared nights so close" — forced-aligned spans from the actual V2 alignment
# cache (mechanism/v2-line2/cache/...), reproduced here as literals so this test has zero
# lab-artifact dependency. All 6 words are 1 syllable.
GOLD_LINE2 = [
    {"word": "time", "start": 1.423881301089918, "end": 1.8450292915531334,
     "syllables": 1, "is_last": False},
    {"word": "we", "start": 1.9252479564032696, "end": 2.045575953678474,
     "syllables": 1, "is_last": False},
    {"word": "shared", "start": 2.266177282016349, "end": 2.6071066076294276,
     "syllables": 1, "is_last": False},
    {"word": "nights", "start": 2.707379938692098, "end": 3.1886919277929153,
     "syllables": 1, "is_last": False},
    {"word": "so", "start": 3.2288012602179834, "end": 3.3090199250681196,
     "syllables": 1, "is_last": False},
    {"word": "close", "start": 3.6098399182561307, "end": 4.552409230245232,
     "syllables": 1, "is_last": True},
]
# Synthetic V0 rows engineered to produce an in-range median (n=71-like small stand-in).
V0_SYNTH = [{"cluster_len": 1, "est_cluster_dur": 47.4}] * 5

params = fdp.fit_params(V0_SYNTH, GOLD_LINE2)
check("fit_params version", params["version"] == 1)
check("fit_params consonant_ms in-range unclamped",
      close(params["consonant_ms"], 47.4) and not params["provenance"]["consonant_ms"]["clamped"],
      str(params["consonant_ms"]))
check("fit_params stress_ratio clamps to hi 1.8 (raw ~4.5)",
      params["stress_ratio"] == 1.8 and params["provenance"]["stress_ratio"]["clamped"],
      str(params["provenance"]["stress_ratio"]))
check("fit_params function_compress clamps to lo 0.5 (raw ~0.222)",
      params["function_compress"] == 0.5 and params["provenance"]["function_compress"]["clamped"],
      str(params["provenance"]["function_compress"]))
check("fit_params final_lengthen clamps to hi 1.6 (raw ~2.765, 'close' is is_last)",
      params["final_lengthen"] == 1.6 and params["provenance"]["final_lengthen"]["clamped"],
      str(params["provenance"]["final_lengthen"]))
check("fit_params floor_ms unclamped (~80.22ms, the word 'so')",
      close(params["floor_ms"], 80.22, 0.02) and not params["provenance"]["floor_ms"]["clamped"],
      str(params["floor_ms"]))
check("fit_params floor_per_consonant_ms is the fixed default",
      params["floor_per_consonant_ms"] == fdp.PARAM_SPECS["floor_per_consonant_ms"]["default"]
      and params["provenance"]["floor_per_consonant_ms"]["raw"] is None,
      str(params["provenance"]["floor_per_consonant_ms"]))
check("fit_params rest_steal_max_ms fixed", params["rest_steal_max_ms"] == 120.0)
check("fit_params strength fixed", params["strength"] == 1.0)
check("fit_params provenance has all 6 keys",
      set(params["provenance"].keys()) == {
          "consonant_ms", "stress_ratio", "function_compress", "final_lengthen",
          "floor_ms", "floor_per_consonant_ms"},
      str(sorted(params["provenance"].keys())))

# fully-degenerate call (no v0 rows, no gold words) -> every param is its bare default
empty_params = fdp.fit_params([], [])
check("fit_params fully degenerate -> all defaults", empty_params == {
    "version": 1,
    "consonant_ms": 50.0,
    "stress_ratio": 1.3,
    "function_compress": 0.75,
    "final_lengthen": 1.2,
    "floor_ms": 100.0,
    "floor_per_consonant_ms": 25.0,
    "rest_steal_max_ms": 120.0,
    "strength": 1.0,
    "provenance": empty_params["provenance"],  # checked structurally above
}, json.dumps(empty_params, indent=1))
check("fit_params fully degenerate -> every provenance raw is None",
      all(p["raw"] is None for p in empty_params["provenance"].values()),
      str(empty_params["provenance"]))

# ── determinism (3x) ────────────────────────────────────────────────────────────────────
def digest():
    payload = fdp.fit_params(V0_SYNTH, GOLD_LINE2)
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


d = {digest() for _ in range(3)}
check("3x deterministic", len(d) == 1, str(d))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print("\nOK: 0 failure(s)")
