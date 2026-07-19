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
- unresolved `___` gap tokens are never authored for sing render;
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
    # fold accents BEFORE stripping — "piñata" must reach g2p as "pinata", not "piata"
    # (the bare strip deleted the N from the sung phonemes; see phonology.fold_diacritics)
    return re.sub(r"[^a-z']", "", ph.fold_diacritics(word.lower()))


def _phoneme(word: str, syl: int) -> str:
    """en_-prefixed dash-joined ARPAbet for a word; fallback = AH1 per syllable."""
    phones = _pron().phones(_clean(word))
    if not phones:
        phones = ["AH1"] * max(1, syl)
    return "en_" + "-".join(str(p) for p in phones)


def _held_vowel(group: List[str]) -> str:
    """The sustained-vowel phone of a syllable group (the last vowel, else the last phone).
    Sung on a HELD continuation slot so the model sustains the note instead of re-attacking."""
    vowels = [p for p in group if p and p[-1].isdigit()]
    return vowels[-1] if vowels else (group[-1] if group else "AH1")


def _merge_bare_vowel_onsets(groups: List[List[str]]) -> List[List[str]]:
    """A non-final syllable that is a single BARE vowel (e.g. the 'a-' in a-gain) gives SoulX
    a consonant-less "uh" to sing, which it garbles. Borrow the NEXT syllable's leading
    consonant so every slot has substance ('a'|'gain' → 'ag'|'ain'). The next group keeps its
    vowel (only a leading consonant moves), so no group is emptied."""
    g = [list(x) for x in groups]
    for i in range(len(g) - 1):
        # only an UNSTRESSED bare vowel (schwa, stress digit 0) is the problem; a stressed
        # vowel (1/2) SoulX sings fine on its own.
        if len(g[i]) == 1 and g[i][0][-1:] == "0" and g[i + 1] and not g[i + 1][0][-1:].isdigit():
            g[i].append(g[i + 1].pop(0))
    return g


def _slot_phonemes(word: str, n_slots: int) -> List[str]:
    """Distribute a word's phones across its `n_slots` note slots so a multi-slot word
    PROGRESSES instead of re-articulating the whole word on every slot (the sung-render
    re-attack bug the owner heard: "down down", "gonna gonna").

    - n_slots >= syllables: one syllable's phones per slot, then the bare vowel HELD on the
      leftover slots (a sustained note, no re-attack).
    - n_slots  < syllables: the surplus syllables fold onto the LAST slot (nothing dropped).
    The first slot's phoneme carries the word's onset (note_type 2); continuations are the
    remaining syllables / the held vowel (note_type 3)."""
    phones = _pron().phones(_clean(word))
    if not phones:
        phones = ["AH1"] * max(1, _pron().syllables(_clean(word)) or 1)
    groups = _merge_bare_vowel_onsets(ph.syllabify_phones(phones) or [list(phones)])
    n_syl = len(groups)
    if n_slots >= n_syl:
        held = _held_vowel(groups[-1])
        per_slot = list(groups) + [[held]] * (n_slots - n_syl)
    else:
        per_slot = groups[:n_slots - 1] + [[p for g in groups[n_slots - 1:] for p in g]]
    return ["en_" + "-".join(str(p) for p in g) for g in per_slot]


def _display_and_phoneme(word: str):
    display = word
    syl = max(1, _pron().syllables(_clean(display)) or 1)
    return display, _phoneme(display, syl)


def _asserted_text(line: dict) -> str:
    text = str(line.get("text", "") or "").strip()
    if not line.get("asserted") or not text or "___" in text:
        return ""
    if not any(ch.isalnum() for ch in text):
        return ""
    return text


def _word_units(words: List[str], slots: List[dict]):
    """Allocate slots to words -> [(word, [slot, ...]), ...]. Words may never outnumber
    slots — the old "surplus words share the last slot" squeeze was removed (B2.1,
    2026-07-17): it crammed syllables no singer could articulate; author_score rejects
    the line upstream (`line_overflow`) instead of singing the bug."""
    n = len(slots)
    if len(words) > n:
        raise ValueError("words outnumber slots — author_score must reject this line")
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


def apply_note_floor(clip: dict, floor_s: float, stats: Optional[dict] = None) -> dict:
    """Raise every sub-`floor_s` SUNG note (note_type 2/3) to the floor — a HARD
    INVARIANT, not best-effort. The old i±1-neighbour borrow gave up SILENTLY when both
    neighbours were pinned while spare sat two tokens away — stage10 shipped an
    unsingable "and" at 0.1233 s in r9b, and a rest drained to a 0.0000 token survived.

    Two stages, looped to fixpoint:
      1. PHRASE-SCOPED BORROW — donors are every token in the contiguous run bounded by
         (and including) the nearest flanking rests: rests drain to zero first, then
         sung notes by (distance, largest spare), never below the floor themselves, and
         never across a rest (a breath bounds a phrase; timing outside the run never
         moves).
      2. MERGE FALLBACK — when the run's spare is exhausted, an unsingable note FOLDS
         into a neighbour instead of shipping: a type-3 continuation merges LEFT into
         its same-word predecessor; a type-2 onset merges RIGHT into its own
         continuation (the survivor becomes the type-2 onset); a single-note word folds
         into the nearest sung neighbour in the run (following preferred; text joined
         with '+', cosmetic — SoulX consumes only the phoneme stream). Phones re-join
         dash-wise; within a word the LONGER constituent's pitch wins (a 40 ms sliver's
         pitch is glide noise).

    Fully-drained rests (0.0000) are dropped. `stats` (optional dict) receives
    {"merged", "leaks", "impossible"}. Total timeline preserved; pure; floor_s <= 0
    returns the clip unchanged (byte-identical)."""
    if floor_s <= 0.0:
        return clip
    durs = [float(d) for d in clip["duration"].split()]
    types = [int(t) for t in clip["note_type"].split()]
    texts = clip["text"].split()
    phons = clip["phoneme"].split()
    pitches = clip["note_pitch"].split()
    skip = [False] * len(durs)
    eps = 1e-9
    merged = impossible = 0

    def run_bounds(i):
        a = i
        while a > 0 and types[a - 1] != 1:
            a -= 1
        if a > 0:
            a -= 1                                  # the flanking rest is a donor too
        b = i
        while b < len(durs) - 1 and types[b + 1] != 1:
            b += 1
        if b < len(durs) - 1:
            b += 1
        return a, b

    def try_borrow(i):
        need = floor_s - durs[i]
        a, b = run_bounds(i)
        donors = sorted((j for j in range(a, b + 1) if j != i),
                        key=lambda j: (0 if types[j] == 1 else 1, abs(j - i),
                                       -(durs[j] if types[j] == 1 else durs[j] - floor_s),
                                       j))
        for j in donors:
            spare = durs[j] if types[j] == 1 else max(0.0, durs[j] - floor_s)
            take = min(need, spare)
            if take <= eps:
                continue
            durs[j] -= take
            need -= take
            if need <= eps:
                break
        durs[i] = floor_s - max(0.0, need)
        return need <= eps

    def _join(left, right):
        return left + "-" + (right[3:] if right.startswith("en_") else right)

    def do_merge(i, j, cross_word):
        # fold token i INTO token j (j survives); pre-merge durations decide the pitch
        if not cross_word:
            pitches[j] = pitches[j] if durs[j] >= durs[i] else pitches[i]
        if i < j:
            phons[j] = _join(phons[i], phons[j])
            if cross_word:
                texts[j] = texts[i] + "+" + texts[j]
        else:
            phons[j] = _join(phons[j], phons[i])
            if cross_word:
                texts[j] = texts[j] + "+" + texts[i]
        if not cross_word and types[i] == 2:
            types[j] = 2                            # the survivor becomes the word onset
        durs[j] += durs[i]
        for arr in (durs, types, texts, phons, pitches, skip):
            del arr[i]

    guard = 0
    while guard < 4 * len(durs) + 8:
        guard += 1
        i = next((k for k in range(len(durs))
                  if types[k] != 1 and not skip[k] and durs[k] < floor_s - eps), None)
        if i is None:
            break
        if try_borrow(i):
            continue
        j = None
        if types[i] == 3 and i > 0 and types[i - 1] != 1 and texts[i - 1] == texts[i]:
            j, cross = i - 1, False
        elif types[i] == 2 and i + 1 < len(durs) and types[i + 1] == 3 \
                and texts[i + 1] == texts[i]:
            j, cross = i + 1, False
        else:
            a, b = run_bounds(i)
            sung = [k for k in range(a, b + 1) if k != i and types[k] != 1]
            after = [k for k in sung if k > i]
            before = [k for k in sung if k < i]
            if after:
                j, cross = min(after), True
            elif before:
                j, cross = max(before), True
        if j is None:
            impossible += 1
            skip[i] = True                          # a lone note in a too-small run
        else:
            do_merge(i, j, cross)
            merged += 1

    # drained rests are dead tokens — drop them rather than ship 0.0000 events
    k = 0
    while k < len(durs):
        if types[k] == 1 and durs[k] <= 5e-5:
            for arr in (durs, types, texts, phons, pitches, skip):
                del arr[k]
        else:
            k += 1

    # re-quantize on the error-diffused chain so summed timeline is bit-stable (as author_score)
    qdur, acc_true, acc_emit = [], 0.0, 0.0
    for d in durs:
        acc_true += d
        q = max(0.0, round(acc_true - acc_emit, 4))
        qdur.append(q)
        acc_emit += q
    leaks = sum(1 for q, t in zip(qdur, types) if t != 1 and q < floor_s - 2e-4)
    if stats is not None:
        stats.update({"merged": merged, "leaks": leaks, "impossible": impossible})
    out = dict(clip)
    out["duration"] = " ".join(f"{q:.4f}" for q in qdur)
    out["text"] = " ".join(texts)
    out["phoneme"] = " ".join(phons)
    out["note_pitch"] = " ".join(pitches)
    out["note_type"] = " ".join(str(t) for t in types)
    out["time"] = [clip["time"][0], clip["time"][0] + round(acc_emit * 1000)]
    return out


def author_score(lines: List[dict], language: str = "English", name: str = "mosh-sheet",
                 durations: str = "verbatim", note_floor_s: float = 0.0) -> dict:
    """[{text, score: lyricScore-blob|None}, ...] -> {"ok", "score": [clip], stats}.

    Lines without a score blob are SKIPPED and counted (typed-later lines have no take
    flow — never invent timing). Emits ONE clip covering the whole sheet on the take's
    own timeline (leading/inter-line gaps are <SP> rests), so the rendered WAV lands
    aligned with the source clip.

    durations: "verbatim" (default — slot durations transferred as-is, the shipped
    behavior) or "derived" (B1-lite: phrase anchors kept, in-phrase durations re-derived
    by soulx.duration's zero-sum rule layer; V2-blind-motivated, owner-ear-gated).

    note_floor_s: minimum sung-note duration (default 0.0 = off, byte-identical). SoulX's
    shipped English notes bottom out near 0.15 s; 15.8% of ours sat below that (mechanism V4a),
    too short to fit a consonant + vowel. A positive floor raises sub-floor sung notes by
    borrowing from an adjacent rest, then the longest neighbour — total timeline preserved."""
    if durations not in ("verbatim", "derived"):
        raise ValueError(f"unknown durations mode: {durations!r}")
    scored = [ln for ln in (lines or [])
              if isinstance(ln.get("score"), dict) and ln["score"].get("slots") and _asserted_text(ln)]
    if not scored:
        return {"ok": False, "error": "no_asserted_scored_lines",
                "linesUsed": 0, "linesSkipped": len(lines or [])}

    text_t, phon_t, pitch_t, type_t, dur_t = [], [], [], [], []
    cursor = 0.0
    n_words = n_rests = 0

    def emit(tok: str, phon: str, pitch: int, ntype: int, dur: float) -> None:
        text_t.append(tok); phon_t.append(phon)
        pitch_t.append(int(pitch)); type_t.append(int(ntype)); dur_t.append(max(0.0, dur))

    def emit_word(word: str, segs: List[dict]) -> None:
        nonlocal n_words
        display = "la" if word.strip("_") == "" else word
        slot_phons = _slot_phonemes(display, len(segs))
        for j, s in enumerate(segs):
            emit(display, slot_phons[j], int(s.get("pitch", 69)), 2 if j == 0 else 3,
                 float(s["end"]) - float(s["start"]))
        n_words += 1

    for ln in scored:
        slots = sorted(ln["score"]["slots"], key=lambda s: float(s.get("start", 0.0)))
        raw_words = [w for w in _asserted_text(ln).split() if w]
        words = raw_words or ["la"]
        if len(words) > len(slots):
            # B2.1: never cram — a count-exact upstream cannot produce this, so it is an
            # authoring bug to surface, not a texture to sing
            return {"ok": False, "error": "line_overflow",
                    "lineText": _asserted_text(ln),
                    "words": len(words), "slots": len(slots)}
        for unit_word, unit_slots in _word_units(words, slots):
            u_start = float(unit_slots[0]["start"])
            u_end = float(unit_slots[-1]["end"])
            gap = u_start - cursor
            if gap >= _REST_MIN_S:
                emit("<SP>", "<SP>", 0, 1, gap)
                n_rests += 1
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
    result = {"ok": True, "score": [clip], "durations": durations,
              "linesUsed": len(scored), "linesSkipped": len(lines) - len(scored),
              "events": len(dur_t), "words": n_words, "rests": n_rests,
              "duration_s": round(sum(dur_t), 3)}
    if durations == "derived":
        from soulx import duration as sxdur
        new_clip, dlog = sxdur.derive_clip(clip, sxdur.load_params())
        old = [float(d) for d in clip["duration"].split()]
        new = [float(d) for d in new_clip["duration"].split()]
        result["score"] = [new_clip]
        result["deriveChanged"] = sum(1 for a, b in zip(old, new) if abs(a - b) > 0.0005)
        result["deriveChainOk"] = bool(dlog.get("chain_check", {}).get("ok"))
    if note_floor_s > 0.0:
        # applied LAST so it floors whatever durations the derive step produced
        fstats: dict = {}
        floored = apply_note_floor(result["score"][0], note_floor_s, stats=fstats)
        pre = [float(d) for d in result["score"][0]["duration"].split()]
        post = [float(d) for d in floored["duration"].split()]
        result["score"] = [floored]
        result["noteFloorS"] = note_floor_s
        result["noteFloorRaised"] = sum(1 for a, b in zip(pre, post) if b - a > 0.0005)
        result["noteFloorMerged"] = fstats.get("merged", 0)
        result["noteFloorLeaks"] = fstats.get("leaks", 0)   # the invariant: must be 0
        if fstats.get("impossible"):
            result["noteFloorImpossible"] = fstats["impossible"]
    return result


# ── timing-snap inputs (Phase A consolidation) ─────────────────────────────────────────
# The product timing-snap (soulx.perform.snap_render_to_take) aligns a SoulX render onto
# the take. It needs the score's word events (the slot-snap unit) and phrase windows
# (the phrase-align unit) — derived from the SAME clip author_score emits. Both parse the
# take-aligned duration/note_type chain (the single-clip version of the spike's
# backhalf_perform.candidate_events / overlap.phrase_windows_from_score).

def word_event_spans(clip: dict) -> List[tuple]:
    """[(start_s, end_s), ...] — one span per word (note_type 2), its end extended through
    the word's continuation (type-3) run; type-1 rests close the current word. Times sum
    the 4dp error-diffused duration chain, so they land on the take's clock."""
    durs = [float(d) for d in clip["duration"].split()]
    types = [int(x) for x in clip["note_type"].split()]
    events, t, cur = [], 0.0, None
    for d, nt in zip(durs, types):
        if nt == 2:
            if cur:
                events.append(cur)
            cur = [round(t, 4), round(t + d, 4)]
        elif nt == 3 and cur:
            cur[1] = round(t + d, 4)
        elif nt == 1 and cur:
            events.append(cur)
            cur = None
        t += d
    if cur:
        events.append(cur)
    return [(a, b) for a, b in events]


def phrase_windows(clip: dict, rest_split_s: float = 0.35) -> List[tuple]:
    """[(start, end, n_word_events), ...] — sung phrases split at rests >= rest_split_s
    (a leading/sub-threshold rest never opens or splits a phrase)."""
    durs = [float(d) for d in clip["duration"].split()]
    types = [int(t) for t in clip["note_type"].split()]
    wins, t, cur = [], 0.0, None
    for d, nt in zip(durs, types):
        if nt == 1:
            if cur and d >= rest_split_s:
                wins.append(cur)
                cur = None
        else:
            if cur is None:
                cur = [t, t + d, 1 if nt == 2 else 0]
            else:
                cur[1] = t + d
                cur[2] += 1 if nt == 2 else 0
        t += d
    if cur:
        wins.append(cur)
    return [(round(a, 3), round(b, 3), n) for a, b, n in wins]
