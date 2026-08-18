#!/usr/bin/env python3
"""STAGE-B KILL-SHOT (LLM-free): can the weighted phoneme distance find the TRUE lyric?

For each template line of a KNOWN-LYRIC take, build a candidate pool:
  - the TRUE lyric line for that span (assignment below)
  - every OTHER lyric line (hard distractors — same author, same style)
  - GENERIC_N deterministic filler lines at the template's syllable count
    (lyrics.core's fake-backend vocab — the "any-LLM-would-say-this" floor)
  - RANDOM_N seeded random-cmudict-word lines at the same count (the noise floor)
and rank all by distance.score_line. The metric under test wins a line when the true
line ranks top-2.

Truth assignment is NON-CIRCULAR: template line ↔ lyric line is matched by WORD-string
overlap between the take's cached Whisper words in that time span and the lyric sheet
(never by the phoneme metric being tested). Lines whose Whisper text matches no lyric
line at ≥ MATCH_MIN overlap are EXCLUDED and counted (echo/mumble lines — honest
exclusion, not guessing).

Bracket discipline: the report prints the oracle (truth) and the random floor per
line; a run where the floor ties the ceiling flags itself broken.

Verdict (printed at the end, thresholds pre-registered in the plan):
  PASS     top-2 rate >= 0.7 AND median margin > 0.5 AND (with --sabotage) <= 0.35
  KILL     top-2 rate <= 0.4 or median margin ~ 0
  VACUOUS  sabotage top-2 rate > 0.5  (metric is length/lexicon-driven, not phonetic)

Usage:
  validate_metric.py <template-dir> --lyrics goingdown-lyrics.txt \
      --words <take>-words.json [--sabotage shuffle-phones] [--vowel-mult 2.0]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))

import panphon  # noqa: E402

import distance as D  # noqa: E402
import ipa_norm  # noqa: E402
from phonology import core as phon  # noqa: E402

GENERIC_N = 5
RANDOM_N = 5
MATCH_MIN = 0.5
SEED = 20260811

_WORD_RE = re.compile(r"[A-Za-z']+")


def _tokens(text: str) -> list:
    return [w.lower() for w in _WORD_RE.findall(text or "")]


def load_lyric_lines(path: str) -> list:
    """Lyric sheet → unique singable lines (comments dropped; parenthesised echo lines
    kept as candidates — they are real lyric text; duplicates deduped)."""
    out, seen = [], set()
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            line = line.strip("()")
            key = " ".join(_tokens(line))
            if key and key not in seen:
                seen.add(key)
                out.append(line)
    return out


def overlap(a: list, b: list) -> float:
    """Token F1 — the truth-assignment score (string world, independent of phonemes)."""
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    inter = len(sa & sb)
    if inter == 0:
        return 0.0
    p, r = inter / len(sa), inter / len(sb)
    return 2 * p * r / (p + r)


def lyric_windows(lyric_lines: list, max_len: int = 3) -> list:
    """All 1..max_len-line windows of consecutive lyric lines, deduped by token key.

    A take 'line' is whatever pause structure the singer produced — often TWO sheet
    lines back-to-back (proven on goingdown: whisper-gap spans carried 16-18 syllables
    against 8-9-syllable sheet lines, exploding every length term). Truth AND lyric
    distractors therefore live in window space, so lengths stay comparable."""
    out, seen = [], set()
    for w_len in range(1, max_len + 1):
        for j in range(0, len(lyric_lines) - w_len + 1):
            text = " ".join(lyric_lines[j:j + w_len])
            key = " ".join(_tokens(text))
            if key and key not in seen:
                seen.add(key)
                out.append(text)
    return out


def assign_truth(template: dict, words: list, windows: list) -> list:
    """Per template line: (line, truth_window_index|None, match_score). Assignment is
    WORD overlap between the span's Whisper words and each window — never phonemes."""
    win_toks = [_tokens(t) for t in windows]
    out = []
    for line in template["lines"]:
        s, e = line["span"]
        in_span = [w["word"] for w in words
                   if s - 1e-9 <= (float(w["start"]) + float(w["end"])) / 2 < e + 1e-9]
        toks = _tokens(" ".join(in_span))
        scores = [overlap(toks, wt) for wt in win_toks]
        best = max(range(len(scores)), key=lambda i: scores[i]) if scores else None
        if best is None or scores[best] < MATCH_MIN:
            out.append((line, None, scores[best] if scores else 0.0))
        else:
            out.append((line, best, scores[best]))
    return out


def generic_lines(syllables: int, seed: str, pron) -> list:
    """Deterministic filler lines from lyrics.core's fake-backend vocab — what a
    constraint-aware template filler (or a lazy LLM) writes at this count."""
    from lyrics import core as lcore
    outs = []
    for k in range(GENERIC_N):
        end = lcore._pick(lcore._DEFAULT_ENDS, f"{seed}|end|{k}") or "flow"
        need = max(syllables - pron.syllables(end), 0)
        words = lcore._filler_for(need, f"{seed}|{k}") + [end]
        outs.append(" ".join(words))
    return outs


def random_lines(syllables: int, rng: random.Random, lexicon_words: list, pron) -> list:
    outs = []
    for _ in range(RANDOM_N):
        words, count, guard = [], 0, 0
        while count < syllables and guard < 50:
            w = rng.choice(lexicon_words)
            s = pron.syllables(w)
            guard += 1
            if s and count + s <= syllables:
                words.append(w)
                count += s
        outs.append(" ".join(words) if words else "la")
    return outs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("template_dir")
    ap.add_argument("--lyrics")
    ap.add_argument("--words", required=True)
    ap.add_argument("--truth-from-whisper", action="store_true",
                    help="no lyric sheet: each span's Whisper text is its near-truth "
                         "(independent recognizer — non-circular); other spans' texts "
                         "plus --lyrics windows (if given) serve as distractors")
    ap.add_argument("--sabotage", choices=["shuffle-phones"], default=None)
    ap.add_argument("--vowel-mult", type=float, default=None)
    ap.add_argument("--json-out", default=None)
    ns = ap.parse_args()

    with open(os.path.join(ns.template_dir, "template.json"), encoding="utf-8") as f:
        template = json.load(f)
    with open(ns.words, encoding="utf-8") as f:
        words = json.load(f)
    lyric_lines = load_lyric_lines(ns.lyrics) if ns.lyrics else []
    if ns.truth_from_whisper:
        # Each template span's Whisper text becomes a candidate "lyric line". Whisper
        # is an independent recognizer, so ranking its text by CTC-phoneme distance is
        # non-circular; the other spans' texts are same-singer hard distractors.
        for line in template["lines"]:
            s, e = line["span"]
            txt = " ".join(w["word"] for w in words
                           if s - 1e-9 <= (float(w["start"]) + float(w["end"])) / 2 < e + 1e-9)
            if len(_tokens(txt)) >= 2:
                lyric_lines.append(txt)
    if not lyric_lines:
        print("need --lyrics and/or --truth-from-whisper", file=sys.stderr)
        return 2

    ft = panphon.FeatureTable()
    fs = D.FeatureSpace(ft)
    pron = phon.Pronouncer()
    w = dict(D.WEIGHTS)
    if ns.vowel_mult is not None:
        w["vowel_mult"] = ns.vowel_mult

    # Truth + lyric distractors live in 1..3-line WINDOW space (see lyric_windows).
    windows = lyric_windows(lyric_lines)
    lyric_ipa = [ipa_norm.arpa_line_to_ipa(_tokens(t), pron) for t in windows]

    # ── Preflight: one shared inventory or abort ────────────────────────────────────
    all_segs = [s for line in template["lines"] for s in line["segs"]]
    all_segs += [s for li in lyric_ipa if li for s in li["segs"]]
    rep = ipa_norm.inventory_report(all_segs, ft)
    if rep["unknown"]:
        print(f"PREFLIGHT FAIL: unknown segments {rep['unknown']} "
              f"(coverage {rep['coverage']:.4f}) — extend ipa_norm tables first",
              file=sys.stderr)
        return 2

    rng = random.Random(SEED)
    sab_rng = random.Random(SEED + 1)
    lexicon_words = sorted(wd for wd in pron._lexicon if wd.isalpha() and len(wd) > 2)

    assigned = assign_truth(template, words, windows)
    rows, excluded, debris = [], 0, 0
    for line, truth_idx, match in assigned:
        if line["syllables"] < 3:
            debris += 1        # segmentation scraps (a stray phone caught in a span)
            continue
        if truth_idx is None or lyric_ipa[truth_idx] is None:
            excluded += 1
            continue
        tpl = dict(line)
        if ns.sabotage == "shuffle-phones":
            segs = list(tpl["segs"])
            sab_rng.shuffle(segs)
            tpl["segs"] = segs
            tpl["vowels"] = [s for s in segs if ipa_norm.is_vowel_seg(s)][:len(tpl["vowels"])]

        pool = []   # (kind, text, ipa)
        for j, (lt, li) in enumerate(zip(windows, lyric_ipa)):
            if li is None:
                continue
            pool.append(("truth" if j == truth_idx else "lyric", lt, li))
        for g in generic_lines(tpl["syllables"], f"{template['take']}|{line['index']}", pron):
            gi = ipa_norm.arpa_line_to_ipa(_tokens(g), pron)
            if gi:
                pool.append(("generic", g, gi))
        for r in random_lines(tpl["syllables"], rng, lexicon_words, pron):
            ri = ipa_norm.arpa_line_to_ipa(_tokens(r), pron)
            if ri:
                pool.append(("random", r, ri))

        # Truth FAMILY: sibling windows sharing >=0.6 token-F1 with the assigned truth
        # are the same lyric material at a shifted window offset — near-duplicates MY
        # window construction created, not real distractors. The family collapses to
        # its best-scoring member (which may render the sung variant better than the
        # word-overlap assignment did, e.g. "getta" vs "get" on goingdown line 1).
        truth_toks = _tokens(windows[truth_idx])
        def _is_family(kind: str, text: str) -> bool:
            return kind == "truth" or (kind == "lyric"
                                       and overlap(_tokens(text), truth_toks) >= 0.6)
        scored_all = sorted(
            ((kind, text, D.score_line(tpl, ipa, fs, w)["total"]) for kind, text, ipa in pool),
            key=lambda x: (x[2], x[1]))
        best_family = next(t for kind, text, t in scored_all if _is_family(kind, text))
        scored = [("truth", "<family>", best_family)] + \
                 [(k, x, t) for k, x, t in scored_all if not _is_family(k, x)]
        scored.sort(key=lambda x: (x[2], x[1]))
        totals = [t for _, _, t in scored]
        rank = next(i for i, (kind, _, _) in enumerate(scored) if kind == "truth") + 1
        truth_total = best_family
        best_distractor = min(t for kind, _, t in scored if kind != "truth")
        spread = statistics.pstdev(totals) or 1e-9
        margin = (best_distractor - truth_total) / spread
        floor_mean = statistics.mean(t for kind, _, t in scored if kind == "random")
        rows.append({"line": line["index"], "syl": tpl["syllables"], "match": round(match, 2),
                     "rank": rank, "pool": len(scored), "margin": round(margin, 3),
                     "truth": round(truth_total, 4), "best_other": round(best_distractor, 4),
                     "random_floor": round(floor_mean, 4)})

    if not rows:
        print("no scorable lines (all excluded) — nothing to validate", file=sys.stderr)
        return 2

    top1 = sum(1 for r in rows if r["rank"] == 1) / len(rows)
    top2 = sum(1 for r in rows if r["rank"] <= 2) / len(rows)
    mrr = statistics.mean(1.0 / r["rank"] for r in rows)
    med_margin = statistics.median(r["margin"] for r in rows)
    broken_bracket = statistics.mean(r["random_floor"] for r in rows) <= \
        statistics.mean(r["truth"] for r in rows)

    hdr = f"{'line':>4} {'syl':>4} {'match':>5} {'rank':>4}/{'pool':<4} {'margin':>7} {'truth':>7} {'best_other':>10} {'rand_floor':>10}"
    print(("SABOTAGED " if ns.sabotage else "") + f"take={template['take']} "
          f"vowel_mult={w['vowel_mult']} lines={len(rows)} excluded={excluded} debris={debris}")
    print(hdr)
    for r in rows:
        print(f"{r['line']:>4} {r['syl']:>4} {r['match']:>5} {r['rank']:>4}/{r['pool']:<4} "
              f"{r['margin']:>7} {r['truth']:>7} {r['best_other']:>10} {r['random_floor']:>10}")
    print(f"\ntop-1 {top1:.2f}   top-2 {top2:.2f}   MRR {mrr:.2f}   median margin {med_margin:.2f}")
    if not ns.sabotage and broken_bracket:
        print("BRACKET BROKEN: random floor <= truth mean — the run cannot be trusted")

    verdict = None
    if ns.sabotage:
        verdict = "SABOTAGE-OK (ranking collapsed)" if top2 <= 0.35 else \
                  "VACUOUS (metric survives phoneme shuffle — it is not measuring phonetics)"
    else:
        if top2 >= 0.7 and med_margin > 0.5:
            verdict = "PASS"
        elif top2 <= 0.4 or med_margin < 0.05:
            verdict = "KILL (metric cannot find the true lyric)"
        else:
            verdict = "INCONCLUSIVE (between brackets — inspect per-line rows)"
    print(f"VERDICT: {verdict}")

    if ns.json_out:
        with open(ns.json_out, "w", encoding="utf-8") as f:
            json.dump({"take": template["take"], "sabotage": ns.sabotage,
                       "vowel_mult": w["vowel_mult"], "rows": rows,
                       "top1": top1, "top2": top2, "mrr": mrr,
                       "median_margin": med_margin, "excluded": excluded, "debris": debris,
                       "verdict": verdict}, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
