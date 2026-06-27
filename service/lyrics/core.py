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
import json
import re
from typing import Dict, List, Optional

import brain_client
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


# ── the loop: propose N → validate(phonology) → retry/repair → rank → top-N ──────

def _evaluate(text: str, line: dict, spec: dict, anchor: Optional[str],
              target: int, tol: int, strict: str) -> dict:
    """Validate one candidate line against the constraints — the shared gate both the
    fake and the LLM backend feed into. The end word is read from the text."""
    fixed = _fixed_end_word(line)
    words = re.findall(r"[A-Za-z']+", text)
    end = words[-1] if words else ""
    nsyl = syllables(text)
    syl_ok = abs(nsyl - target) <= tol
    must_rhyme = anchor is not None and fixed is None
    rhyme_ok = (not must_rhyme) or (anchor is not None and rhymes(end, anchor, strict))
    # Locked words: the producer's non-gap seed words must survive in the candidate.
    seed_words = [t["w"] for t in _tokens(line.get("seedText", "")) if not t["gap"]]
    locked_ok = all(w.lower() in text.lower() for w in seed_words)
    passes = syl_ok and rhyme_ok and locked_ok
    grade = ("anchor" if fixed else
             (phon.rhyme_grade(_P.phones(end) or [], _P.phones(anchor) or []) if anchor else "free"))
    score = (2 if passes else 0) + (1 if rhyme_ok else 0) + (1 if locked_ok else 0) \
        + (1.0 - min(1.0, abs(nsyl - target) / max(1, target)))
    return {"text": text, "endWord": end, "syllables": nsyl, "syllableOk": syl_ok,
            "rhymeOk": rhyme_ok, "lockedOk": locked_ok, "passes": passes,
            "grade": grade, "score": round(score, 3)}


def _rank(cands: List[dict], n: int = 3) -> List[dict]:
    seen, uniq = set(), []
    for c in sorted(cands, key=lambda c: (-c["score"], c["text"])):
        if c["text"] in seen:
            continue
        seen.add(c["text"])
        uniq.append(c)
    return uniq[:n]


def _fake_propose_line(line: dict, spec: dict, anchor: Optional[str], regen: int) -> List[dict]:
    """The deterministic, constraint-aware template backend (always available)."""
    target, tol, strict = _target(line, spec), int(line.get("syllableTol", 1) or 1), _strictness(line, spec)
    fixed = _fixed_end_word(line)
    cands: List[dict] = []
    for v in range(3):
        seed = f"{line.get('index')}|{v}|{regen}|{spec.get('topic','')}|{spec.get('mood','')}"
        if fixed:
            end = fixed
        elif anchor:
            ends = _P.rhyme_search(anchor, strict, max_n=40, syllables=1)
            end = _pick(ends, seed) if ends else _pick(_topic_ends(spec), seed)
        else:
            end = _pick(_topic_ends(spec), seed)
        cands.append(_evaluate(_assemble(line.get("seedText", ""), end, target, tol, seed),
                               line, spec, anchor, target, tol, strict))
    return _rank(cands)


# ── the LLM backend (L3): prompt → validate → re-prompt with the SPECIFIC failure ──

def _build_messages(line: dict, spec: dict, anchor: Optional[str], target: int,
                    tol: int, strict: str, feedback: Optional[str]) -> List[dict]:
    fixed = _fixed_end_word(line)
    seed_words = [t["w"] for t in _tokens(line.get("seedText", "")) if not t["gap"]]
    rules = [f"Write {3} candidate {line.get('role', 'verse')} lines.",
             f"Each line MUST be ~{target} syllables (±{tol}).",
             "Keep these words, in order: " + (", ".join(seed_words) if seed_words else "(none)") + ".",
             f"Fill the gaps (___) in: \"{line.get('seedText', '') or '(write from scratch)'}\"."]
    if fixed:
        rules.append(f"The line must END on the word \"{fixed}\".")
    elif anchor:
        rules.append(f"The line must END on a word that is a {strict} rhyme with \"{anchor}\".")
    if spec.get("topic"):
        rules.append(f"Topic: {spec['topic']}.")
    if spec.get("mood"):
        rules.append(f"Mood: {spec['mood']}.")
    if spec.get("explicit") == "clean":
        rules.append("Keep it clean — no profanity.")
    sys = ("You are a skilled rap lyricist. Reply with ONLY a JSON object "
           '{"lines": ["...", "...", "..."]} of candidate lines. No commentary.')
    usr = " ".join(rules) + (f" Your previous attempt failed: {feedback} Fix it." if feedback else "")
    return [{"role": "system", "content": sys}, {"role": "user", "content": usr}]


def _parse_lines(content: str) -> List[str]:
    """Pull candidate line strings from an LLM reply (json_object), defensively."""
    out: List[str] = []
    try:
        obj = json.loads(content)
        if isinstance(obj, dict):
            v = obj.get("lines", obj.get("line"))
            if isinstance(v, list):
                out = [str(x) for x in v]
            elif isinstance(v, str):
                out = [v]
        elif isinstance(obj, list):
            out = [str(x) for x in obj]
    except (json.JSONDecodeError, ValueError, TypeError):
        out = [ln.strip(" -\t") for ln in content.splitlines()]
    return [s.strip() for s in out if s and s.strip()]


def _failure_reason(d: dict, target: int, tol: int, anchor: Optional[str], strict: str) -> str:
    if not d["syllableOk"]:
        return f"\"{d['text']}\" was {d['syllables']} syllables, need {target}±{tol}."
    if not d.get("rhymeOk", True) and anchor:
        return f"the last word \"{d['endWord']}\" must be a {strict} rhyme with \"{anchor}\"."
    if not d.get("lockedOk", True):
        return "you dropped one of the required words."
    return "try again."


def _llm_propose_line(line: dict, spec: dict, anchor: Optional[str], regen: int) -> List[dict]:
    target, tol, strict = _target(line, spec), int(line.get("syllableTol", 1) or 1), _strictness(line, spec)
    cands: List[dict] = []
    feedback: Optional[str] = None
    for _ in range(3):  # budget the retries (re-prompt with the specific phonology failure)
        resp = brain_client.chat_json(_build_messages(line, spec, anchor, target, tol, strict, feedback))
        if not resp.get("ok"):
            break
        fresh = [_evaluate(tx, line, spec, anchor, target, tol, strict)
                 for tx in _parse_lines(resp.get("content", ""))]
        cands.extend(fresh)
        if sum(1 for c in cands if c["passes"]) >= 2:
            break
        fails = [c for c in fresh if not c["passes"]]
        if not fresh or not fails:
            break
        feedback = _failure_reason(fails[0], target, tol, anchor, strict)
    if not cands:   # LLM/service unreachable mid-call → fall back to the fake for this line
        return _fake_propose_line(line, spec, anchor, regen)
    return _rank(cands)


def _auto_backend() -> str:
    """Real LLM when a brain provider is configured (and not force-disabled), else fake
    — the same real→fake posture as stable_audio3 → FakeAdapter."""
    try:
        return "llm" if brain_client.available() else "fake"
    except Exception:  # noqa: BLE001
        return "fake"


def _propose_line(line: dict, spec: dict, anchor: Optional[str], regen: int, backend: str) -> List[dict]:
    if backend == "llm":
        return _llm_propose_line(line, spec, anchor, regen)
    return _fake_propose_line(line, spec, anchor, regen)


def _run(spec: dict, indices: Optional[List[int]] = None,
         regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    regen = regen or {}
    backend = backend or _auto_backend()
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
        props = _propose_line(l, spec, None if is_anchor_line else anchor,
                              int(regen.get(l["index"], 0)), backend)
        # A group with no fixed anchor takes the first generated line's end as its anchor.
        if g and g not in anchors and props:
            anchors[g] = props[0]["endWord"]
        if indices is None or l["index"] in indices:
            out.append({"index": l["index"], "proposals": props})
    return {"ok": True, "backend": backend, "lines": out}


def complete(spec: dict, regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    """Fill every gap in the sheet — proposals for all fillable, non-locked lines."""
    return _run(spec, indices=None, regen=regen, backend=backend)


def fill_gap(spec: dict, line_index: int, regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    """Fill one bounded line — proposals for just `line_index`."""
    return _run(spec, indices=[int(line_index)], regen=regen, backend=backend)


def suggest_next_line(spec: dict, after_index: int, regen: Optional[Dict[int, int]] = None, backend: Optional[str] = None) -> dict:
    """Single-bar ghost suggestion — proposals for the line after `after_index`."""
    return _run(spec, indices=[int(after_index) + 1], regen=regen, backend=backend)
