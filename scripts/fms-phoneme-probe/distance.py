#!/usr/bin/env python3
"""Weighted phonemic distance — the metric under test (pure: panphon + stdlib).

A candidate line is scored against a take-template line as a weighted sum of four
normalized terms (lower = better):

  seg       DP edit distance over the full segment sequence, substitution cost =
            panphon feature disagreement in [0,1] (so /s/↔/ʃ/ is cheap, /s/↔/m/ dear),
            scaled by vowel_mult when either segment is a nucleus
  vowelseq  the same DP over the VOWEL sequences only — the load-bearing term for
            singing (vowels survive a mumble; consonants don't)
  syl       |syllable count difference| / target
  stress    per-syllable contour hamming (positions past the shorter contour count
            as misses, so length mismatch is not free)

All knobs live in WEIGHTS so the Stage-B sweep can vary one number. Deterministic:
no RNG, no I/O, no caching."""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from ipa_norm import _numeric, is_vowel_seg  # shared numeric-vector shim

WEIGHTS: Dict[str, float] = {
    "vowel_mult": 2.0,   # nucleus substitutions/indels cost this multiple
    "indel": 1.0,        # base insert/delete cost (before vowel_mult)
    "w_seg": 1.0,
    "w_vowelseq": 1.0,
    "w_syl": 0.5,
    "w_stress": 0.25,
}


class FeatureSpace:
    """Memoized panphon feature vectors + pairwise substitution costs."""

    def __init__(self, ft):
        self.ft = ft
        self._vec: Dict[str, Optional[List[int]]] = {}
        self._sub: Dict[tuple, float] = {}

    def vec(self, seg: str) -> Optional[List[int]]:
        if seg not in self._vec:
            try:
                fts = self.ft.fts(seg)
            except Exception:  # noqa: BLE001 — unknown segment
                fts = None
            self._vec[seg] = _numeric(self.ft, fts) if fts is not None else None
        return self._vec[seg]

    def sub_cost(self, a: str, b: str) -> float:
        """Feature disagreement in [0,1]; unknown segments cost the maximum (1.0) so a
        normalization hole can only HURT scores, never quietly help."""
        if a == b:
            return 0.0
        key = (a, b) if a <= b else (b, a)
        if key not in self._sub:
            va, vb = self.vec(a), self.vec(b)
            if va is None or vb is None or len(va) != len(vb) or not va:
                self._sub[key] = 1.0
            else:
                self._sub[key] = sum(1 for x, y in zip(va, vb) if x != y) / len(va)
        return self._sub[key]


def nucleus_flags(segs: Sequence[str]) -> List[bool]:
    """True where a segment is a syllable NUCLEUS: a vowel not preceded by a vowel.
    A vowel after a vowel is a diphthong GLIDE — and singing routinely drops glides
    (goingdown proved it: every sung "down" decodes as [daːn], no ʊ), so glides must
    cost like consonants or the TRUE lyric gets punished for being sung."""
    flags: List[bool] = []
    prev_vowel = False
    for s in segs:
        v = is_vowel_seg(s)
        flags.append(v and not prev_vowel)
        prev_vowel = v
    return flags


def weighted_seg_distance(tpl: Sequence[str], cand: Sequence[str], fs: FeatureSpace,
                          w: Dict[str, float] = WEIGHTS) -> float:
    """DP edit distance with feature-weighted substitution and NUCLEUS emphasis."""
    n, m = len(tpl), len(cand)
    if n == 0:
        return m * w["indel"]
    if m == 0:
        return n * w["indel"]
    vmul = w["vowel_mult"]
    tnuc, cnuc = nucleus_flags(tpl), nucleus_flags(cand)

    def indel(seg: str, nuc: bool) -> float:
        return w["indel"] * (vmul if nuc else 1.0)

    prev = [0.0] * (m + 1)
    for j in range(1, m + 1):
        prev[j] = prev[j - 1] + indel(cand[j - 1], cnuc[j - 1])
    for i in range(1, n + 1):
        cur = [prev[0] + indel(tpl[i - 1], tnuc[i - 1])] + [0.0] * m
        for j in range(1, m + 1):
            a, b = tpl[i - 1], cand[j - 1]
            sub_mult = vmul if (tnuc[i - 1] or cnuc[j - 1]) else 1.0
            cur[j] = min(
                prev[j - 1] + fs.sub_cost(a, b) * sub_mult,
                prev[j] + indel(a, tnuc[i - 1]),
                cur[j - 1] + indel(b, cnuc[j - 1]),
            )
        prev = cur
    return prev[m]


def _stress_term(want: str, got: str) -> Optional[float]:
    if not want:
        return None
    n = max(len(want), len(got))
    miss = sum(1 for i in range(n)
               if i >= len(want) or i >= len(got) or want[i] != got[i])
    return miss / n


def score_line(template_line: dict, cand: dict, fs: FeatureSpace,
               w: Dict[str, float] = WEIGHTS) -> dict:
    """Template line {"segs","vowels","syllables","stress"} vs a candidate of the same
    shape (ipa_norm.arpa_line_to_ipa output) → component dict + "total"."""
    tsegs, csegs = template_line["segs"], cand["segs"]
    tvow = template_line.get("vowels") or [s for s in tsegs if is_vowel_seg(s)]
    cvow = cand.get("vowels") or [s for s in csegs if is_vowel_seg(s)]

    seg = weighted_seg_distance(tsegs, csegs, fs, w) / max(len(tsegs), 1)
    vowelseq = weighted_seg_distance(tvow, cvow, fs, w) / max(len(tvow), 1)
    tsyl = template_line.get("syllables") or len(tvow)
    syl = abs((cand.get("syllables") or len(cvow)) - tsyl) / max(tsyl, 1)
    stress = _stress_term(template_line.get("stress") or "", cand.get("stress") or "")

    total = w["w_seg"] * seg + w["w_vowelseq"] * vowelseq + w["w_syl"] * syl
    if stress is not None:
        total += w["w_stress"] * stress
    return {"total": total, "seg": seg, "vowelseq": vowelseq, "syl": syl,
            "stress": stress}
