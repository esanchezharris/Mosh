#!/usr/bin/env python3
"""Verse-level rhyme planner (FMS WS1 / M3). Pure phonology — no LLM, no network.

Given a LineSpec, propose a small ranked set of end-word anchors per rhyme group
UP FRONT, so each line can be generated conditioned on a chosen anchor instead of
on an open-vocabulary rhyme target.

**What this is NOT for.** A pure-phonology ranker is `rhyme-floor` promoted to
verse scale, and the floor is already on record as not working: the owner's
sitting 5 rated a formally-perfect phonology rhyme as working 29% of the time
against the artist's real word at 86%. So the value here is not "picks the better
word". It is narrowing an open-vocabulary decision to a small, deterministic,
**user-editable** set that the model then writes meaning around — the fusion no
arm in the set has achieved. Design note:
docs/superpowers/specs/2026-07-27-fms-m3-verse-rhyme-planner-design.md

Seeding reuses `core._group_anchors` verbatim so the planner and the generation
loop can never disagree about which word anchors a group — the same discipline
that makes `_analyze_line` reuse `_evaluate`.

Lives here rather than in `phonology/core.py` (which stays LineSpec-agnostic).
Frequency comes from the PRODUCT table (`phonology/freq.py`, vendored
general-English ranks) unless the caller injects one — the bench's corpus-derived
table never ships and stays bench-only.
"""
from __future__ import annotations

import math
import re
from typing import Dict, List, Optional

from phonology.core import multisyllabic_depth, rhyme_grade

DEFAULT_PER_GROUP = 8

# Depth is the craft axis and must dominate: one extra rhyming syllable is worth
# DEPTH_WEIGHT, and the whole frequency range is capped strictly below it, so no
# amount of commonness buys a depth step.
DEPTH_WEIGHT = 2.0
FREQ_WEIGHT = 0.25
FREQ_CAP = 1.5

# One anchor per rime family, so the returned set is a CHOICE rather than eight
# spellings of one sound. Keyed on the stress-stripped rime of the candidate.
_MAX_PER_FAMILY = 2


def _pron():
    from phonology.core import Pronouncer
    return Pronouncer()


def _stopwords():
    """The PRODUCT stop list (phonology/freq.py) — drift-pinned by equality test
    against the bench's measured list, so the two cannot silently diverge and the
    planner no longer imports bench code. The reason this filter exists at all is
    that raw frequency ranking answers 'been / an / a / they / but'
    (PROGRAM.md, 2026-07-26)."""
    from phonology.freq import STOP_AND_FILLER
    return STOP_AND_FILLER


def _rime_family(phones: Optional[List[str]]) -> str:
    from phonology.core import rime_phones, _strip_stress
    if not phones:
        return ""
    return " ".join(_strip_stress(p) for p in (rime_phones(phones) or []))


def _remaining_budget(line: dict, spec: dict, pron) -> Optional[int]:
    """Syllables still unspoken on this line once the producer's own words are
    counted. A 4-syllable anchor cannot end a bar with 5 syllables left."""
    from lyrics import core as product_core
    target = product_core._target(line, spec)
    if not target:
        return None
    seed = line.get("seedText") or ""
    words = [t["w"] for t in product_core._tokens(seed) if not t["gap"]]
    return max(0, target - sum(pron.syllables(w) for w in words))


def _group_lines(spec: dict) -> Dict[str, List[dict]]:
    out: Dict[str, List[dict]] = {}
    for line in sorted(spec.get("lines", []), key=lambda l: int(l.get("index", 0))):
        g = line.get("rhymeGroup") or ""
        if g:
            out.setdefault(g, []).append(line)
    return out


def _seed_for(group: str, lines: List[dict], spec: dict, anchors: Dict[str, str],
              pron) -> Optional[str]:
    """The word the group rhymes against: the loop's own fixed anchor when there is
    one, else the most distinctive content word already written in the group."""
    if anchors.get(group):
        return anchors[group]
    from lyrics import core as product_core
    stop = _stopwords()
    for line in lines:
        text = (line.get("text") or "") + " " + (line.get("seedText") or "")
        words = [w for w in re.findall(r"[A-Za-z']+", text)
                 if len(w) >= 3 and w.lower() not in stop]
        if words:
            return words[-1]
    ends = product_core._topic_ends(spec)
    return ends[0] if ends else None


def plan_anchors(spec: dict, *, per_group: int = DEFAULT_PER_GROUP,
                 freq: Optional[Dict[str, int]] = None,
                 pronouncer=None) -> dict:
    """Ranked end-word anchor candidates per rhyme group.

    Deterministic: same spec + same lexicon + same freq table ⇒ same plan, with no
    RNG anywhere. Ties break alphabetically so the order is total.
    """
    pron = pronouncer or _pron()
    if freq is None:
        # The product frequency table (vendored general-English ranks). An
        # explicit {} stays {} — callers can force the historical alpha path.
        from phonology.freq import load_freq
        freq = load_freq()
    stop = _stopwords()

    from lyrics import core as product_core
    by_index = sorted(spec.get("lines", []), key=lambda l: int(l.get("index", 0)))
    fixed = product_core._group_anchors(by_index)          # reused, never re-derived
    groups_lines = _group_lines(spec)

    out_groups: Dict[str, dict] = {}
    for group, lines in sorted(groups_lines.items()):
        seed = _seed_for(group, lines, spec, fixed, pron)
        strictness = product_core._strictness(lines[0], spec)
        entry = {"seed": seed or "", "fixed": bool(fixed.get(group)),
                 "strictness": strictness, "candidates": []}
        if not seed:
            out_groups[group] = entry
            continue

        seed_phones = pron.phones(seed)
        budgets = [b for b in (_remaining_budget(l, spec, pron) for l in lines)
                   if b is not None]
        budget = min(budgets) if budgets else None

        # The candidate UNIVERSE, truncated by frequency rank rather than
        # alphabet (2026-07-28 pool fix): the old alpha-truncated 200 kept the
        # alphabetically-early slice of a big rime family, and no amount of
        # re-ranking below can recover words the truncation already dropped.
        # With freq={} this is the historical capped alpha search byte-for-byte.
        from phonology.freq import ranked_rhymes
        raw = ranked_rhymes(pron, seed, strictness, max_n=200, freq=freq)
        scored: List[dict] = []
        for word in raw:
            if len(word) < 3 or word.lower() in stop:
                continue
            wp = pron.phones(word)
            n_syl = pron.syllables(word)
            # A candidate longer than the shortest line's remaining budget cannot
            # end that bar at all — a "valid rhyme" the loop could never use.
            if budget is not None and n_syl > budget:
                continue
            grade = rhyme_grade(wp, seed_phones) if (wp and seed_phones) else "none"
            depth = (multisyllabic_depth(wp, seed_phones)
                     if (wp and seed_phones) else 0)
            f = int(freq.get(word.lower(), 0))
            # LOG frequency AND CAPPED, as plausibility rather than a maximand.
            # The log alone is not enough: at a realistic corpus count (~50k) the
            # term reaches ~2.7, which already outweighs a full depth step, so a
            # common shallow rhyme would displace a rare skilled one — the floor's
            # 'been / an / a' failure wearing a logarithm. The cap keeps the whole
            # frequency range worth strictly less than one depth step, which is
            # the property `planner_test` asserts directly.
            score = (DEPTH_WEIGHT * depth
                     + (1.0 if grade == "perfect" else 0.0)
                     + min(FREQ_WEIGHT * math.log1p(f), FREQ_CAP)
                     - 0.15 * abs(n_syl - 1))
            scored.append({"word": word, "syllables": n_syl, "grade": grade,
                           "depth": depth, "freq": f, "score": round(score, 4),
                           "family": _rime_family(wp)})

        scored.sort(key=lambda c: (-c["score"], c["word"]))
        picked, per_family = [], {}
        for cand in scored:
            fam = cand["family"]
            if per_family.get(fam, 0) >= _MAX_PER_FAMILY:
                continue
            per_family[fam] = per_family.get(fam, 0) + 1
            picked.append({k: v for k, v in cand.items() if k != "family"})
            if len(picked) >= per_group:
                break
        entry["candidates"] = picked
        out_groups[group] = entry

    ungrouped = [int(l.get("index", 0)) for l in by_index if not l.get("rhymeGroup")]
    return {"ok": True, "v": 1, "groups": out_groups, "ungrouped": ungrouped}
