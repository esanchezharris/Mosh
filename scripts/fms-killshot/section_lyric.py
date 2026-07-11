#!/usr/bin/env python3
"""Whole-section lyric author (FMS re-sing, stage ③ — the rebuilt heart).

The owner's verdict on the per-line rewriter: the new words "don't belong in my song."
Root cause — `service/lyrics/core.py` generates each gap line in ISOLATION (one prompt per
line), so a rewritten line never sees the rest of the song and comes out as filler. This
module fixes that at the shape level: ONE pass over the WHOLE section, so the model writes
the mumbled lines as part of one coherent lyric that fits the real lines' story, imagery and
vocabulary.

Contract (mirrors the real→fake posture of lyrics.core / stable_audio3):
  - `author_section(sheet, backend=None)` → the SAME sheet, deep-copied, with every gap line's
    `text` filled and its `origin` promoted (partial→mixed, mumble→generated) + a `written` flag.
    Locked / sung lines are returned verbatim (they anchor the story AND the rhymes).
  - LLM backend: build ONE whole-song prompt → parse → validate each written line with the
    phonology gate (syllables ±tol, end-rhyme vs its group anchor) → re-prompt with the SPECIFIC
    per-line failures (budgeted) → merge. Unreachable mid-call → fall back to the fake per line.
  - Fake backend (always available, deterministic): fills each gap with lyrics.core's proven
    per-line filler. The fake exercises the assembly/validate/merge plumbing; the whole-song
    COHERENCE is an LLM property the owner's ear gates (like SA3's real model), not a golden.

The deterministic pieces (prompt assembly, parse, validate, merge, the fake path) are golden-
tested in section_lyric_test.py; the LLM path is proven with a mocked brain_client (no network).

Pure stdlib + lyrics.core (validation) + brain_client (the LLM seam). Run under base python3.
"""
from __future__ import annotations

import copy
import json
import re
from typing import Dict, List, Optional

import brain_client
from lyrics import core as lyr


# ── which lines the section author writes vs keeps ─────────────────────────────────────

def _is_locked(line: dict) -> bool:
    """A line whose words are FIXED — his verbatim sung line. Kept verbatim; anchors rhymes."""
    return bool(line.get("locked")) or line.get("origin") == "sung"


def _needs_writing(line: dict) -> bool:
    """A gap line the section author must fill: not locked, and still fillable (has a gap /
    empty text). Reuses core._fillable so 'done' finalized lines are left alone."""
    return not _is_locked(line) and lyr._fillable(line)


def _seed_words(line: dict) -> List[str]:
    """The producer's kept (non-gap) seed words — must survive in the written line."""
    return [t["w"] for t in lyr._tokens(line.get("seedText", "")) if not t["gap"]]


# ── group rhyme anchors (the section-wide pre-scan, mirrors lyrics.core._run) ───────────

def _group_anchors(lines: List[dict]) -> Dict[str, str]:
    """Fixed end word per rhyme group (a locked / finalized line wins for its group), so a
    written line knows which real word it must rhyme with. Same logic the generator uses."""
    anchors: Dict[str, str] = {}
    for l in sorted(lines, key=lambda x: int(x.get("index", 0))):
        g, fe = l.get("rhymeGroup") or "", lyr._fixed_end_word(l)
        if g and fe and g not in anchors:
            anchors[g] = fe
    return anchors


# ── the real words already in the song (the whole-song CONTEXT that fixes 'filler') ─────

def _real_words(sheet: dict) -> str:
    """Everything the singer actually sang — locked line text + partial seed words (gaps
    dropped). Handed to the model so the gaps are written in the song's OWN world, not
    generic filler. This is the 'no song context' fix, made explicit in the prompt."""
    parts: List[str] = []
    for l in sorted(sheet.get("lines", []), key=lambda x: int(x.get("index", 0))):
        if _is_locked(l) and (l.get("text") or "").strip():
            parts.append(l["text"].strip())
        else:
            kept = _seed_words(l)
            if kept:
                parts.append(" ".join(kept))
    return " / ".join(parts)


# ── the ONE whole-song prompt ──────────────────────────────────────────────────────────

def _line_view(line: dict, sheet: dict) -> str:
    """One line of the song as the model sees it: KEEP verbatim, or WRITE/FILL to a budget."""
    i = line.get("index")
    g = line.get("rhymeGroup") or "-"
    if _is_locked(line):
        return f'{i}. [KEEP · {g}] "{(line.get("text") or "").strip()}"'
    target = lyr._target(line, sheet)
    seed = (line.get("seedText") or "").strip()
    if seed:
        return f'{i}. [FILL {target} syl · {g}] "{seed}"  (keep the written words, fill the ___)'
    return f'{i}. [WRITE {target} syl · {g}] ___'


def build_section_messages(sheet: dict, feedback: Optional[str] = None) -> List[dict]:
    """Assemble the single whole-song chat prompt. Deterministic (golden-tested)."""
    lines = sorted(sheet.get("lines", []), key=lambda l: int(l.get("index", 0)))
    body = "\n".join(_line_view(l, sheet) for l in lines)
    write_idx = [l.get("index") for l in lines if _needs_writing(l)]
    rules = [
        "This is a songwriter's rough take. [KEEP] lines are their REAL words — reproduce them "
        "exactly. [WRITE]/[FILL] lines are mumbled placeholders you must replace.",
        "Write the placeholder lines so the WHOLE song reads as ONE coherent lyric that fits the "
        "real lines' story, imagery and vocabulary — not generic filler.",
        "Each written line MUST hit its syllable count (the 'N syl' budget, ±1) and END on a word "
        "that rhymes (slant is fine) with the other lines sharing its rhyme group letter.",
        "For a [FILL] line, keep its written words in order and only fill the ___ gaps.",
        f"The singer's real words, for context (stay in this world): {_real_words(sheet) or '(none)'}.",
    ]
    if sheet.get("explicit") == "clean":
        rules.append("Keep it clean — no profanity.")
    else:
        rules.append("Authentic register: slang, ad-libs and explicit language are welcome — "
                     "don't self-censor.")
    sys_msg = ("You are finishing a rap/R&B songwriter's song from their rough take. "
               'Reply with ONLY a JSON object {"lines": [{"index": <int>, "text": "<line>"}, ...]} '
               f"containing exactly the lines to write (indices {write_idx}). No commentary.")
    usr = ("SONG:\n" + body + "\n\nRULES:\n- " + "\n- ".join(rules)
           + (f"\n\nYour previous attempt had problems — FIX exactly these: {feedback}" if feedback else ""))
    return [{"role": "system", "content": sys_msg}, {"role": "user", "content": usr}]


def parse_section(content: str) -> Dict[int, str]:
    """Pull {index: text} from an LLM reply (json_object), defensively — a stray shape
    (list, {lines:[...]}, {index,text}) still yields what it can, never raises."""
    out: Dict[int, str] = {}

    def _take(item) -> None:
        if isinstance(item, dict) and "index" in item:
            try:
                out[int(item["index"])] = str(item.get("text", "")).strip()
            except (ValueError, TypeError):
                pass

    try:
        obj = json.loads(content)
    except (json.JSONDecodeError, ValueError, TypeError):
        return out
    # {"lines": [...]} → the list; a bare index-keyed object {"1": "..."} → itself.
    seq = obj.get("lines") if isinstance(obj, dict) and "lines" in obj else obj
    if isinstance(seq, dict):                        # {"0": "text", ...}
        for k, v in seq.items():
            try:
                out[int(k)] = str(v).strip()
            except (ValueError, TypeError):
                pass
    elif isinstance(seq, list):
        for item in seq:
            _take(item)
    return out


# ── per-line validation (reuse the generator's gate so author == generator) ────────────

def _validate_line(text: str, line: dict, sheet: dict, anchor: Optional[str]) -> dict:
    target = lyr._target(line, sheet)
    tol = int(line.get("syllableTol", 1) or 1)
    strict = lyr._strictness(line, sheet)
    # anchor only binds when THIS line isn't itself the group's fixed anchor
    is_anchor = anchor is not None and lyr._fixed_end_word(line) == anchor
    return lyr._evaluate(text, line, sheet, None if is_anchor else anchor, target, tol, strict)


def _failure(d: dict, line: dict, sheet: dict, anchor: Optional[str]) -> Optional[str]:
    if d["passes"]:
        return None
    i = line.get("index")
    if not d["syllableOk"]:
        return f'line {i} "{d["text"]}" was {d["syllables"]} syllables, need {lyr._target(line, sheet)}'
    if not d.get("rhymeOk", True) and anchor:
        return f'line {i} must end on a word that rhymes with "{anchor}" (was "{d["endWord"]}")'
    if not d.get("lockedOk", True):
        return f'line {i} dropped a required word: {", ".join(_seed_words(line))}'
    return f'line {i} needs another try'


# ── the LLM path: one prompt → validate → re-prompt with the specific misses ────────────

def _llm_author(sheet: dict, max_rounds: int = 3) -> Optional[Dict[int, str]]:
    lines = sorted(sheet.get("lines", []), key=lambda l: int(l.get("index", 0)))
    anchors = _group_anchors(lines)
    by_index = {l.get("index"): l for l in lines}
    todo = [l.get("index") for l in lines if _needs_writing(l)]
    if not todo:
        return {}
    kept: Dict[int, str] = {}
    feedback: Optional[str] = None
    for _ in range(max_rounds):
        pending = [i for i in todo if i not in kept]
        if not pending:
            break
        resp = brain_client.chat_json(build_section_messages(sheet, feedback))
        if not resp.get("ok"):
            break
        got = parse_section(resp.get("content", ""))
        fails: List[str] = []
        # let a group's first written line, when the group had no fixed anchor, set the anchor
        for i in pending:
            if i not in got:
                fails.append(f"line {i} was missing from your reply")
                continue
            line = by_index[i]
            g = line.get("rhymeGroup") or ""
            anchor = anchors.get(g)
            d = _validate_line(got[i], line, sheet, anchor)
            if d["passes"]:
                kept[i] = d["text"]
                if g and g not in anchors:
                    anchors[g] = d["endWord"]
            else:
                fails.append(_failure(d, line, sheet, anchor) or f"line {i} needs another try")
        if not fails:
            break
        feedback = "; ".join(fails)
    return kept if kept else None


# ── the fake path: lyrics.core's per-line filler (deterministic, always available) ─────

def _fake_author(sheet: dict) -> Dict[int, str]:
    gen = lyr.complete(sheet, backend="fake")
    props = {l["index"]: (l.get("proposals") or []) for l in gen.get("lines", [])}
    return {i: p[0]["text"] for i, p in props.items() if p}


# ── orchestrator ───────────────────────────────────────────────────────────────────────

def _promote(origin: Optional[str]) -> str:
    return "mixed" if origin == "partial" else "generated"


def author_section(sheet: dict, backend: Optional[str] = None) -> dict:
    """Fill every gap line as part of ONE coherent section. Returns the deep-copied sheet
    with written lines' `text` set, `origin` promoted, and a `written` bool per filled line."""
    out = copy.deepcopy(sheet)
    chosen = backend or (("llm" if brain_client.available() else "fake"))
    written: Optional[Dict[int, str]] = None
    if chosen == "llm":
        written = _llm_author(out)
        if not written:                       # unreachable / empty → deterministic fallback
            chosen, written = "fake", _fake_author(out)
    else:
        written = _fake_author(out)
    # a line the LLM skipped is filled by the fake so the sheet is never left half-written
    fallback: Optional[Dict[int, str]] = None
    for l in out.get("lines", []):
        if not _needs_writing(l):
            continue
        i = l.get("index")
        text = (written or {}).get(i)
        if not text:
            if fallback is None:
                fallback = _fake_author(out)
            text = fallback.get(i) or ""
        if text:
            l["text"] = text
            l["origin"] = _promote(l.get("origin"))
            l["written"] = True
    n_written = sum(1 for l in out.get("lines", []) if l.get("written"))
    return {"ok": True, "backend": chosen, "sheet": out, "written": n_written}


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Author a whole-section coherent lyric from a sheet")
    ap.add_argument("sheet")
    ap.add_argument("out")
    ap.add_argument("--backend", default="", help="fake|llm (default auto)")
    a = ap.parse_args()
    sheet = json.load(open(a.sheet))
    res = author_section(sheet, backend=a.backend or None)
    json.dump(res["sheet"], open(a.out, "w"), indent=1)
    print(f"backend={res['backend']} wrote={res['written']} lines -> {a.out}")
    for l in res["sheet"].get("lines", []):
        tag = "WRITE" if l.get("written") else ("KEEP " if _is_locked(l) else "     ")
        print(f"  [{tag}] {l.get('index'):>2} ({l.get('syllableTarget')} syl "
              f"{l.get('rhymeGroup')}): {l.get('text') or l.get('seedText') or '(gap)'}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
