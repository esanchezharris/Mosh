#!/usr/bin/env python3
"""Lyric generation loop (Finish-My-Song §6, L2) — propose → validate → retry → rank.

This is where "LLM + phonology" beats "LLM alone": a backend PROPOSES candidate lines
under the constraint spec (syllable target, rhyme group, locked words), the phonology
core VALIDATES each (syllables within tol, the rhyme group's end-words actually rhyme),
and the loop RANKS the survivors and returns top-N reviewable proposals.

L2 ships the FAKE backend: a deterministic, constraint-aware template filler that hits
the syllable target exactly and rhymes the group via the phonology dictionary — so the
whole loop, the UI, and the automatable quality FLOOR (the validator pass-rate) run with
zero LLM/venv. L3 swaps in a real LLM behind the same `propose` seam (service/brain_client),
degrading real→fake exactly like stable_audio3→fake. Stdlib + the phonology core only.
"""
from __future__ import annotations

import hashlib
import re
from typing import Dict, List, Optional

from phonology import core as phon

_P = phon.Pronouncer()  # real cmudict if importable, else a stdlib heuristic

# Deterministic filler vocab, indexed by syllable count, so any target is hit exactly.
_FILLER_1 = ["up", "down", "now", "back", "through", "on", "out", "high",
             "low", "cold", "hard", "fast", "gold", "real", "strong", "loud"]
_FILLER_2 = ["again", "tonight", "alone", "inside", "over", "under", "money",
             "power", "never", "rising", "burning", "focused"]
# End-word pools (1-syllable, for easy assembly) when a line has no rhyme anchor.
_DEFAULT_ENDS = ["flow", "grind", "game", "time", "night", "light", "fight",
                 "line", "mind", "crown", "throne", "gold", "cold", "real", "deal"]
_TOPIC_ENDS = {
    "night": ["night", "light", "fight", "sight", "right", "bright"],
    "comeback": ["flame", "name", "game", "claim", "frame", "blame", "aim"],
    "love": ["heart", "start", "apart", "art", "part"],
}


def syllables(text: str) -> int:
    """Syllable count over a line (per-word, dictionary then heuristic)."""
    if not isinstance(text, str):
        return 0
    return sum(_P.syllables(w) for w in re.findall(r"[A-Za-z']+", text))


def rhymes(a: str, b: str, strictness: str = "slant") -> bool:
    return _P.rhyme(a, b, strictness)


# ── deterministic seeded picks (no RNG → reproducible) ───────────────────────────

def _pick(seq: List[str], seed: str) -> Optional[str]:
    if not seq:
        return None
    idx = int(hashlib.sha1(seed.encode("utf-8")).hexdigest(), 16) % len(seq)
    return seq[idx]


def _filler_for(need: int, seed: str) -> List[str]:
    """Filler words summing to EXACTLY `need` syllables (2s then a 1 — any need≥1)."""
    out: List[str] = []
    i = 0
    rem = need
    while rem >= 2:
        out.append(_pick(_FILLER_2, f"{seed}|f2|{i}") or "again")
        rem -= 2
        i += 1
    if rem == 1:
        out.append(_pick(_FILLER_1, f"{seed}|f1|{i}") or "now")
    return out


# ── constraint spec helpers ──────────────────────────────────────────────────────

def _grid_per_bar(grid: str) -> int:
    return {"1/4": 4, "1/8": 8, "1/16": 16}.get(grid, 16)


def _target(line: dict, spec: dict) -> int:
    t = int(line.get("syllableTarget") or 0)
    return t if t > 0 else _grid_per_bar(spec.get("grid", "1/16"))


def _strictness(line: dict, spec: dict) -> str:
    return line.get("rhymeStrictness") or spec.get("rhymeStrictness") or "slant"


def _topic_ends(spec: dict) -> List[str]:
    return _TOPIC_ENDS.get(str(spec.get("topic", "")).lower(), _DEFAULT_ENDS)


def _has_gap(seed: str) -> bool:
    return bool(re.search(r"_{2,}", seed or ""))


def _tokens(seed: str):
    if not (seed or "").strip():
        return []
    return [{"w": t, "gap": bool(re.fullmatch(r"_{2,}", t))} for t in seed.split()]


def _fixed_end_word(line: dict) -> Optional[str]:
    """The producer's locked end word: the final text's last word, or the seed's last
    token when it's a word (not a gap). This anchors the rhyme group."""
    txt = (line.get("text") or "").strip()
    if txt:
        ws = re.findall(r"[A-Za-z']+", txt)
        return ws[-1] if ws else None
    toks = _tokens(line.get("seedText", ""))
    if toks and not toks[-1]["gap"]:
        return toks[-1]["w"]
    return None


def _fillable(line: dict) -> bool:
    txt = (line.get("text") or "").strip()
    if txt and not _has_gap(line.get("seedText", "")):
        return False   # finalized line with no gaps — it's done (still an anchor)
    return True


# ── assembly: build a line of `target` syllables, keeping the producer's words ────

def _assemble(seed_text: str, end_word: str, target: int, tol: int, seed: str) -> str:
    toks = _tokens(seed_text)
    own_end = (not toks) or toks[-1]["gap"]    # we APPEND the end word (trailing gap / fresh)
    if toks and toks[-1]["gap"]:
        toks = toks[:-1]
    words = [t["w"] for t in toks if not t["gap"]]

    # Insert filler at the first interior gap, else just before the end word.
    insert_at = None
    seen_words = 0
    for t in toks:
        if t["gap"]:
            insert_at = seen_words
            break
        seen_words += 1
    if insert_at is None:
        insert_at = len(words) if own_end else max(0, len(words) - 1)

    end_syl = _P.syllables(end_word) if own_end else 0
    base_syl = sum(_P.syllables(w) for w in words) + end_syl
    need = target - base_syl
    filler = _filler_for(need, seed) if need > 0 else []

    out = words[:insert_at] + filler + words[insert_at:]
    if own_end:
        out = out + [end_word]
    return " ".join(w for w in out if w)


# ── the loop: propose N → validate → rank → top-N ────────────────────────────────

def _propose_line(line: dict, spec: dict, anchor: Optional[str], regen: int) -> List[dict]:
    target = _target(line, spec)
    tol = int(line.get("syllableTol", 1) or 1)
    strict = _strictness(line, spec)
    fixed = _fixed_end_word(line)
    cands: List[dict] = []
    for v in range(3):
        seed = f"{line.get('index')}|{v}|{regen}|{spec.get('topic','')}|{spec.get('mood','')}"
        if fixed:
            end, must_rhyme = fixed, False
        elif anchor:
            ends = _P.rhyme_search(anchor, strict, max_n=40, syllables=1)
            end, must_rhyme = (_pick(ends, seed) if ends else _pick(_topic_ends(spec), seed)), True
        else:
            end, must_rhyme = _pick(_topic_ends(spec), seed), False
        text = _assemble(line.get("seedText", ""), end, target, tol, seed)
        nsyl = syllables(text)
        syl_ok = abs(nsyl - target) <= tol
        rhyme_ok = (not must_rhyme) or (anchor is not None and rhymes(end, anchor, strict))
        passes = syl_ok and rhyme_ok
        grade = ("anchor" if fixed else
                 (phon.rhyme_grade(_P.phones(end) or [], _P.phones(anchor) or []) if anchor else "free"))
        score = (2 if passes else 0) + (1 if rhyme_ok else 0) \
            + (1.0 - min(1.0, abs(nsyl - target) / max(1, target)))
        cands.append({"text": text, "endWord": end, "syllables": nsyl,
                      "syllableOk": syl_ok, "rhymeOk": rhyme_ok, "passes": passes,
                      "grade": grade, "score": round(score, 3)})
    # rank (best first), dedupe identical lines, keep stable for ties via index
    seen, uniq = set(), []
    for c in sorted(cands, key=lambda c: (-c["score"], c["text"])):
        if c["text"] in seen:
            continue
        seen.add(c["text"])
        uniq.append(c)
    return uniq


def _run(spec: dict, indices: Optional[List[int]] = None, regen: Optional[Dict[int, int]] = None) -> dict:
    regen = regen or {}
    by_index = sorted(spec.get("lines", []), key=lambda l: int(l.get("index", 0)))

    # Pre-scan FIXED rhyme anchors (a locked / finalized end word wins for its group).
    anchors: Dict[str, str] = {}
    for l in by_index:
        g, fe = l.get("rhymeGroup") or "", _fixed_end_word(l)
        if g and fe and g not in anchors:
            anchors[g] = fe

    out = []
    for l in by_index:
        if l.get("locked") or not _fillable(l):
            continue
        g = l.get("rhymeGroup") or ""
        anchor = anchors.get(g)
        is_anchor_line = anchor is not None and _fixed_end_word(l) == anchor
        props = _propose_line(l, spec, None if is_anchor_line else anchor, int(regen.get(l["index"], 0)))
        # A group with no fixed anchor takes the first generated line's end as its anchor.
        if g and g not in anchors and props:
            anchors[g] = props[0]["endWord"]
        if indices is None or l["index"] in indices:
            out.append({"index": l["index"], "proposals": props})
    return {"ok": True, "lines": out}


def complete(spec: dict, regen: Optional[Dict[int, int]] = None) -> dict:
    """Fill every gap in the sheet — proposals for all fillable, non-locked lines."""
    return _run(spec, indices=None, regen=regen)


def fill_gap(spec: dict, line_index: int, regen: Optional[Dict[int, int]] = None) -> dict:
    """Fill one bounded line — proposals for just `line_index`."""
    return _run(spec, indices=[int(line_index)], regen=regen)


def suggest_next_line(spec: dict, after_index: int, regen: Optional[Dict[int, int]] = None) -> dict:
    """Single-bar ghost suggestion — proposals for the line after `after_index`."""
    return _run(spec, indices=[int(after_index) + 1], regen=regen)
