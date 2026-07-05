#!/usr/bin/env python3
"""Lyric EXTRACTION from a mumble take (FMS pipeline correction, 2026-07-04).

The owner's takes are not wordless: real — sometimes finished — lyrics sit next to
filler mumble. This module decides, from GENEROUSLY-decoded ASR words, what he really
said ("saved and extracted as such") versus what is mumble for the engine to complete.
The failure being corrected: the wordless skeleton path let generation OVERWRITE his
real words. Consequently every ambiguity here degrades toward KEEPING his words
(as anchors), never toward discarding them.

Two tiers ("generous decode, then REASON over it" — the owner's validated ASR posture):
  Tier 1 (deterministic, stdlib + phonology): filler/dictionary/confidence heuristics,
    thresholds tuned on the four cached real-take fixtures. Raw confidence alone is
    PROVABLY insufficient (fixture: filler "da" @ 0.41 vs real "bomb" @ 0.13 vs
    hallucinated "strawberry" @ 1e-5 — hence the filler set, the dict check, and the
    absolute hallucination floor).
  Tier 2 (optional LLM judge via brain_client, same real→fake posture as generation):
    re-labels PHRASES by whether they make sense as lyrics; it may promote/demote and
    drop words, but the HONESTY WALL forbids it from ever introducing a word that ASR
    did not hear — a violation falls back to tier 1 verbatim. Gated by the existing
    MOSH_ENABLE_LYRIC pin; absent brain → tier 1.

Phrase labels: "real" (verbatim lyric — becomes locked line text), "partial" (heard
words anchor the line, gaps regenerate), "mumble" (all gaps — today's behavior).
"""
from __future__ import annotations

import json
import re
import sys
from typing import List, Optional, Tuple

from lyrics import mumble
from phonology import core as ph

# Hallucination floor: below this the decoder was dreaming (fixture: "strawberry" on a
# la-la melisma @ 1.3e-5). Applies regardless of dictionary membership.
CONF_FLOOR = 0.01
# A word is credible alone at HI, or at LO when it carries >= 2 syllables (longer words
# are rarely confabulated wholesale; fixture: real "bomb" @ 0.13 needs its phrase).
CONF_HI = 0.55
CONF_LO = 0.12
REAL_MIN_FRACTION = 0.8    # phrase is "real" when >= this fraction of words are credible
MUMBLE_MAX_FRACTION = 0.2  # ... "mumble" when <= this (or all filler)
REAL_MIN_CONTENT = 2       # and a "real" phrase needs at least this many content words
PHRASE_GAP_S = 0.4         # same contiguity rule as skeleton.fuse_asr_budget
MELISMA_SPAN_FACTOR = 2.0  # word spanning >= factor x its syllables of articulation
                           # groups = likely a decoded melisma, demote its phrase

FILLERS = frozenset(
    "la da na ba pa ta dum dah doo dee dat mm mmm hmm hm ooh oh ah aah uh um woah whoa "
    "yeah yea ay ayy ey hey ho whoo woo sh shh".split())

_pronouncer: Optional[ph.Pronouncer] = None


def _pron() -> ph.Pronouncer:
    global _pronouncer
    if _pronouncer is None:
        _pronouncer = ph.Pronouncer()
    return _pronouncer


def _clean(word: str) -> str:
    return re.sub(r"[^a-z']", "", (word or "").lower())


def is_filler(word: str) -> bool:
    c = _clean(word)
    if not c:
        return True
    if c in FILLERS:
        return True
    # runs of one repeated character ("aaaa", "mmm") read as vocalization
    return len(set(c.replace("'", ""))) == 1 and len(c) >= 2


def credible(w: dict) -> bool:
    """Tier-1 word credibility (not filler + in-dict + confidence shape)."""
    c = _clean(w.get("word", ""))
    conf = float(w.get("confidence", 0) or 0)
    if not c or is_filler(c) or conf < CONF_FLOOR:
        return False
    if _pron().phones(c) is None:
        return False
    syl = int(w.get("syl") or _pron().syllables(c) or 1)
    return conf >= CONF_HI or (conf >= CONF_LO and syl >= 2)


def group_phrases(words: List[dict], gap_s: float = PHRASE_GAP_S) -> List[List[dict]]:
    """Contiguous ASR words (gap < gap_s) -> phrases, keeping word identity."""
    phrases: List[List[dict]] = []
    for w in sorted(words or [], key=lambda x: float(x.get("start", 0))):
        if phrases and float(w["start"]) - float(phrases[-1][-1]["end"]) < gap_s:
            phrases[-1].append(w)
        else:
            phrases.append([w])
    return phrases


def _melisma_suspect(w: dict, groups: List[dict]) -> bool:
    """A word whose ASR span covers far more articulation groups than it has syllables
    was probably decoded FROM a melisma (held vowel -> dreamt word)."""
    if not groups:
        return False
    a, b = float(w.get("start", 0)), float(w.get("end", 0))
    syl = max(1, int(w.get("syl") or 1))
    covered = sum(1 for g in groups if a - 0.02 <= float(g["start"]) < b + 0.02)
    return covered >= MELISMA_SPAN_FACTOR * syl and covered >= 3


def classify_phrase(phrase: List[dict], groups: List[dict]) -> str:
    words = [w for w in phrase if _clean(w.get("word", ""))]
    if not words:
        return "mumble"
    cred = [w for w in words if credible(w)]
    content = [w for w in words if not is_filler(w.get("word", ""))]
    # Fillers must not DILUTE the mumble test (review find): one real word ringed by
    # la-la's is a PARTIAL line (the word anchors), not mumble — content words are the
    # denominator for "is anything real here", all words for "is it mostly real".
    if not content or len(cred) / len(content) <= MUMBLE_MAX_FRACTION:
        return "mumble"
    label = "partial"
    if len(cred) / len(words) >= REAL_MIN_FRACTION and len(content) >= REAL_MIN_CONTENT:
        label = "real"
    if label == "real" and any(_melisma_suspect(w, groups) for w in cred):
        label = "partial"       # held-vowel decode can't silently expand his lyric
    return label


# ── tier 2: the LLM judge ("reason over the generous decode") ──────────────────────────

_JUDGE_PROMPT = (
    "You are auditing a speech-to-text transcript of a producer's mumbled vocal take. "
    "The decoder was deliberately GENEROUS: some phrases are the producer's real lyrics, "
    "some are half-real, some are pure melodic filler the decoder forced into words.\n"
    "For each numbered phrase, judge whether it reads as REAL lyric writing (label "
    "\"real\"), partly real (\"partial\"), or forced/nonsense (\"mumble\"), and list the "
    "0-based indices of words worth keeping verbatim. Judge by whether the WORDS MAKE "
    "SENSE together as lyrics — low decoder confidence does not disqualify a phrase that "
    "reads true. NEVER add, correct, or substitute words; only keep or drop what is "
    "there.\nReturn JSON: {\"phrases\": [{\"i\": <index>, \"label\": \"real|partial|"
    "mumble\", \"keep\": [word indices]}]}"
)


def _judge_tier2(phrases: List[List[dict]], labels: List[str],
                 t1_verdicts: List[Tuple[str, set]]) -> Optional[List[Tuple[str, set]]]:
    """LLM re-labeling with the honesty wall. Returns [(label, keep_indices)] aligned
    with phrases, or None on any failure/violation (caller keeps tier 1).

    Verdicts are SEEDED from tier 1 (review find): a valid-but-partial judge reply —
    omitted phrases, or a real/partial entry with an empty keep list — must NEVER
    silently un-keep the producer's words; every uncovered/incoherent phrase retains
    its full tier-1 verdict (label AND keep set)."""
    try:
        import brain_client
        if not brain_client.available():
            return None
        payload = [{"i": i,
                    "t1": labels[i],
                    "words": [{"j": j, "w": w.get("word", ""),
                               "conf": round(float(w.get("confidence", 0) or 0), 3)}
                              for j, w in enumerate(p)]}
                   for i, p in enumerate(phrases)]
        resp = brain_client.chat_json(
            [{"role": "system", "content": _JUDGE_PROMPT},
             {"role": "user", "content": json.dumps({"phrases": payload})}],
            max_tokens=1600)
        if not resp.get("ok"):
            return None
        res = json.loads(resp.get("content", "") or "{}")
        out: List[Tuple[str, set]] = list(t1_verdicts)
        for v in (res or {}).get("phrases", []):
            i = int(v.get("i", -1))
            if not (0 <= i < len(phrases)):
                return None
            label = str(v.get("label", "")).strip()
            if label not in ("real", "partial", "mumble"):
                return None
            keep = set()
            for j in v.get("keep", []) or []:
                j = int(j)
                if not (0 <= j < len(phrases[i])):
                    return None          # honesty wall: index outside the heard words
                keep.add(j)
            # A real/partial verdict keeping ZERO words is incoherent — fall back to the
            # phrase's tier-1 keep set rather than dropping his words (keep-bias).
            if label != "mumble" and not keep:
                keep = set(t1_verdicts[i][1])
            out[i] = (label, keep)
        return out
    except Exception as e:  # noqa: BLE001 — judge is an upgrade, never a breaker
        print(f"[extract] tier-2 judge skipped: {e}", file=sys.stderr)
        return None


# ── the extraction ─────────────────────────────────────────────────────────────────────

def extract(words: List[dict], groups: List[dict], bpm: float, time_sig=(4, 4),
            grid: str = "1/16", use_llm: bool = True) -> dict:
    """ASR words + articulation groups -> per-bar extraction verdicts.

    Returns {"kept": [word...], "line_text": {bar: str|None},
             "line_origin": {bar: "sung"|"partial"|None}, "line_heard": {bar: blob},
             "stats": {...}}. `kept` words feed mumble.build_spec_from_take anchoring
    (conf_threshold=0.0 — the tiers already decided); blobs persist EVERYTHING heard
    (kept or not, slot or not) for future splice boundaries and correction seeds."""
    spb = mumble._sec_per_bar(bpm, time_sig)
    binned = mumble._bin_bars(groups or [], spb)
    slots_by_bar = {bar: gs for bar, gs in binned}
    surviving = set(slots_by_bar)

    phrases = group_phrases(words)
    t1_labels = [classify_phrase(p, groups or []) for p in phrases]
    t1_verdicts: List[Tuple[str, set]] = [
        (lab, {j for j, w in enumerate(p) if credible(w)})
        for lab, p in zip(t1_labels, phrases)]
    verdicts = _judge_tier2(phrases, t1_labels, t1_verdicts) if use_llm else None
    tier = "t2" if verdicts is not None else "t1"
    if verdicts is None:
        verdicts = t1_verdicts
    else:
        # ABSOLUTE WALLS the judge cannot waive (review finds): the hallucination floor
        # (CONF_FLOOR — "strawberry" @ 1e-5 stays dead however true it reads) and the
        # melisma-decode guard apply to ITS keeps too; excising a word from a "real"
        # phrase demotes it to "partial" so the bar can't land verbatim with a hole.
        walled: List[Tuple[str, set]] = []
        for (label, keep), phrase in zip(verdicts, phrases):
            keep2 = {j for j in keep
                     if float(phrase[j].get("confidence", 0) or 0) >= CONF_FLOOR
                     and not _melisma_suspect(phrase[j], groups or [])}
            if label == "real" and keep2 != set(keep):
                label = "partial"
            walled.append((label, keep2))
        verdicts = walled

    enriched: List[dict] = []
    for (label, keep), phrase in zip(verdicts, phrases):
        for j, w in enumerate(phrase):
            kept = j in keep and label != "mumble" and not is_filler(w.get("word", ""))
            enriched.append({**w, "kept": bool(kept), "label": label, "tier": tier})

    # bar assignment + slot hint (nearest group start within the bar; blob aid only)
    heard: dict = {}
    dropped_tail = unanchored = 0
    # Words past the last surviving bar are DROPPED only when MAX_BARS really truncated
    # the take (review find) — otherwise they ride the nearest bar's blob unanchored
    # ("blobs persist EVERYTHING heard" is the contract).
    truncated = len(binned) >= mumble.MAX_BARS
    for w in enriched:
        bar = int(float(w.get("start", 0.0)) // spb) if spb > 0 else 0
        if bar not in surviving:
            near = min(surviving, key=lambda b: abs(b - bar), default=None)
            if near is None or (truncated and surviving and bar > max(surviving)):
                dropped_tail += 1
                continue
            unanchored += 1
            w = {**w, "kept": False}     # words off any surviving bar never anchor
            bar = near
            slot = None
        else:
            gs = slots_by_bar[bar]
            slot = min(range(len(gs)),
                       key=lambda i: abs(float(gs[i]["start"]) - float(w["start"])))
        heard.setdefault(bar, []).append(
            {"word": str(w.get("word", "")).strip(), "start": round(float(w["start"]), 3),
             "end": round(float(w["end"]), 3),
             "conf": round(float(w.get("confidence", 0) or 0), 3),
             "syl": int(w.get("syl") or 1), "slot": slot,
             "kept": bool(w.get("kept")), "label": w["label"], "tier": w["tier"]})

    line_text: dict = {}
    line_origin: dict = {}
    for bar in surviving:
        ws = heard.get(bar, [])
        kept_ws = [x for x in ws if x["kept"]]
        if not kept_ws:
            line_text[bar] = None
            line_origin[bar] = None
            continue
        all_real = all(x["label"] == "real" for x in kept_ws)
        # Coverage is in SYLLABLES, not words (review find): slots are per-syllable
        # articulations, so "hold the flame tonight" (4 words, 5 syllables) covers a
        # 5-slot bar. Word-count comparison starved every multisyllabic sung line.
        covers = sum(max(1, int(x.get("syl") or 1)) for x in kept_ws) >= len(slots_by_bar[bar])
        if all_real and covers:
            line_text[bar] = " ".join(x["word"] for x in
                                      sorted(kept_ws, key=lambda x: x["start"]))
            line_origin[bar] = "sung"
        else:
            line_text[bar] = None
            line_origin[bar] = "partial"

    kept_words = [w for w in enriched if w.get("kept")]
    labels_count = {k: t1_labels.count(k) for k in ("real", "partial", "mumble")}
    return {"kept": kept_words,
            "line_text": line_text, "line_origin": line_origin,
            "line_heard": {bar: {"v": 1, "bar": bar, "words": ws}
                           for bar, ws in heard.items()},
            "stats": {"words": len(words or []), "phrases": len(phrases),
                      "tier": tier, "t1_labels": labels_count,
                      "kept": len(kept_words),
                      "sung_lines": sum(1 for v in line_origin.values() if v == "sung"),
                      "partial_lines": sum(1 for v in line_origin.values() if v == "partial"),
                      "dropped_after_max_bars": dropped_tail,
                      "unanchored_words": unanchored}}
