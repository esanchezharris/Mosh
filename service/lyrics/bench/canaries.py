#!/usr/bin/env python3
"""Metric canaries (FMS WS1 / M5). Pure stdlib + the bench metrics.

A permanent set of degenerate fills that every sane metric must REJECT. They run
on every benchmark execution, and a metric that scores any canary as a pass is a
build failure — not a warning.

Why this exists. This program has twice been misled by a measurement rather than
by a model: 32.2% of rhyme items turned out to be junk (stopwords, sub-3-char
tokens) and INVERTED the arm ranking, and a whole arm's "fix" replayed from cache
and reported a large real effect as no effect. Both were caught by a human reading
output. Canaries are the cheap standing version of that read: they cannot tell you
a metric is right, but they fail loudly the moment one stops discriminating.

Each canary names the metric it targets and the pass it must NOT receive. A canary
that no metric rejects is itself a finding — it means nothing in the scoreboard
is sensitive to that failure mode.
"""
from __future__ import annotations

from typing import Dict, List, Optional

CANARY_VERSION = "v1"


def canary_fills(item: dict, pron=None) -> List[dict]:
    """Degenerate answers for one item, each with the metric it must not pass.

    Derived from the ITEM (not hardcoded strings), so the canaries stay valid as
    the eval is rebuilt — a fixed word list would silently stop being degenerate
    when the corpus changed.
    """
    con = item.get("constraints") or {}
    partner = (con.get("rhymeWith") or "").strip()
    target = ((item.get("target") or {}).get("text") or "").strip()
    n_syl = con.get("syllables") or 1

    out: List[dict] = [
        # 1. A repeated function word. Says nothing and is never a bar — but note
        #    what it must NOT be asserted against: on an item whose target happens
        #    to be 3 syllables, "the the the" legitimately SCANS, and `syl_fit`
        #    passing is the metric behaving correctly. The first version of this
        #    canary claimed syl_fit must fail and fired on a real item within
        #    minutes; the metric was right and the canary was wrong.
        #    So it targets `exact` only, and stands as a recorded blind spot:
        #    nothing deterministic on the board rejects a bar that scans and means
        #    nothing.
        {"id": "repeated-token", "fill": "the the the",
         "must_fail": ["exact"],
         "expected_pass": ["syl_fit"],
         "why": "a repeated function word is never a bar, yet it can SCAN — "
                "no deterministic metric catches this, only the accept-set "
                "and the owner's ear"},
        # 2. The empty answer. `metrics.score_item` scores [] as exact=0 — this
        #    checks the non-empty-but-worthless case is caught too.
        {"id": "whitespace", "fill": "   ",
         "must_fail": ["exact"],
         "why": "whitespace must never score as a fill"},
        # 3. A gross syllable violator: far outside target ± tol in one direction.
        {"id": "syllable-violator",
         "fill": " ".join(["everything"] * (int(n_syl) + 6)),
         "must_fail": ["syl_fit"],
         "why": "an answer many syllables over target must fail syl_fit"},
    ]
    if partner:
        # 4. Off-menu: a word that cannot rhyme with the partner. Built from the
        #    partner itself so it is degenerate for THIS item rather than in
        #    general.
        non_rhyme = _non_rhyme_for(partner, con.get("rhymeStrictness", "slant"), pron)
        if non_rhyme:
            out.append({"id": "off-menu",
                    "fill": non_rhyme,
                    "must_fail": ["rhyme_fit"],
                    "why": "a word that does not rhyme must fail rhyme_fit"})
        # 5. The subtle one: rhymes PERFECTLY and means nothing here. This is the
        #    failure the owner's sitting 5 measured — a formally-perfect rhyme
        #    read as not working 71% of the time. No deterministic metric on the
        #    board catches it, which is exactly the point: it must fail the
        #    ACCEPT-SET / judged metrics, and its passing rhyme_fit is expected.
        out.append({"id": "perfect-but-empty", "fill": partner,
                    "must_fail": ["exact"],
                    "expected_pass": ["rhyme_fit", "rhyme_perfect"],
                    "why": "echoing the partner rhymes perfectly and says nothing; "
                           "no deterministic metric catches this — it is the "
                           "standing reminder that rhyme_fit is not quality"})
    if target:
        # 6. The positive control. The artist's own word MUST pass everything —
        #    a canary suite with no passing case cannot distinguish "metric is
        #    strict" from "metric is broken".
        out.append({"id": "truth-positive-control", "fill": target,
                    "must_pass": ["exact", "syl_fit"],
                    "why": "the held-out truth must score as a pass, or the "
                           "metric rejects everything and proves nothing"})
    return out


_NON_RHYME_POOL = ("orange", "silver", "purple", "rhythm", "wolf", "month",
                   "depth", "glimpse", "sixth", "angst")


def _non_rhyme_for(partner: str, strictness: str, pron=None) -> Optional[str]:
    """A word that genuinely does NOT rhyme with `partner`, VERIFIED against the
    pronouncer rather than guessed from spelling.

    The first version compared trailing characters and fired on a real item within
    minutes: slant grading is phoneme-based and loose, so a spelling-disjoint word
    can still slant-rhyme. A canary that asserts "this cannot rhyme" has to KNOW
    that, or it reports a metric failure that is really its own.

    Returns None when no pool word clears the bar for this partner — the canary is
    then skipped for that item rather than fabricated, and `run_canaries` reports
    the skip so a silently-absent canary is visible.
    """
    if pron is None:
        return None
    for cand in _NON_RHYME_POOL:
        try:
            if not pron.rhyme(cand, partner, strictness):
                return cand
        except Exception:  # noqa: BLE001 — an unpronounceable candidate is just not it
            continue
    return None


def run_canaries(items: List[dict], pron, *, limit: int = 25) -> Dict:
    """Score every canary against the real metrics. Returns a report; the caller
    decides whether a violation is fatal (it is — see `bench_cli`).

    `limit` bounds the cost: canaries are a smoke test of the METRICS, not of the
    slice, so a sample is sufficient and the sample is deterministic (the first N
    of an itemId-sorted list).
    """
    from lyrics.bench import metrics

    sample = sorted(items, key=lambda i: i["itemId"])[:max(1, int(limit))]
    violations: List[dict] = []
    checked = 0
    skipped: Dict[str, int] = {}
    for item in sample:
        for canary in canary_fills(item, pron):
            row = metrics.score_item(item, [canary["fill"]], pron)
            checked += 1
            for metric in canary.get("must_fail", []):
                got = row.get(metric)
                # None = not applicable to this item; that is not a pass.
                if got == 1:
                    violations.append({"itemId": item["itemId"], "canary": canary["id"],
                                       "metric": metric, "scored": got,
                                       "why": canary["why"]})
            for metric in canary.get("must_pass", []):
                if row.get(metric) == 0:
                    violations.append({"itemId": item["itemId"], "canary": canary["id"],
                                       "metric": metric, "scored": row.get(metric),
                                       "why": "positive control must pass: "
                                              + canary["why"]})
        for want in ("off-menu",):
            if not any(c["id"] == want for c in canary_fills(item, pron)):
                skipped[want] = skipped.get(want, 0) + 1
    return {"version": CANARY_VERSION, "itemsSampled": len(sample),
            "assertionsChecked": checked, "violations": violations,
            # A canary that could not be CONSTRUCTED for an item is reported, not
            # silently absent — otherwise coverage quietly shrinks to nothing.
            "skipped": skipped, "ok": not violations}
