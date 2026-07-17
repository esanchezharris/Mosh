#!/usr/bin/env python3
"""B1-lite: fit service/soulx/duration_params.json's coefficients from measured evidence
(mechanism-verify Phase V / B1-lite stage-3 duration derivation).

Two measurement sources, both already on disk from earlier mechanism-verify runs:

  A. V0 vowel-landmark rows (vowel_landmark.py, mechanism/v0/*-words.json) — the RAW
     (pre-timing-snap) '*-chunks' lane, 'clean' subset (all-voiceless onset cluster,
     cluster_len >= 1 — a voicing onset IS the vowel onset there, so the render's own
     vowel-onset landmark minus the aligned word start is a clean estimate of how long
     the render spends on the onset consonants) gives consonant_ms: the render's own
     ms-per-onset-consonant. Snapped lanes are deliberately EXCLUDED: the mechanism-verify
     Phase-V V3 ablation found per-word `snap_to_events` damages naturalness and it is
     being removed from the product chain (see CLAUDE.md working notes) — fitting against
     its output would calibrate a coefficient against a stage that is going away.

  B. The V1 gold recording (mechanism/v1/gold-line2.wav, the owner singing "time we
     shared nights so close" naturally over the beat), forced-aligned via
     oracle_duration.gold_word_slots — gives real per-word sung durations, from which we
     derive stress_ratio / function_compress (content vs. function word weight),
     final_lengthen (phrase-final word), and floor_ms (the shortest thing the owner
     actually sang).

This module's top half (down to fit_params) is PURE: stdlib-only, no I/O, no venvs, no
network, golden-tested against synthetic inputs in fit_duration_params_test.py. The
bottom half (`main`) does the real I/O — reads the V0 artifact JSONs, reuses the V2 gold
alignment cache (so the skeleton-venv forced-alignment probe never needs to run again),
and writes the fitted params to BOTH:
  ~/mosh-fms-ksb/used2/asserted-proof/mechanism/b1/params.json   (lab copy, full provenance)
  service/soulx/duration_params.json                             (shipped default)

The params schema is FROZEN (service/soulx/duration.py is being built against it
concurrently by another agent) — do not change field names or the provenance shape here.

Usage:
  python3 fit_duration_params.py   # runs the real fit, writes both JSONs
"""
from __future__ import annotations

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

# ── frozen schema: clamp ranges + fallback defaults ─────────────────────────────────────

PARAM_SPECS = {
    "consonant_ms":           {"lo": 20.0, "hi": 90.0,  "default": 50.0},
    "stress_ratio":           {"lo": 1.0,  "hi": 1.8,   "default": 1.3},
    "function_compress":      {"lo": 0.5,  "hi": 1.0,   "default": 0.75},
    "final_lengthen":         {"lo": 1.0,  "hi": 1.6,   "default": 1.2},
    "floor_ms":               {"lo": 80.0, "hi": 140.0, "default": 100.0},
    "floor_per_consonant_ms": {"lo": 0.0,  "hi": 50.0,  "default": 25.0},
}
REST_STEAL_MAX_MS = 120.0  # not fitted, fixed
STRENGTH = 1.0             # not fitted, fixed

# Frozen closed-class set for the content/function split (stress_ratio, function_compress).
FUNCTION_WORDS = {
    "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "to", "of", "in", "on", "at",
    "by", "for", "with", "from", "as", "if", "than", "then", "that", "this", "these",
    "those", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "am", "is", "are", "was", "were", "be",
    "been", "being", "do", "does", "did", "have", "has", "had", "will", "would", "can",
    "could", "shall", "should", "may", "might", "must", "not", "no", "oh", "uh", "la",
}

_STRIP = ".,!?;:\"'"


# ── pure math ────────────────────────────────────────────────────────────────────────────

def median(xs):
    """Median of a list of numbers; None on empty input."""
    xs = sorted(xs)
    n = len(xs)
    if n == 0:
        return None
    mid = n // 2
    if n % 2:
        return xs[mid]
    return (xs[mid - 1] + xs[mid]) / 2.0


def _clamp(raw, lo, hi):
    return max(lo, min(hi, raw))


def _prov(source, raw, clamped):
    return {"source": source, "raw": raw, "clamped": clamped}


def _norm_word(word):
    return (word or "").strip().lower().strip(_STRIP)


def is_function_word(word):
    return _norm_word(word) in FUNCTION_WORDS


def _per_syllable(word_row):
    """A gold word row's duration divided by its syllable count (floor 1 syllable)."""
    try:
        syl = int(word_row.get("syllables", 1))
    except (TypeError, ValueError):
        syl = 1
    syl = max(1, syl)
    return (word_row["end"] - word_row["start"]) / syl


def _content_function_split(gold_words):
    content, function = [], []
    for w in gold_words or []:
        d = _per_syllable(w)
        (function if is_function_word(w.get("word", "")) else content).append(d)
    return content, function


def fit_consonant_ms(v0_rows, spec=None):
    """median(est_cluster_dur / cluster_len) over usable v0 rows -> (value, provenance).
    v0_rows = [{"cluster_len": int, "est_cluster_dur": float (ms)}, ...]."""
    spec = spec or PARAM_SPECS["consonant_ms"]
    vals = []
    for r in v0_rows or []:
        cl = r.get("cluster_len")
        d = r.get("est_cluster_dur")
        if not isinstance(cl, (int, float)) or isinstance(cl, bool) or cl < 1:
            continue
        if not isinstance(d, (int, float)) or isinstance(d, bool) or not math.isfinite(d):
            continue
        vals.append(d / cl)
    if not vals:
        return spec["default"], _prov(
            "default (no usable v0 rows: need cluster_len>=1 and a finite est_cluster_dur)",
            None, False)
    raw = median(vals)
    val = _clamp(raw, spec["lo"], spec["hi"])
    return val, _prov(f"median(est_cluster_dur_ms/cluster_len) over n={len(vals)} v0 rows "
                       "(V0 raw '*-chunks' lane, clean subset)", round(raw, 3), val != raw)


def fit_stress_and_function(gold_words, stress_spec=None, compress_spec=None):
    """(stress_ratio, prov, function_compress, prov) from the content/function per-syllable
    duration split of the gold line."""
    stress_spec = stress_spec or PARAM_SPECS["stress_ratio"]
    compress_spec = compress_spec or PARAM_SPECS["function_compress"]
    content, function = _content_function_split(gold_words)
    if not content or not function:
        detail = (f"default (degenerate content/function split: "
                  f"content={len(content)} function={len(function)})")
        return (stress_spec["default"], _prov(detail, None, False),
                compress_spec["default"], _prov(detail, None, False))
    mc, mf = median(content), median(function)
    if mc is None or mf is None or mc <= 0 or mf <= 0:
        detail = "default (degenerate zero-or-negative-duration median)"
        return (stress_spec["default"], _prov(detail, None, False),
                compress_spec["default"], _prov(detail, None, False))
    raw_stress = mc / mf
    raw_compress = mf / mc
    n_note = f"gold line, n_content={len(content)} n_function={len(function)}"
    stress_val = _clamp(raw_stress, stress_spec["lo"], stress_spec["hi"])
    compress_val = _clamp(raw_compress, compress_spec["lo"], compress_spec["hi"])
    return (stress_val,
            _prov(f"median(content per-syl dur)/median(function per-syl dur), {n_note}",
                  round(raw_stress, 4), stress_val != raw_stress),
            compress_val,
            _prov(f"median(function per-syl dur)/median(content per-syl dur), {n_note}",
                  round(raw_compress, 4), compress_val != raw_compress))


def fit_final_lengthen(gold_words, spec=None):
    """(final_lengthen, provenance) — the phrase-final word's per-syllable duration over
    the median of the other words'. The final word is the one flagged is_last=True (the
    LAST such flag if several are set); if none are flagged, the last list item is used."""
    spec = spec or PARAM_SPECS["final_lengthen"]
    words = list(gold_words or [])
    if len(words) < 2:
        return spec["default"], _prov("default (need >=2 gold words)", None, False)
    flagged = [i for i, w in enumerate(words) if w.get("is_last")]
    last_idx = flagged[-1] if flagged else len(words) - 1
    last_dur = _per_syllable(words[last_idx])
    others = [_per_syllable(w) for i, w in enumerate(words) if i != last_idx]
    if not others:
        return spec["default"], _prov("default (no non-final words)", None, False)
    mo = median(others)
    if mo is None or mo <= 0:
        return spec["default"], _prov("default (degenerate zero-or-negative-duration median)",
                                       None, False)
    raw = last_dur / mo
    val = _clamp(raw, spec["lo"], spec["hi"])
    return val, _prov("final-word per-syl dur / median(other words' per-syl dur), gold line "
                       f"(n_others={len(others)})", round(raw, 4), val != raw)


def fit_floor_ms(gold_words, spec=None):
    """(floor_ms, provenance) — the shortest thing the owner actually sang, clamped."""
    spec = spec or PARAM_SPECS["floor_ms"]
    words = list(gold_words or [])
    durs_ms = [(w["end"] - w["start"]) * 1000.0 for w in words if w["end"] > w["start"]]
    if not durs_ms:
        return spec["default"], _prov("default (no gold words with positive duration)",
                                       None, False)
    raw = min(durs_ms)
    val = _clamp(raw, spec["lo"], spec["hi"])
    return val, _prov(f"min(gold word slot duration ms) over n={len(durs_ms)} words",
                       round(raw, 2), val != raw)


def fit_params(v0_rows, gold_words, defaults=None):
    """The frozen entry point.
    v0_rows = [{"cluster_len": int, "est_cluster_dur": float (ms)}, ...]
    gold_words = [{"word": str, "start": float, "end": float, "syllables": int,
                   "is_last": bool}, ...]
    -> the full params dict per the frozen schema (see module docstring)."""
    specs = defaults or PARAM_SPECS
    consonant_ms, prov_consonant = fit_consonant_ms(v0_rows, specs["consonant_ms"])
    stress_ratio, prov_stress, function_compress, prov_function = fit_stress_and_function(
        gold_words, specs["stress_ratio"], specs["function_compress"])
    final_lengthen, prov_final = fit_final_lengthen(gold_words, specs["final_lengthen"])
    floor_ms, prov_floor = fit_floor_ms(gold_words, specs["floor_ms"])
    floor_per_consonant_ms = specs["floor_per_consonant_ms"]["default"]
    prov_floor_pc = _prov("default (no measurement defined for this coefficient)", None, False)

    return {
        "version": 1,
        "consonant_ms": round(consonant_ms, 2),
        "stress_ratio": round(stress_ratio, 4),
        "function_compress": round(function_compress, 4),
        "final_lengthen": round(final_lengthen, 4),
        "floor_ms": round(floor_ms, 2),
        "floor_per_consonant_ms": round(floor_per_consonant_ms, 2),
        "rest_steal_max_ms": REST_STEAL_MAX_MS,
        "strength": STRENGTH,
        "provenance": {
            "consonant_ms": prov_consonant,
            "stress_ratio": prov_stress,
            "function_compress": prov_function,
            "final_lengthen": prov_final,
            "floor_ms": prov_floor,
            "floor_per_consonant_ms": prov_floor_pc,
        },
    }


# ── I/O: the real fit ────────────────────────────────────────────────────────────────────

V0_DIR = os.path.expanduser("~/mosh-fms-ksb/used2/asserted-proof/mechanism/v0")
V2_LINE2_DIR = os.path.expanduser("~/mosh-fms-ksb/used2/asserted-proof/mechanism/v2-line2")
GOLD_WAV = os.path.join(V2_LINE2_DIR, "gold-norm.wav")
GOLD_CACHE = os.path.join(V2_LINE2_DIR, "cache")
LINE_WORDS = ["time", "we", "shared", "nights", "so", "close"]
MIN_CTC = 0.15  # the V2-verified override (the soft-attack "time" scores 0.169)

B1_LAB_DIR = os.path.expanduser("~/mosh-fms-ksb/used2/asserted-proof/mechanism/b1")
LAB_PARAMS_PATH = os.path.join(B1_LAB_DIR, "params.json")
SHIPPED_PARAMS_PATH = os.path.join(REPO, "service", "soulx", "duration_params.json")


def load_v0_rows():
    """RAW (pre-timing-snap) '*-chunks' lane rows, 'clean' subset only — see module
    docstring for why. Returns [] (loudly) if the artifacts are missing."""
    rows = []
    for fname in ("t1-chunks-words.json", "u2-chunks-words.json"):
        path = os.path.join(V0_DIR, fname)
        if not os.path.isfile(path):
            print(f"WARNING: missing V0 artifact {path} — consonant_ms will use fewer/no "
                  "measurements.", file=sys.stderr)
            continue
        with open(path) as f:
            data = json.load(f)
        n_before = len(rows)
        for r in data:
            if r.get("clean") and r.get("cluster_len", 0) >= 1 and "est_cluster_dur_ms" in r:
                rows.append({"cluster_len": r["cluster_len"],
                            "est_cluster_dur": r["est_cluster_dur_ms"]})
        print(f"  {fname}: {len(data)} rows -> {len(rows) - n_before} clean/usable",
              file=sys.stderr)
    return rows


def load_gold_words():
    """Forced-align the V1 gold line-2 recording, reusing the V2 alignment cache (same
    wav file left in place at its V2 path so the cache key — basename+size+mtime — hits
    without re-running the skeleton-venv probe). Returns [] (loudly) on any failure —
    the driver falls back to defaults for the gold-derived params rather than blocking."""
    if not os.path.isfile(GOLD_WAV):
        print(f"WARNING: gold wav not found at {GOLD_WAV} — gold-derived params "
              "(stress_ratio, function_compress, final_lengthen, floor_ms) will default.",
              file=sys.stderr)
        return []
    try:
        import oracle_duration as od
        from phonology.core import Pronouncer
    except Exception as e:  # noqa: BLE001 - loud fallback, never block the fit
        print(f"WARNING: could not import gold-alignment dependencies ({e}) — "
              "gold-derived params will default.", file=sys.stderr)
        return []
    os.makedirs(GOLD_CACHE, exist_ok=True)
    pr = Pronouncer()
    syls = [max(1, pr.syllables(w)) for w in LINE_WORDS]
    try:
        slots = od.gold_word_slots(GOLD_CACHE, GOLD_WAV, LINE_WORDS, syls, marks=None,
                                    min_ctc=MIN_CTC)
    except Exception as e:  # noqa: BLE001 - loud fallback, never block the fit
        print(f"WARNING: gold alignment failed ({e}) — gold-derived params will default.",
              file=sys.stderr)
        return []
    words = []
    for i, s in enumerate(slots):
        # every word in this line is 1 syllable -> exactly 1 slot == the whole word span
        words.append({"word": s["word"], "start": s["start"], "end": s["end"],
                      "syllables": syls[i], "is_last": i == len(slots) - 1})
    return words


def main() -> int:
    print("== loading V0 vowel-landmark rows (consonant_ms) ==", file=sys.stderr)
    v0_rows = load_v0_rows()
    print(f"  total usable v0 rows: {len(v0_rows)}", file=sys.stderr)

    print("== loading V1 gold line-2 alignment (stress/function/final/floor) ==",
          file=sys.stderr)
    gold_words = load_gold_words()
    print(f"  gold words: {[w['word'] for w in gold_words]}", file=sys.stderr)

    params = fit_params(v0_rows, gold_words)

    os.makedirs(B1_LAB_DIR, exist_ok=True)
    with open(LAB_PARAMS_PATH, "w") as f:
        json.dump(params, f, indent=2)
        f.write("\n")

    os.makedirs(os.path.dirname(SHIPPED_PARAMS_PATH), exist_ok=True)
    with open(SHIPPED_PARAMS_PATH, "w") as f:
        json.dump(params, f, indent=2)
        f.write("\n")

    print(json.dumps({
        "ok": True,
        "n_v0_rows": len(v0_rows),
        "n_gold_words": len(gold_words),
        "lab_path": LAB_PARAMS_PATH,
        "shipped_path": SHIPPED_PARAMS_PATH,
        "params": params,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
