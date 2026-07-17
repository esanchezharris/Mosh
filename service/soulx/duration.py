#!/usr/bin/env python3
"""B1-lite duration derivation (FMS mechanism-verify Phase-V follow-up, stage-3).

The SoulX target score's per-note durations are, today, transferred VERBATIM from the
mumble take's energy slots (`score.py::author_score`). The registered V2 blind experiment
(docs/superpowers/specs/2026-07-16-fms-mechanism-verify-verdict.md) showed gold human
durations beat verbatim slots — the take is a good PHRASE-level spec but a bad per-syllable
one. B1-lite derives durations instead of transcribing them:

  - the take's PHRASE grid stays authoritative (phrase start/end times, big-rest positions
    are never touched — only rule 6 borrows from a phrase-initial rest, and only by an
    onset-consonant budget, never more);
  - inside a phrase, content lines up to STRESSED-SYLLABLE anchors (the take's nucleus
    positions), with onset consonants carved out of the vowel landing time (the V0/V4a
    finding: consonants budget INTO the prior interval, not after the vowel);
  - non-anchor (function-word / unstressed) content compresses, the phrase's final word
    lengthens, and hard floors keep every syllable singable.

Everything here is pure, stdlib-only, deterministic: given the same `notes` + `params` it
always returns the same output (no randomness, no dict-order dependence). It operates on
the SAME note-token shape `score.py`/`scripts/fms-killshot/oracle_duration.py` use:
    {"dur": float_seconds, "text": str, "phon": str, "pitch": int, "type": int}
type: 1 = rest (text/phon == "<SP>"), 2 = syllable onset, 3 = melisma continuation of the
previous type-2 note (identity comes from `type`, never from `phon` — a continuation's
phon may be a bare stressed vowel, e.g. "en_OW1").

Scope note: this module does NOT decide whether/when to call itself — that wiring (and
the `duration_params.json` fitting) is owned elsewhere. This file is the pure core only.
"""
from __future__ import annotations

import json
import os
import string
from typing import Dict, List, Optional, Tuple

Note = Dict[str, object]

# ── frozen params schema (defaults; `duration_params.json` next to this module, when
#    present, overrides via load_params()) ──────────────────────────────────────────────

DEFAULT_PARAMS: Dict[str, float] = {
    "version": 1,
    "consonant_ms": 50.0,
    "stress_ratio": 1.3,
    "function_compress": 0.75,
    "final_lengthen": 1.2,
    "floor_ms": 100.0,
    "floor_per_consonant_ms": 25.0,
    "rest_steal_max_ms": 120.0,
    "strength": 1.0,
}

FUNCTION_WORDS = frozenset(
    "a an the and or but nor so yet to of in on at by for with from as if than then "
    "that this these those i you he she it we they me him her us them my your his its "
    "our their am is are was were be been being do does did have has had will would "
    "can could shall should may might must not no oh uh la".split()
)

# ARPAbet vowel bases (a phone is a vowel iff its LAST char is a stress digit 0/1/2 —
# see phonology/core.py; this set is used only to find the onset/vowel boundary).
ARPA_VOWELS = frozenset({
    "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW",
})
# Report-only (not used to change behavior — see contract).
VOICELESS = frozenset({"S", "T", "K", "F", "P", "CH", "SH", "TH", "HH"})


def load_params(path: Optional[str] = None) -> Dict[str, float]:
    """DEFAULT_PARAMS merged with an optional JSON file (unknown keys + "provenance"
    ignored). path=None looks for duration_params.json next to this module."""
    params = dict(DEFAULT_PARAMS)
    if path is None:
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "duration_params.json")
        path = here if os.path.isfile(here) else None
    if path and os.path.isfile(path):
        with open(path) as f:
            data = json.load(f)
        for k in DEFAULT_PARAMS:
            if k in data:
                params[k] = data[k]
    return params


# ── phone helpers (mirror scripts/fms-killshot/vowel_landmark.py — ported, not
#    imported: service code must not import scripts/) ──────────────────────────────────

def phones_of(token: str) -> List[str]:
    """'en_T-AY1-M' -> ['T','AY1','M']; '<SP>'/'' -> []."""
    if not token or token == "<SP>":
        return []
    if token.startswith("en_"):
        token = token[3:]
    return [p for p in token.split("-") if p]


def _base(p: str) -> str:
    return p.rstrip("0123456789")


def onset_cluster(token: str) -> List[str]:
    """Leading consonant phones (digits stripped) before the first vowel of `token`'s
    onset syllable. '<SP>'/vowel-initial -> []."""
    cluster = []
    for p in phones_of(token):
        if _base(p) in ARPA_VOWELS:
            break
        cluster.append(_base(p))
    return cluster


def _has_primary_stress(phon_token: str) -> bool:
    return any(p and p[-1] == "1" for p in phones_of(phon_token))


def _clean_word(text: str) -> str:
    return text.lower().strip().rstrip(string.punctuation)


def _is_function_word(text: str) -> bool:
    return _clean_word(text) in FUNCTION_WORDS


# ── unit / phrase structure over a flat notes list ──────────────────────────────────────
# A UNIT = one type-2 note + its following contiguous type-3 run (oracle_duration.py's
# word_units semantics). Units are separated by type-1 rests.

def _word_units(notes: List[Note]) -> List[Dict]:
    units: List[Dict] = []
    cur: Optional[Dict] = None
    for i, n in enumerate(notes):
        t = int(n["type"])
        if t == 2:
            if cur is not None:
                units.append(cur)
            cur = {"idx": [i], "text": str(n.get("text", ""))}
        elif t == 3 and cur is not None:
            cur["idx"].append(i)
        elif t == 1 and cur is not None:
            units.append(cur)
            cur = None
    if cur is not None:
        units.append(cur)
    return units


def _verbatim_starts(notes: List[Note]) -> List[float]:
    starts, t = [], 0.0
    for n in notes:
        starts.append(t)
        t += float(n["dur"])
    return starts


def _rests_between(notes: List[Note], end_excl: int, start: int) -> Tuple[List[int], float]:
    """(rest_note_indices, total_dur) of every type-1 note strictly between two units
    (by note index). Normally 0 or 1 tokens; tolerated generically if more."""
    idxs = [i for i in range(end_excl, start) if int(notes[i]["type"]) == 1]
    total = sum(float(notes[i]["dur"]) for i in idxs)
    return idxs, total


def _apply_steal(notes: List[Note], derived: List[float], rest_idxs: List[int], steal: float) -> None:
    """Shrink rest(s) by exactly `steal` seconds, taking from the LAST rest index first."""
    remaining = steal
    for i in reversed(rest_idxs):
        if remaining <= 1e-12:
            break
        take = min(remaining, float(notes[i]["dur"]))
        derived[i] = float(notes[i]["dur"]) - take
        remaining -= take


def _group_phrases(notes: List[Note], units: List[Dict], rest_split_s: float) -> List[Dict]:
    """Maximal runs of units separated by rests >= rest_split_s; short rests stay inside a
    phrase. -> [{"unit_positions": [k,...], "pre_rest": (idxs, total)}, ...]."""
    if not units:
        return []
    first_start = units[0]["idx"][0]
    lead_idxs, lead_total = _rests_between(notes, 0, first_start)
    phrases: List[Dict] = []
    cur_positions = [0]
    pre_rest = (lead_idxs, lead_total)
    for k in range(len(units) - 1):
        end_excl = units[k]["idx"][-1] + 1
        start_i = units[k + 1]["idx"][0]
        ridxs, rtot = _rests_between(notes, end_excl, start_i)
        if rtot >= rest_split_s:
            phrases.append({"unit_positions": cur_positions, "pre_rest": pre_rest})
            cur_positions = []
            pre_rest = (ridxs, rtot)
        cur_positions.append(k + 1)
    phrases.append({"unit_positions": cur_positions, "pre_rest": pre_rest})
    return phrases


def _anchor_test(notes: List[Note], u: Dict) -> bool:
    """A unit is an anchor iff its type-2 phon has a stress-1 vowel AND its text is not a
    function word. (Also the 'stressed content' test for weight purposes, rule 3.)"""
    onset = notes[u["idx"][0]]
    if int(onset["type"]) != 2:
        return False
    if not _has_primary_stress(str(onset.get("phon", ""))):
        return False
    return not _is_function_word(u["text"])


def _note_floor(note: Note, params: Dict[str, float]) -> float:
    t = int(note["type"])
    if t == 1:
        return 0.0
    if t == 2:
        cluster = onset_cluster(str(note.get("phon", "")))
        return (params["floor_ms"] + params["floor_per_consonant_ms"] * len(cluster)) / 1000.0
    return params["floor_ms"] / 1000.0


def _unit_weight(notes: List[Note], u: Dict, last_unit: Dict, params: Dict[str, float]) -> float:
    w = float(len(u["idx"]))
    if _is_function_word(u["text"]):
        w *= params["function_compress"]
    if _anchor_test(notes, u):
        w *= params["stress_ratio"]
    if u is last_unit:
        w *= params["final_lengthen"]
    return w


def _close_segment(notes: List[Note], derived: List[float], participants: List[Dict],
                    left: float, right: float, rest_idxs: List[int], last_unit: Dict,
                    params: Dict[str, float]) -> bool:
    """Distribute [left, right) across `participants` (unit dicts); write per-note results
    into `derived` (mutated). Rests in `rest_idxs` keep their verbatim dur (subtracted from
    the distributable span). Returns False (infeasible -> caller reverts) iff the sum of
    per-note floors of `participants` exceeds the distributable span."""
    span = right - left
    rest_total = sum(float(notes[i]["dur"]) for i in rest_idxs)
    distributable = span - rest_total
    if not participants:
        return True
    all_idx = [i for u in participants for i in u["idx"]]
    floors = {i: _note_floor(notes[i], params) for i in all_idx}
    if sum(floors.values()) > distributable + 1e-6:
        return False
    weights = [_unit_weight(notes, u, last_unit, params) for u in participants]
    total_w = sum(weights)
    note_val: Dict[int, float] = {}
    if total_w <= 1e-12:
        share = distributable / len(all_idx)
        for i in all_idx:
            note_val[i] = share
    else:
        unit_alloc = {id(u): distributable * w / total_w for u, w in zip(participants, weights)}
        for u in participants:
            idxs = u["idx"]
            verb = [float(notes[i]["dur"]) for i in idxs]
            vsum = sum(verb)
            alloc = unit_alloc[id(u)]
            if vsum <= 1e-12:
                share = alloc / len(idxs)
                for i in idxs:
                    note_val[i] = share
            else:
                for i, v in zip(idxs, verb):
                    note_val[i] = alloc * (v / vsum)
    # rule 5: floor clamp + proportional redistribution among the segment's other notes
    for _ in range(len(all_idx) + 2):
        bad = [i for i in all_idx if note_val[i] < floors[i] - 1e-9]
        if not bad:
            break
        deficit = sum(floors[i] - note_val[i] for i in bad)
        for i in bad:
            note_val[i] = floors[i]
        pool_idx = [i for i in all_idx if i not in bad]
        pool_sum = sum(note_val[i] for i in pool_idx)
        if pool_sum <= 1e-9:
            return False
        for i in pool_idx:
            note_val[i] -= deficit * (note_val[i] / pool_sum)
    if any(note_val[i] < floors[i] - 1e-6 for i in all_idx):
        return False
    for i in all_idx:
        derived[i] = note_val[i]
    return True


def derive_note_durations(notes: List[Note], params: Dict[str, float],
                           rest_split_s: float = 0.35) -> Tuple[List[Note], Dict]:
    """[{dur,text,phon,pitch,type}, ...] -> (new_notes (same len/order/fields, new dur),
    log). See module contract in duration.py's docstring / the mechanism-verify plan for
    the full rule set (anchors, segments, floors, rest-steal, strength)."""
    p = dict(DEFAULT_PARAMS)
    p.update(params or {})
    verbatim = [float(n["dur"]) for n in notes]
    n = len(notes)
    derived = list(verbatim)
    log: Dict = {"rest_split_s": rest_split_s, "phrases": []}

    units = _word_units(notes)
    if not units:
        return [dict(nn) for nn in notes], log

    starts = _verbatim_starts(notes)

    def unit_start(u: Dict) -> float:
        return starts[u["idx"][0]]

    def unit_end(u: Dict) -> float:
        i = u["idx"][-1]
        return starts[i] + float(notes[i]["dur"])

    phrases = _group_phrases(notes, units, rest_split_s)
    steals: List[float] = []

    for ph in phrases:
        punits = [units[k] for k in ph["unit_positions"]]
        last_unit = punits[-1]          # final_lengthen is per-PHRASE (rule 3: "last unit of the phrase")
        pre_rest_idxs, pre_rest_total = ph["pre_rest"]
        phrase_start = unit_start(punits[0])
        phrase_end = unit_end(punits[-1])
        p_flags: List[Dict] = []
        u_log: List[Dict] = []

        u0 = punits[0]
        u0_anchor = _anchor_test(notes, u0)
        steal = 0.0
        if u0_anchor:
            onset0 = notes[u0["idx"][0]]
            cluster0 = onset_cluster(str(onset0.get("phon", "")))
            budget0 = p["consonant_ms"] / 1000.0 * len(cluster0)
            if budget0 > 0:
                if pre_rest_total >= rest_split_s:
                    steal = max(0.0, min(budget0, p["rest_steal_max_ms"] / 1000.0,
                                         pre_rest_total - 0.05))
                    if steal < budget0 - 1e-9:
                        p_flags.append({"flag": "onset_unbudgeted", "unit": u0["text"],
                                        "shortfall_ms": round((budget0 - steal) * 1000, 3)})
                else:
                    p_flags.append({"flag": "onset_unbudgeted", "unit": u0["text"],
                                    "shortfall_ms": round(budget0 * 1000, 3)})
                if steal > 0:
                    _apply_steal(notes, derived, pre_rest_idxs, steal)
            resolved0 = phrase_start - steal
            left_val = resolved0
            seg_participants = [u0]
            seg_rests: List[int] = []
            u_log.append({"unit": u0["text"], "role": "anchor", "phrase_initial": True,
                          "A": round(phrase_start, 4), "budget_full": round(budget0, 4),
                          "budget_applied": round(steal, 4),
                          "derived_start": round(resolved0, 4)})
            start_pos = 1
        else:
            left_val = phrase_start
            seg_participants = []
            seg_rests = []
            start_pos = 0
        steals.append(steal)

        for pos in range(start_pos, len(punits)):
            if pos > 0:
                end_excl = punits[pos - 1]["idx"][-1] + 1
                start_i = punits[pos]["idx"][0]
                ridxs, _rtot = _rests_between(notes, end_excl, start_i)
                seg_rests.extend(ridxs)
            u = punits[pos]
            is_cand = _anchor_test(notes, u)
            resolved = None
            budget_applied = 0.0
            budget_full = 0.0
            A = unit_start(u)
            dropped_budget = False
            if is_cand:
                onset = notes[u["idx"][0]]
                cluster = onset_cluster(str(onset.get("phon", "")))
                budget_full = p["consonant_ms"] / 1000.0 * len(cluster)
                target = A - budget_full
                if target >= left_val - 1e-9:
                    resolved = target
                    budget_applied = budget_full
                elif A >= left_val - 1e-9:
                    resolved = A
                    budget_applied = 0.0
                    dropped_budget = True
                # else: anchor dropped entirely (resolved stays None)

            if resolved is not None:
                ok = _close_segment(notes, derived, seg_participants, left_val, resolved,
                                    seg_rests, last_unit, p)
                if not ok:
                    for i in [ii for uu in seg_participants for ii in uu["idx"]]:
                        derived[i] = float(notes[i]["dur"])
                    p_flags.append({"flag": "segment_infeasible",
                                    "units": [uu["text"] for uu in seg_participants]})
                    if budget_applied > 0:
                        resolved = A
                        budget_applied = 0.0
                        dropped_budget = True
                        p_flags.append({"flag": "onset_unbudgeted", "unit": u["text"],
                                        "shortfall_ms": round(budget_full * 1000, 3),
                                        "reason": "segment_infeasible_revert"})
                u_log.append({"unit": u["text"], "role": "anchor", "phrase_initial": False,
                              "A": round(A, 4), "budget_full": round(budget_full, 4),
                              "budget_applied": round(budget_applied, 4),
                              "derived_start": round(resolved, 4),
                              "dropped_budget": dropped_budget, "segment_ok": ok})
                left_val = resolved
                seg_participants = [u]
                seg_rests = []
            else:
                if is_cand:
                    u_log.append({"unit": u["text"], "role": "anchor_dropped", "A": round(A, 4)})
                    p_flags.append({"flag": "anchor_dropped", "unit": u["text"]})
                seg_participants.append(u)

        ok = _close_segment(notes, derived, seg_participants, left_val, phrase_end,
                            seg_rests, last_unit, p)
        if not ok:
            for i in [ii for uu in seg_participants for ii in uu["idx"]]:
                derived[i] = float(notes[i]["dur"])
            p_flags.append({"flag": "segment_infeasible",
                            "units": [uu["text"] for uu in seg_participants], "final": True})

        log["phrases"].append({"start": round(phrase_start, 4), "end": round(phrase_end, 4),
                               "n_units": len(punits), "steal_s": round(steal, 4),
                               "flags": p_flags, "units": u_log})

    # rule 7: strength blend, then per-phrase exact-total re-enforcement (sung notes only)
    strength = float(p.get("strength", 1.0))
    final = [verbatim[i] + strength * (derived[i] - verbatim[i]) for i in range(n)]

    for idx, ph in enumerate(phrases):
        punits = [units[k] for k in ph["unit_positions"]]
        phrase_start = unit_start(punits[0])
        phrase_end = unit_end(punits[-1])
        sung_idx = [i for u in punits for i in u["idx"]]
        rest_idx: List[int] = []
        for k in range(len(punits) - 1):
            ridxs, _ = _rests_between(notes, punits[k]["idx"][-1] + 1, punits[k + 1]["idx"][0])
            rest_idx.extend(ridxs)
        steal_blended = strength * steals[idx]
        phrase_start_blended = phrase_start - steal_blended
        rest_sum_blended = sum(final[i] for i in rest_idx)
        target_sung = (phrase_end - phrase_start_blended) - rest_sum_blended
        cur_sung = sum(final[i] for i in sung_idx)
        scale = 1.0
        if cur_sung > 1e-9:
            scale = target_sung / cur_sung
            for i in sung_idx:
                final[i] *= scale
        log["phrases"][idx]["sung_scale"] = round(scale, 6)

    log["zero_sum_check"] = {"verbatim_total": round(sum(verbatim), 6),
                             "final_total": round(sum(final), 6),
                             "delta": round(sum(final) - sum(verbatim), 6)}

    new_notes = []
    for i, note in enumerate(notes):
        nn = dict(note)
        nn["dur"] = final[i]
        new_notes.append(nn)
    return new_notes, log


# ── clip-level wrapper (rule 8) ─────────────────────────────────────────────────────────

def _parse_clip_notes(clip: Dict) -> List[Note]:
    durs = [float(d) for d in clip["duration"].split()]
    texts = clip["text"].split()
    phons = clip["phoneme"].split()
    types = [int(x) for x in clip["note_type"].split()]
    pitches = [int(x) for x in clip["note_pitch"].split()]
    if not (len(durs) == len(texts) == len(phons) == len(types) == len(pitches)):
        raise ValueError("token streams disagree")
    return [{"dur": d, "text": tx, "phon": ph, "pitch": pt, "type": ty}
            for d, tx, ph, pt, ty in zip(durs, texts, phons, pitches, types)]


def derive_clip(clip: Dict, params: Dict[str, float],
                 rest_split_s: float = 0.35) -> Tuple[Dict, Dict]:
    """Parse a score clip's parallel strings -> derive -> re-emit with the SAME 4dp
    error-diffusion quantization as score.py::author_score (acc_true/acc_emit), so the
    emitted duration chain sums to clip['time']'s span within ~0.005s. All other fields
    (text/phoneme/note_pitch/note_type/time/index/language) are byte-identical."""
    notes = _parse_clip_notes(clip)
    new_notes, log = derive_note_durations(notes, params, rest_split_s)
    span = (float(clip["time"][1]) - float(clip["time"][0])) / 1000.0

    qdur, acc_true, acc_emit = [], 0.0, 0.0
    for nn in new_notes:
        acc_true += float(nn["dur"])
        q = max(0.0, round(acc_true - acc_emit, 4))
        qdur.append(q)
        acc_emit += q
    chain_sum = acc_emit
    log["chain_check"] = {"chain_sum": round(chain_sum, 4), "span": round(span, 4),
                          "ok": abs(chain_sum - span) <= 0.005}

    new_clip = dict(clip)
    new_clip["duration"] = " ".join(f"{q:.4f}" for q in qdur)
    return new_clip, log
