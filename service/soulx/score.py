#!/usr/bin/env python3
"""SoulX target-score author (FMS Phase-3 Stage 2, fake-first).

Accepted lyric lines + their per-line `lyricScore` blobs (Stage 1's persisted render
skeleton: articulation slots with melisma `segments`) -> the SoulX-Singer target-score
JSON, the exact shape the KS-A grid renders validated (scripts/fms-killshot/
score_author.py + the frozen KS-A verdict): per-event `text` / `phoneme` (en_-prefixed
dash-joined ARPAbet with stress digits) / `note_pitch` (MIDI, 0 = rest) / `note_type`
(1 rest, 2 word onset, 3 continuation of the same word) / `duration` (seconds), plus
`time` [0, total_ms]. Pitches come from the owner's own take, so the score is already
in his register (the KS-A transposition lesson).

Word→slot reconciliation policy (v0, deterministic, never inventing):
- exact fit (the L2-generated happy path: text syllables == slot count) → 1:1;
- a multi-syllable word consumes its syllable count of slots — first segment type 2,
  every later segment type 3 (the model spreads the word's phones over the group);
- more words than slots → the first n-1 words own a slot each, the rest share the
  LAST slot evenly (every word stays sung — intelligibility first);
- leftover slots → held continuations of the last word (the take had more
  articulations than the text: hold, don't drop);
- `___` gap tokens sing the placeholder "la" (a vocalization, never an invented word);
- slot gaps ≥ 10 ms between words → <SP> rests; gaps INSIDE one word's allocation are
  legato-bridged (the previous segment extends — a singer holds through, and the
  timeline stays take-aligned so the render lands on the source clip's grid).

Pure stdlib + the phonology core (cmudict/g2p when importable; a word with no phones
gets "AH1" per syllable — never crashes on gibberish/slang).
"""
from __future__ import annotations

import re
from typing import List, Optional

from phonology import core as ph

_REST_MIN_S = 0.01
_pronouncer: Optional[ph.Pronouncer] = None


def _pron() -> ph.Pronouncer:
    global _pronouncer
    if _pronouncer is None:
        _pronouncer = ph.Pronouncer()
    return _pronouncer


def _clean(word: str) -> str:
    return re.sub(r"[^a-z']", "", word.lower())


def _phoneme(word: str, syl: int) -> str:
    """en_-prefixed dash-joined ARPAbet for a word; fallback = AH1 per syllable."""
    phones = _pron().phones(_clean(word))
    if not phones:
        phones = ["AH1"] * max(1, syl)
    return "en_" + "-".join(str(p) for p in phones)


def _display_and_phoneme(word: str):
    """Singable form of a token: `___` gaps become the placeholder "la"; returns
    (display, en_-phoneme) with the AH1-per-syllable fallback for unknown words."""
    display = "la" if word.strip("_") == "" else word
    syl = max(1, _pron().syllables(_clean(display)) or 1)
    return display, _phoneme(display, syl)


def _word_units(words: List[str], slots: List[dict]):
    """Allocate slots to words per the v0 policy -> [(word, [slot, ...]), ...]; when
    words outnumber slots the final unit is ([word, ...], [last_slot]) — the surplus
    words as a LIST sharing the one remaining slot (the squeeze tail)."""
    n = len(slots)
    if len(words) > n:
        units = [(words[i], [slots[i]]) for i in range(n - 1)]
        units.append((words[n - 1:], [slots[n - 1]]))          # squeeze: words share the last slot
        return units
    pr = _pron()
    syls = [max(1, pr.syllables(_clean(w)) or 1) for w in words]
    units, pos = [], 0
    for i, w in enumerate(words):
        need_after = len(words) - 1 - i
        k = max(1, min(syls[i], n - pos - need_after))
        units.append((w, slots[pos:pos + k]))
        pos += k
    if pos < n:                                                 # leftover slots: hold the last word
        w, taken = units[-1]
        units[-1] = (w, taken + slots[pos:])
    return units


def author_score(lines: List[dict], language: str = "English", name: str = "mosh-sheet") -> dict:
    """[{text, score: lyricScore-blob|None}, ...] -> {"ok", "score": [clip], stats}.

    Lines without a score blob are SKIPPED and counted (typed-later lines have no take
    flow — never invent timing). Emits ONE clip covering the whole sheet on the take's
    own timeline (leading/inter-line gaps are <SP> rests), so the rendered WAV lands
    aligned with the source clip."""
    scored = [ln for ln in (lines or [])
              if isinstance(ln.get("score"), dict) and ln["score"].get("slots")]
    if not scored:
        return {"ok": False, "error": "no_scored_lines",
                "linesUsed": 0, "linesSkipped": len(lines or [])}

    text_t, phon_t, pitch_t, type_t, dur_t = [], [], [], [], []
    cursor = 0.0
    n_words = n_rests = 0

    def emit(tok: str, phon: str, pitch: int, ntype: int, dur: float) -> None:
        text_t.append(tok); phon_t.append(phon)
        pitch_t.append(int(pitch)); type_t.append(int(ntype)); dur_t.append(max(0.0, dur))

    def emit_word(word: str, segs: List[dict]) -> None:
        nonlocal n_words
        display, phon = _display_and_phoneme(word)
        for j, s in enumerate(segs):
            emit(display, phon, int(s.get("pitch", 69)), 2 if j == 0 else 3,
                 float(s["end"]) - float(s["start"]))
        n_words += 1

    for ln in scored:
        slots = sorted(ln["score"]["slots"], key=lambda s: float(s.get("start", 0.0)))
        raw_words = [w for w in str(ln.get("text", "") or "").split() if w]
        words = raw_words or ["la"]
        for unit_word, unit_slots in _word_units(words, slots):
            u_start = float(unit_slots[0]["start"])
            u_end = float(unit_slots[-1]["end"])
            gap = u_start - cursor
            if gap >= _REST_MIN_S:
                emit("<SP>", "<SP>", 0, 1, gap)
                n_rests += 1
            if isinstance(unit_word, list):                     # squeeze tail: share the slot evenly
                span = (u_end - u_start) / len(unit_word)
                pitch = int(unit_slots[0]["segments"][0].get("pitch", 69)) \
                    if unit_slots[0].get("segments") else 69
                for w in unit_word:
                    display, phon = _display_and_phoneme(w)
                    emit(display, phon, pitch, 2, span)
                    n_words += 1
            else:
                # Flatten the allocated slots' segments, legato-bridging intra-word
                # slot gaps: each segment's duration runs to the NEXT segment's start
                # (the last runs to the unit end) so the timeline never drifts.
                segs = [dict(s) for sl in unit_slots
                        for s in (sl.get("segments") or [{"start": sl["start"], "end": sl["end"],
                                                          "pitch": 69}])]
                for j, s in enumerate(segs):
                    s_end = float(segs[j + 1]["start"]) if j + 1 < len(segs) else u_end
                    s["end"] = max(float(s["end"]), s_end)
                emit_word(unit_word, segs)
            cursor = max(cursor, u_end)

    # Duration formatting with ERROR DIFFUSION: the timeline is reconstructed by SUMMING
    # these tokens (fake renderer and real model alike), so per-token rounding must not
    # accumulate — the SoulX example's plain 2dp drifted real-take onsets up to ~33 ms
    # (owner ear-caught 2026-07-04), and even 4dp drifts ~4 ms when durations share a
    # rounding direction. Quantizing each token as (true cumulative − emitted cumulative)
    # keeps the CHAIN within 0.05 ms of the take's grid for any score length.
    qdur, acc_true, acc_emit = [], 0.0, 0.0
    for d in dur_t:
        acc_true += d
        q = max(0.0, round(acc_true - acc_emit, 4))
        qdur.append(q)
        acc_emit += q
    total_ms = round(acc_emit * 1000)
    clip = {
        "index": f"{name}_0_{total_ms}",
        "language": language,
        "time": [0, total_ms],
        "duration": " ".join(f"{q:.4f}" for q in qdur),
        "text": " ".join(text_t),
        "phoneme": " ".join(phon_t),
        "note_pitch": " ".join(str(p) for p in pitch_t),
        "note_type": " ".join(str(t) for t in type_t),
    }
    return {"ok": True, "score": [clip],
            "linesUsed": len(scored), "linesSkipped": len(lines) - len(scored),
            "events": len(dur_t), "words": n_words, "rests": n_rests,
            "duration_s": round(sum(dur_t), 3)}
