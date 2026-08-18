#!/usr/bin/env python3
"""Template assembly — the pure post-processing behind phoneme_extract.py.

Everything after the model's per-frame argmax is HERE (stdlib + ipa_norm), so the
logic golden-tests without torch: CTC collapse (keeping frame spans + confidences),
line segmentation, held-vowel merging against real onsets, energy-proxy stress, and
final template-line assembly.

Sung-domain guard: a held note decodes as a run of identical vowel phones. Merging
them blindly would eat REAL re-articulations ("down down down"), so a merge happens
only when NO detected onset (f0.json nuclei from the take's -v1 dir) falls in the gap
— the onset list is consulted, and template_build_test RED-proves that sabotaging it
changes the output."""
from __future__ import annotations

from typing import Callable, List, Optional, Sequence, Tuple

import ipa_norm

HELD_VOWEL_MAX_GAP_S = 0.25   # identical vowels closer than this merge (unless onset)
BLANK_LINE_GAP_S = 0.4        # silence run that starts a new line (mirrors extract.py)


# ── CTC collapse ─────────────────────────────────────────────────────────────────────

def ctc_collapse(frame_ids: Sequence[int], frame_confs: Sequence[float], blank_id: int,
                 sec_per_frame: float, id_to_tok: Callable[[int], str],
                 pad_ids: Sequence[int] = ()) -> List[dict]:
    """Per-frame argmax → collapsed phones with time spans + mean confidence.

    Repeats merge, blanks/pads split repeats (standard CTC semantics — a blank between
    identical ids means two REAL tokens, which is exactly how a re-articulated vowel
    survives)."""
    skip = {blank_id, *pad_ids}
    out: List[dict] = []
    prev_id: Optional[int] = None
    for i, fid in enumerate(frame_ids):
        if fid in skip:
            prev_id = None
            continue
        t0, t1 = i * sec_per_frame, (i + 1) * sec_per_frame
        c = float(frame_confs[i]) if i < len(frame_confs) else 0.0
        if fid == prev_id and out:
            out[-1]["end"] = t1
            out[-1]["_confs"].append(c)
        else:
            out.append({"tok": id_to_tok(fid), "start": t0, "end": t1, "_confs": [c]})
        prev_id = fid
    for p in out:
        confs = p.pop("_confs")
        p["conf"] = sum(confs) / len(confs) if confs else 0.0
    return out


# ── Line segmentation ────────────────────────────────────────────────────────────────

def lines_from_words(words: Sequence[dict], gap_s: float = BLANK_LINE_GAP_S) -> List[Tuple[float, float]]:
    """Whisper word list → line time spans via the same contiguity rule extract.py uses
    (a pause ≥ gap_s starts a new phrase). Confidence is irrelevant here — even a
    misrecognized word marks voiced time correctly."""
    spans: List[Tuple[float, float]] = []
    for w in sorted(words, key=lambda w: float(w.get("start", 0.0))):
        s, e = float(w.get("start", 0.0)), float(w.get("end", 0.0))
        if spans and s - spans[-1][1] < gap_s:
            spans[-1] = (spans[-1][0], max(spans[-1][1], e))
        else:
            spans.append((s, e))
    return spans


def lines_from_blanks(phones: Sequence[dict], gap_s: float = BLANK_LINE_GAP_S) -> List[Tuple[float, float]]:
    """Fallback when no word cache exists: a ≥ gap_s hole in the phone stream splits."""
    spans: List[Tuple[float, float]] = []
    for p in phones:
        s, e = p["start"], p["end"]
        if spans and s - spans[-1][1] < gap_s:
            spans[-1] = (spans[-1][0], max(spans[-1][1], e))
        else:
            spans.append((s, e))
    return spans


def cut_lines(phones: Sequence[dict], spans: Sequence[Tuple[float, float]]) -> List[List[dict]]:
    """Assign each phone to the span containing its midpoint (nearest span if none)."""
    lines: List[List[dict]] = [[] for _ in spans]
    if not spans:
        return lines
    for p in phones:
        mid = (p["start"] + p["end"]) / 2.0
        idx = None
        for i, (s, e) in enumerate(spans):
            if s <= mid < e + 1e-9:
                idx = i
                break
        if idx is None:
            idx = min(range(len(spans)),
                      key=lambda i: min(abs(mid - spans[i][0]), abs(mid - spans[i][1])))
        lines[idx].append(p)
    return lines


# ── Held-vowel merge (the "down down down" guard) ───────────────────────────────────

def _is_vowel_tok(tok: str, ft=None) -> bool:
    segs = ipa_norm.normalize_ipa(tok, ft)
    return any(ipa_norm.is_vowel_seg(s) for s in segs)


def merge_held_vowels(phones: Sequence[dict], onsets: Sequence[float], ft=None,
                      max_gap_s: float = HELD_VOWEL_MAX_GAP_S) -> List[dict]:
    """Merge consecutive IDENTICAL vowel phones separated by < max_gap_s, unless a
    detected onset falls inside the gap/second phone start — then it is a real
    re-articulation and stays split."""
    out: List[dict] = []
    for p in phones:
        if (out and p["tok"] == out[-1]["tok"] and _is_vowel_tok(p["tok"], ft)
                and p["start"] - out[-1]["end"] < max_gap_s
                and not any(out[-1]["end"] - 1e-9 <= o <= p["start"] + 1e-9 for o in onsets)):
            out[-1] = dict(out[-1], end=p["end"], conf=(out[-1]["conf"] + p["conf"]) / 2.0)
        else:
            out.append(dict(p))
    return out


def split_long_lines(lines: List[List[dict]], max_phones: int = 60) -> List[List[dict]]:
    """Recursively split any line with > max_phones phones at its LARGEST internal
    inter-phone gap (the most phrase-boundary-like point). Continuous singing/rapping
    defeats gap segmentation (poppinshit produced a 95-syllable 'line'); candidates
    can only be generated at phrase scale."""
    out: List[List[dict]] = []
    for line in lines:
        if len(line) <= max_phones or len(line) < 2:
            out.append(line)
            continue
        gaps = [(line[k + 1]["start"] - line[k]["end"], k) for k in range(len(line) - 1)]
        _, cut = max(gaps, key=lambda g: (g[0], -abs(g[1] - len(line) // 2)))
        out.extend(split_long_lines([line[:cut + 1], line[cut + 1:]], max_phones))
    return out


def onsets_from_f0(contour: Sequence[dict], gap_s: float = 0.05) -> List[float]:
    """Voicing onsets from a v1 f0.json contour ([{t, hz}] over VOICED frames only,
    10ms hop with holes at unvoiced spans): each voiced run's first t is an onset."""
    onsets: List[float] = []
    prev_t: Optional[float] = None
    for pt in contour:
        t = float(pt.get("t", 0.0))
        if prev_t is None or t - prev_t > gap_s:
            onsets.append(t)
        prev_t = t
    return onsets


# ── Stress from energy ───────────────────────────────────────────────────────────────

def rms_at(rms: Sequence[float], hop_s: float, t0: float, t1: float) -> float:
    i0, i1 = int(t0 / hop_s), max(int(t0 / hop_s) + 1, int(t1 / hop_s))
    window = list(rms[i0:i1]) or [0.0]
    return sum(window) / len(window)


def stress_from_energy(vowel_spans: Sequence[Tuple[float, float]],
                       rms: Sequence[float], hop_s: float) -> str:
    """'X' where the vowel's mean RMS clears the line median (a lone vowel is 'X' —
    an accent, same convention as lyrics.mumble._stress)."""
    if not vowel_spans:
        return ""
    if len(vowel_spans) == 1:
        return "X"
    means = [rms_at(rms, hop_s, s, e) for s, e in vowel_spans]
    med = sorted(means)[len(means) // 2]
    return "".join("X" if m > med else "x" for m in means)


# ── Assembly ─────────────────────────────────────────────────────────────────────────

def build_line(phones: Sequence[dict], rms: Sequence[float], hop_s: float,
               index: int, ft=None) -> Optional[dict]:
    """One line's merged phones → the template-line dict distance.score_line consumes."""
    if not phones:
        return None
    segs: List[str] = []
    vowel_spans: List[Tuple[float, float]] = []
    vowels: List[str] = []
    for p in phones:
        ps = ipa_norm.normalize_ipa(p["tok"], ft)
        segs.extend(ps)
        nuclei = [s for s in ps if ipa_norm.is_vowel_seg(s)]
        if nuclei:
            vowel_spans.append((p["start"], p["end"]))
            vowels.append(nuclei[0])
    if not segs:
        return None
    return {
        "index": index,
        "start": phones[0]["start"], "end": phones[-1]["end"],
        "phones": [{"ipa": p["tok"], "start": round(p["start"], 3),
                    "end": round(p["end"], 3), "conf": round(p["conf"], 3)} for p in phones],
        "segs": segs,
        "syllables": len(vowel_spans),
        "stress": stress_from_energy(vowel_spans, rms, hop_s),
        "vowels": vowels,
    }
