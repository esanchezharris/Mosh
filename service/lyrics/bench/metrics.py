"""Deterministic bench metrics (FMS lyrics-bench I1). Pure stdlib + phonology.

Per-item scoring of a ranked candidate list against the held-out truth:
  exact / topk        — normalized string match (word/rhyme/span only)
  syl_fit             — top-1 candidate syllables within the item's target ± tol
                        (heuristic syllable counts are acceptable: they are counts,
                        not pronunciations, and stay deterministic for OOV slang)
  rhyme_fit           — top-1 end word vs constraints.rhymeWith at the item's
                        strictness; requires REAL phones on BOTH sides, else None
                        (excluded honestly, never guessed via spelling)
  rhyme_perfect       — the perfect-grade rate, reported next to rhyme_fit
  stress_fit          — contour equality when both sides have phones (never gating)
  multi_depth         — multisyllabic depth vs the rhyme partner (skilled-bars axis)
  constrained_fit     — AND of the applicable non-None fits (the deterministic
                        headline until calibration elects a judged metric)

aggregate() means each metric per granularity, skipping Nones, with honest
n_<metric> coverage counts.
"""
from __future__ import annotations

import re
from typing import List, Optional

from phonology.core import multisyllabic_depth, rhyme_grade

from lyrics.bench.mask import tokenize

# Punctuation-tolerant: "____", "____ ____", and "____, ____" are ONE region.
_BLANK_RUN = re.compile(r"_{2,}(?:[^\w]+_{2,})*")
_NORM_DROP = re.compile(r"[^a-z0-9 ]+")
TOPK = 5


def normalize(text: str) -> str:
    return " ".join(_NORM_DROP.sub("", (text or "").lower().replace("'", "")).split())


def apply_fill(item: dict, fill: str) -> str:
    """The candidate-completed line: blanks replaced (as one contiguous run —
    spans are contiguous by construction), or the fill itself for line items."""
    if item["granularity"] == "line":
        return fill
    return _BLANK_RUN.sub(fill, item["context"]["maskedLine"], count=1)


def _grade_passes(grade: str, strictness: str) -> bool:
    if strictness == "perfect":
        return grade == "perfect"
    return grade in ("perfect", "slant")


def _syllables_of(pron, text: str) -> int:
    return sum(pron.syllables(t) for t in tokenize(text))


def _syl_fit(item: dict, fill: str, pron) -> Optional[int]:
    con = item["constraints"]
    if item["granularity"] == "line":
        target, tol = con["lineSyllableTarget"], con["syllableTol"]
    else:
        target, tol = con["syllables"], con["syllableTol"]
    if not target:
        return None
    return 1 if abs(_syllables_of(pron, fill) - target) <= tol else 0


def _rhyme_metrics(item: dict, fill: str, pron) -> dict:
    con = item["constraints"]
    partner = con.get("rhymeWith")
    out = {"rhyme_fit": None, "rhyme_perfect": None, "multi_depth": None}
    if not partner:
        return out
    fill_tokens = tokenize(apply_fill(item, fill)) if item["granularity"] == "line" \
        else tokenize(fill)
    if not fill_tokens:
        return out
    end = fill_tokens[-1]
    ep, pp = pron.phones(end), pron.phones(partner)
    if not ep or not pp:
        return out  # ungradable — excluded, never spelling-guessed
    grade = rhyme_grade(ep, pp)
    out["rhyme_fit"] = 1 if _grade_passes(grade, con.get("rhymeStrictness", "slant")) else 0
    out["rhyme_perfect"] = 1 if grade == "perfect" else 0
    out["multi_depth"] = multisyllabic_depth(ep, pp)
    return out


def _stress_fit(item: dict, fill: str, pron) -> Optional[int]:
    want = item["target"].get("stress") or ""
    if not want or item["granularity"] != "word":
        return None
    toks = tokenize(fill)
    got = pron.stress(toks[0]) if toks else ""
    if not got:
        return None
    return 1 if got == want else 0


def score_item(item: dict, candidates: List[str], pron) -> dict:
    gran = item["granularity"]
    truth = normalize(item["target"]["text"])
    norm_cands = [normalize(c) for c in candidates]
    top1 = candidates[0] if candidates else ""

    exact = topk = None
    if gran != "line":
        exact = 1 if norm_cands and norm_cands[0] == truth else 0
        topk = 1 if truth in norm_cands[:TOPK] else 0

    row = {
        "itemId": item["itemId"], "granularity": gran,
        "split": item.get("split"), "views": item.get("views", 0),
        "exact": exact, "topk": topk,
        "syl_fit": _syl_fit(item, top1, pron) if top1 else None,
        "stress_fit": _stress_fit(item, top1, pron) if top1 else None,
        **(_rhyme_metrics(item, top1, pron) if top1 else
           {"rhyme_fit": None, "rhyme_perfect": None, "multi_depth": None}),
    }
    fits = [row[k] for k in ("syl_fit", "rhyme_fit") if row[k] is not None]
    row["constrained_fit"] = (1 if all(fits) else 0) if fits else None
    return row


_AGG_KEYS = ("exact", "topk", "syl_fit", "rhyme_fit", "rhyme_perfect",
             "multi_depth", "stress_fit", "constrained_fit")


# Genius views. Below this a song is obscure enough that an LLM reproducing its
# exact word is far more likely to be skill than recall — which is why the
# low-fame bucket, not the pooled number, is the headline for any arm claim.
FAME_THRESHOLD = 50_000


def aggregate_by_fame(rows: List[dict]) -> dict:
    """`aggregate` split into low/high fame buckets.

    Exact-match is objective but not automatically VALID: on a famous song a
    model can score by memorization rather than by writing well. Every scored
    row already carries `views`, so this split costs nothing and turns that
    threat into a visible number — a gain that appears only in the high bucket
    is recall, and the difference between the buckets is the memorization gap.

    Rows with no `views` count as LOW fame: unknown provenance must never be
    quietly credited to the bucket where recall is possible.
    """
    low = [r for r in rows if (r.get("views") or 0) < FAME_THRESHOLD]
    high = [r for r in rows if (r.get("views") or 0) >= FAME_THRESHOLD]
    return {"low": aggregate(low), "high": aggregate(high)}


def aggregate(rows: List[dict]) -> dict:
    out: dict = {}
    for gran in sorted({r["granularity"] for r in rows}):
        sub = [r for r in rows if r["granularity"] == gran]
        entry: dict = {"n": len(sub)}
        for k in _AGG_KEYS:
            vals = [r[k] for r in sub if r.get(k) is not None]
            if vals:
                entry[k] = sum(vals) / len(vals)
                if len(vals) != len(sub):
                    entry[f"n_{k}"] = len(vals)
        out[gran] = entry
    return out
