#!/usr/bin/env python3
"""IPA normalization — the inventory firewall between the two phoneme sources.

Two streams must land in ONE panphon-scorable segment inventory:
  recognizer side  eSpeak-IPA strings from wav2vec2-xlsr-53-espeak-cv-ft (stress/length
                   marks, espeak-isms like ɾ ɐ ɜ ɚ, multilingual leakage possible)
  candidate side   ARPAbet from phonology.core.Pronouncer (cmudict → g2p_en), mapped
                   through the static ARPA_TO_IPA table below

Both go through normalize_ipa(), so folds happen identically. All folding is DATA
(tables), so a preflight failure is fixed by adding a row, not code. Diphthongs and
affricates are represented as TWO segments on both sides (aɪ → a,ɪ; CH → t,ʃ) —
panphon's per-feature distance then makes near-misses cheap instead of binary.

inventory_report() is the hard gate: any segment panphon cannot feature-vectorize is
reported, and callers abort — a silently dropped segment would make every downstream
distance quietly wrong (the vacuous-verification failure mode this repo documents).
"""
from __future__ import annotations

import re
import unicodedata
from typing import Dict, List, Optional, Sequence

# ── ARPAbet → IPA (stress digit handled separately; AH is the one stress-sensitive row) ──

ARPA_TO_IPA: Dict[str, str] = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AH0": "ə", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "EH": "ɛ", "ER": "əɹ", "EY": "eɪ",
    "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "i", "JH": "dʒ", "K": "k",
    "L": "l", "M": "m", "N": "n", "NG": "ŋ", "OW": "oʊ", "OY": "ɔɪ", "P": "p",
    "R": "ɹ", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "UH": "ʊ", "UW": "u",
    "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}

# Characters carrying no segmental identity for this metric: stress, length, syllabicity,
# ties, parse junk. Stripped BEFORE segmentation.
STRIP_CHARS = "ˈˌːˑ‿̩̯̃͡" + "0123456789"

# Per-segment folds applied to BOTH sides after segmentation. Values may be multi-seg
# (expanded in place) or "" (dropped). Grown by preflight evidence, never speculatively.
SEG_FOLD: Dict[str, str] = {
    "ɐ": "ʌ",     # espeak near-open central → the ARPAbet AH nucleus
    "ɜ": "ə",     # NURSE nucleus (espeak) → schwa (ER decomposes to əɹ)
    "ɚ": "əɹ",    # rhotacized schwa → two segs, matching ARPA_TO_IPA["ER"]
    "ɝ": "əɹ",
    "ɾ": "t",     # alveolar tap (espeak US) → /t/ (feature-close already)
    "ɫ": "l",     # dark l
    "ʔ": "",      # glottal stop carries no lexical identity in English
    "ᵻ": "ɪ",     # espeak barred-i (reduced KIT)
    "a": "a", "e": "e", "o": "o",  # identity rows: legal, panphon-known
}

_VOWEL_SEGS = set("ɑæʌəɔʊɪɛiueoaɒ")  # nucleus chars (post-fold inventory)


def is_vowel_seg(seg: str) -> bool:
    return bool(seg) and seg[0] in _VOWEL_SEGS


def _fold(segs: Sequence[str]) -> List[str]:
    out: List[str] = []
    for s in segs:
        f = SEG_FOLD.get(s, s)
        if not f:
            continue
        if s in SEG_FOLD and len(f) > 1:
            out.extend(f)          # a multi-char fold VALUE is several segments ("əɹ")
        else:
            out.append(f)          # unfolded multi-char segs (diacritic combos) stay whole
    return out


def _segment(ipa: str, ft=None) -> List[str]:
    """Split an IPA string into segments. With a panphon FeatureTable use ipa_segs
    (handles diacritics); without one, fall back to per-codepoint (tests, no-deps)."""
    if ft is not None:
        return ft.ipa_segs(ipa)
    return [ch for ch in ipa]


def normalize_ipa(ipa: str, ft=None) -> List[str]:
    """eSpeak/whatever IPA string → folded segment list, deterministically.

    Folds are applied at STRING level before segmentation (all SEG_FOLD keys are single
    codepoints): panphon's segmenter silently DROPS symbols it does not know (ɚ proved
    this), so folding after segmentation would lose exactly the segments the table
    exists to rescue. The post-segment _fold pass stays as a harmless second net."""
    s = unicodedata.normalize("NFC", ipa or "")
    s = "".join(ch for ch in s if ch not in STRIP_CHARS and not ch.isspace())
    s = "".join(SEG_FOLD.get(ch, ch) for ch in s)
    return _fold(_segment(s, ft))


def arpa_phone_to_segs(phone: str) -> List[str]:
    """One ARPAbet phone (optional stress digit) → folded IPA segment list."""
    stress = phone[-1] if phone and phone[-1].isdigit() else None
    base = phone[:-1] if stress is not None else phone
    key = "AH0" if (base == "AH" and stress == "0") else base
    ipa = ARPA_TO_IPA.get(key)
    if ipa is None:
        return []
    return _fold(list(_iter_ipa_units(ipa)))


def _iter_ipa_units(ipa: str):
    """Yield the per-segment units of a mapping value (diphthongs/affricates → chars,
    but keep tʃ/dʒ as their two chars too — everything is single-codepoint here)."""
    for ch in ipa:
        yield ch


def arpa_line_to_ipa(words: Sequence[str], pronouncer) -> Optional[dict]:
    """Candidate text → the same shape a template line carries.

    Returns {"segs", "vowels", "syllables", "stress", "oov"} or None when NO word could
    be pronounced (a line we cannot score honestly — callers must exclude, not guess).
    Words the pronouncer can't voice are counted in "oov" and skipped; a line is
    returned only when every word pronounced (partial lines would bias length terms).
    """
    segs: List[str] = []
    vowels: List[str] = []
    stress = ""
    syllables = 0
    for w in words:
        phones = pronouncer.phones(w)
        if not phones:
            return None
        stress += pronouncer.stress(w)
        for p in phones:
            ps = arpa_phone_to_segs(p)
            segs.extend(ps)
            if p[-1].isdigit():
                syllables += 1
                if ps:
                    vowels.append(ps[0])   # nucleus = first seg of the vowel mapping
    if not segs:
        return None
    return {"segs": segs, "vowels": vowels, "syllables": syllables, "stress": stress}


def vowels_of_segs(segs: Sequence[str]) -> List[str]:
    return [s for s in segs if is_vowel_seg(s)]


def inventory_report(segs: Sequence[str], ft) -> dict:
    """Which segments can panphon actually score? Callers hard-fail on unknowns."""
    unknown = sorted({s for s in segs if not _known(ft, s)})
    total = len(list(segs)) or 1
    known = sum(1 for s in segs if _known(ft, s))
    return {"unknown": unknown, "coverage": known / total}


def _known(ft, seg: str) -> bool:
    try:
        v = ft.fts(seg)
    except Exception:  # noqa: BLE001 — any panphon parse failure = unknown
        return False
    return v is not None and len(_numeric(ft, v)) > 0


def _numeric(ft, fts_result) -> List[int]:
    """Feature vector as ints across panphon API generations."""
    if hasattr(fts_result, "numeric"):
        return list(fts_result.numeric())
    if isinstance(fts_result, dict):
        return [_sign(x) for x in fts_result.values()]
    return [_sign(v) for _, v in fts_result]


def _sign(v) -> int:
    if isinstance(v, (int, float)):
        return int(v)
    return {"+": 1, "-": -1, "0": 0}.get(str(v), 0)


_ARPABET_RE = re.compile(r"^[A-Z]+[0-2]?$")


def mapping_totality_check() -> List[str]:
    """Every ARPAbet phone class (the 39) must map; returns the missing ones."""
    classes = ["AA", "AE", "AH", "AO", "AW", "AY", "B", "CH", "D", "DH", "EH", "ER",
               "EY", "F", "G", "HH", "IH", "IY", "JH", "K", "L", "M", "N", "NG", "OW",
               "OY", "P", "R", "S", "SH", "T", "TH", "UH", "UW", "V", "W", "Y", "Z", "ZH"]
    return [c for c in classes if c not in ARPA_TO_IPA]
