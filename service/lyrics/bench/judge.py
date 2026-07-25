"""Blind A/B judge panel (FMS lyrics-bench I2). Pure stdlib + an injected chat.

Protocol, and why each part exists:

  * **Blind A/B against the ground truth.** The judge sees the surrounding bars
    and two candidate fills — the model's and the human's — with no marker of
    which is which. Win-rate vs truth is the scale that survives across arms;
    "rate this 1-5" does not.
  * **Every pair judged twice, sides swapped.** LLM judges have a strong
    position prior. A judge that just picks a slot answers the same LETTER both
    times, which resolves to `inconsistent` (scored as a tie), while a judge
    with a real preference answers the same SIDE both times. This is the single
    cheapest debias available and it is not optional.
  * **The panel is prompt LENSES, not providers.** Only one provider is keyed on
    this machine (`brain_client.resolve()` picks one), so panel diversity comes
    from three deliberately different questions — meaning, craft, voice. Each
    lens keeps its own column so calibration can measure them separately, and
    inter-lens agreement is a real (if partial) reliability signal. When more
    provider keys exist, `lenses` can carry per-provider entries instead — the
    cache key already includes the provider/model the response came from.
  * **Errors and junk abstain.** A judge that cannot answer scores nothing; it
    never falls back to a coin flip that would look like a win.

Nothing here decides which metric to TRUST — that is calibration's job (I2's
owner sitting). This module only produces honest columns.
"""
from __future__ import annotations

import json
import re
from typing import Callable, Dict, List, Optional

# Three questions a good bar has to answer. Deliberately different lenses so the
# panel is not one opinion asked three times.
LENSES: Dict[str, str] = {
    "meaning": ("Which fill makes the better SENSE in this verse — does it "
                "follow what the surrounding bars are actually saying, and does "
                "it land an idea rather than filler?"),
    "craft": ("Which fill is the better piece of RAP CRAFT — rhyme quality "
              "(including multisyllabic and internal rhyme), rhythm against the "
              "bar, and word choice that a skilled writer would keep?"),
    "voice": ("Which fill sounds more like a REAL RECORDED RAP LYRIC in this "
              "artist's register — natural slang and cadence, not a polite or "
              "generic line written by a machine?"),
}

# Single words and short spans are decided by exact-match + phonology, which are
# free and exact; paying a panel to compare one word against another buys noise.
JUDGED_GRANULARITIES = ("span", "line")

_SYSTEM = ("You are judging two possible fills for a gap in a rap verse. "
           "Answer ONLY as JSON: {\"winner\": \"A\" | \"B\" | \"tie\", "
           "\"why\": \"<12 words>\"}. Explicit and slang language is normal "
           "here and must not count against a fill.")


def _completed(item: dict, fill: str) -> str:
    """The line as it would read with this fill — judges see whole bars, never
    a bare word, because a word out of its line cannot be judged for flow."""
    if item["granularity"] == "line":
        return fill
    from lyrics.bench.metrics import apply_fill
    return apply_fill(item, fill)


def _prompt(item: dict, first: str, second: str, lens_question: str) -> List[dict]:
    ctx = item["context"]
    lines = []
    if ctx["before"]:
        lines.append("Bars before:\n" + "\n".join(ctx["before"]))
    lines.append("Bars after:\n" + "\n".join(ctx["after"]) if ctx["after"] else "")
    body = "\n\n".join([x for x in lines if x])
    user = (f"{body}\n\nThe line in question, filled two different ways:\n"
            f"Fill A: {first}\nFill B: {second}\n\n{lens_question}")
    return [{"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user}]


def _parse_winner(resp: dict) -> Optional[str]:
    if not resp.get("ok"):
        return None
    content = resp.get("content") or ""
    data = None
    try:
        data = json.loads(content)
    except Exception:  # noqa: BLE001 — salvage JSON embedded in prose
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:  # noqa: BLE001
                data = None
    if not isinstance(data, dict):
        return None
    w = str(data.get("winner", "")).strip().lower()
    return w if w in ("a", "b", "tie") else None


def _ask(item: dict, cand_text: str, truth_text: str, lens_q: str,
         cand_first: bool, chat: Callable, cache) -> Optional[str]:
    first, second = ((cand_text, truth_text) if cand_first
                     else (truth_text, cand_text))
    messages = _prompt(item, first, second, lens_q)
    payload = {"judge": "blindAB", "v": 1, "messages": messages}

    def call():
        return chat(messages, max_tokens=200, temperature=0.0)

    resp = cache.cached_call(payload, call) if cache is not None else call()
    letter = _parse_winner(resp)
    if letter is None:
        return None
    if letter == "tie":
        return "tie"
    # Translate the LETTER the judge answered into the SIDE it chose.
    chose_first = letter == "a"
    return "candidate" if chose_first == cand_first else "truth"


def _lens_verdict(side_a: Optional[str], side_b: Optional[str]) -> str:
    """Fold the two order-swapped answers into one verdict.

    Same side twice = a real preference. Different sides = the judge followed
    the position, not the writing: `inconsistent`, worth nothing.
    """
    if side_a is None or side_b is None:
        return "abstain"
    if side_a == "tie" or side_b == "tie":
        return "tie" if side_a == side_b else "inconsistent"
    return side_a if side_a == side_b else "inconsistent"


def _majority(by_lens: Dict[str, dict]) -> Optional[int]:
    cand = sum(1 for v in by_lens.values() if v["verdict"] == "candidate")
    truth = sum(1 for v in by_lens.values() if v["verdict"] == "truth")
    if cand > truth:
        return 1
    if truth > cand:
        return 0
    return None


def judge_pair(item: dict, candidate_fill: str, *, chat: Callable, cache=None,
               lenses: Optional[Dict[str, str]] = None) -> dict:
    """Blind A/B the candidate against the held-out truth. Returns
    {win: 1|0|None, byLens: {lens: {verdict, orders}}} — win None means the
    panel did not separate them (tie, split, or abstained)."""
    lenses = lenses if lenses is not None else LENSES
    truth_text = _completed(item, item["target"]["text"])
    cand_text = _completed(item, candidate_fill)
    by_lens: Dict[str, dict] = {}
    for name, question in lenses.items():
        a = _ask(item, cand_text, truth_text, question, True, chat, cache)
        b = _ask(item, cand_text, truth_text, question, False, chat, cache)
        by_lens[name] = {"verdict": _lens_verdict(a, b),
                         "orders": [a or "none", b or "none"]}
    return {"win": _majority(by_lens), "byLens": by_lens}


def win_rate(rows: List[dict]) -> Optional[float]:
    """Share of separated pairs the candidate won (ties/abstains excluded, and
    their count is reported alongside so a thin sample is visible)."""
    wins = [r["win"] for r in rows if r.get("win") is not None]
    return (sum(wins) / len(wins)) if wins else None
