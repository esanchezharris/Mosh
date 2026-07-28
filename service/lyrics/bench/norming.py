#!/usr/bin/env python3
"""Norming packet: measure the HUMAN ceiling on our own items (FMS WS1 / M5d).

Every pre-registration in this program has been written against 64.7% — the
measured two-source pool ceiling from I3a. That number is a property of the
ARMS, not of the task: it says how often the artist's word sits in the union of
an LLM's top-5 and the phonology menu. It has never been checked against what a
person can do on the same items, so nobody knows whether 40% is bad or close to
the roof.

This emits a blind answer sheet — real items, full-song context, answers
withheld — so the owner and two raters can be scored on exactly the material the
arms are scored on. Whatever that measures REPLACES 64.7% in every future
pre-registration.

Two properties the packet must have or it measures nothing:

  * **Answers are withheld, in a separate file, never in the packet.** Obvious,
    and worth enforcing in code rather than in a habit — `export` writes them to
    a path it refuses to put inside the packet directory.
  * **The draw is seeded and deterministic.** Three raters must see the SAME
    items, and a re-export must reproduce the packet byte-for-byte, or the
    ratings cannot be pooled.

Section stratification (chorus vs verse) was specified as conditional. It is
skipped, with the reason recorded: the dev slice's rhyme items are 96% labelled
`verse` and 4% `other` — there is no chorus stratum to report.

Everything lives under `{data_root}`: the packet is full third-party lyric text.
"""
from __future__ import annotations

import json
import os
import re
from typing import Dict, List, Optional

from lyrics.bench import paths, sampling
from lyrics.bench.metrics import TOPK, normalize

NORMING_VERSION = "v1"

# Recorded rather than silently dropped — see the module docstring.
SECTION_STRATIFICATION = {
    "applied": False,
    "reason": "dev rhyme items are ~96% sectionKind='verse' and ~4% 'other'; "
              "there is no chorus stratum to report on this corpus",
}


def draw_items(items: List[dict], *, n: int = 200) -> List[dict]:
    """Deterministic, song-spread draw. Same corpus + same n ⇒ same packet."""
    return sampling.balanced(items, limit=int(n), key=lambda i: i["granularity"],
                             spread=lambda i: i["songId"], max_per_spread=3)


def _full_context(item: dict, song: Optional[dict]) -> Dict:
    """The masked line inside as much of its real section as the corpus has.

    A rhyme word is a decision made against a whole verse, not against the two
    bars the eval item carries. Scoring a human on less context than the writer
    had would understate the ceiling — the number this exists to measure.
    """
    masked = item["context"]["maskedLine"]
    if not song:
        before = list(item["context"].get("before") or [])
        after = list(item["context"].get("after") or [])
        return {"before": before, "maskedLine": masked, "after": after,
                "scope": "item-window"}
    si, li = item.get("si"), item.get("li")
    try:
        lines = [l for l in (song["sections"][si].get("lines") or []) if l.strip()]
    except (KeyError, IndexError, TypeError):
        return {"before": list(item["context"].get("before") or []),
                "maskedLine": masked, "after": list(item["context"].get("after") or []),
                "scope": "item-window"}
    return {"before": lines[:li], "maskedLine": masked, "after": lines[li + 1:],
            "scope": "full-section"}


def _end_word(line: str) -> str:
    """The bar's last word, normalized the SAME way candidates are.

    Not `re.findall(r"[A-Za-z']+")` — that pattern drops digits, so a bar ending
    on `9mm` or `24` yields the wrong token while `normalize` keeps the digits,
    and the two never match. Normalizing first and taking the last token keeps
    this comparable with everything else in the bench.
    """
    toks = normalize(line).split()
    return toks[-1] if toks else ""


def is_giveaway(answer: str, ctx: Dict) -> bool:
    """True when the answer is ALREADY VISIBLE as another shown line's end word.

    Full-section context is the right call — a writer sees their own verse — but
    rap repeats rhyme words, and on the first real 200-item export **10% of items**
    showed the answer at another line's end. A rater can simply copy it there, so
    those items measure copying rather than writing and would inflate the ceiling
    by up to ten points.

    The flag lives with the WITHHELD answers, never in the packet: telling the
    rater which ones are easy would be its own contamination. Scoring then reports
    the ceiling both ways.

    Note the deliberate narrowness: the answer appearing mid-line elsewhere (16%
    of items) is NOT flagged. That is the normal situation of writing inside your
    own verse, and excluding it would understate the ceiling.
    """
    a = normalize(answer)
    if not a:
        return False
    return any(_end_word(l) == a for l in (list(ctx.get("before") or [])
                                           + list(ctx.get("after") or [])))


def export(items: List[dict], songs_by_id: Dict[str, dict], *, out_dir: str,
           answers_path: str, n: int = 200, slice_: str = "dev") -> dict:
    """Write the blind packet + the withheld answer key.

    The answer key path is REFUSED if it resolves inside the packet directory:
    a rater handed the answers has measured nothing, and this is the one mistake
    that would silently invalidate the whole sitting.
    """
    out_dir = os.path.abspath(out_dir)
    answers_path = os.path.abspath(answers_path)
    if os.path.commonpath([answers_path, out_dir]) == out_dir:
        raise ValueError(
            f"refusing to write the answer key inside the packet directory "
            f"({answers_path}) — a rater who can see the answers measures nothing")
    os.makedirs(out_dir, exist_ok=True)

    drawn = draw_items(items, n=n)
    packet, answers = [], []
    for i, item in enumerate(drawn, start=1):
        ctx = _full_context(item, songs_by_id.get(item.get("songId")))
        packet.append({"no": i, "itemId": item["itemId"],
                       "syllables": (item.get("constraints") or {}).get("syllables"),
                       "rhymeWith": (item.get("constraints") or {}).get("rhymeWith"),
                       "sectionKind": item.get("sectionKind"), **ctx})
        ans = (item.get("target") or {}).get("text", "")
        answers.append({"no": i, "itemId": item["itemId"], "answer": ans,
                        "giveaway": is_giveaway(ans, ctx)})

    with open(os.path.join(out_dir, "packet.json"), "w", encoding="utf-8") as f:
        json.dump({"version": NORMING_VERSION, "slice": slice_, "n": len(packet),
                   "stratification": SECTION_STRATIFICATION, "items": packet},
                  f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "packet.txt"), "w", encoding="utf-8") as f:
        f.write(_render(packet))
    with open(os.path.join(out_dir, "ANSWER-SHEET.txt"), "w", encoding="utf-8") as f:
        f.write(_render_sheet(packet))
    with open(answers_path, "w", encoding="utf-8") as f:
        json.dump({"version": NORMING_VERSION, "slice": slice_,
                   "answers": answers}, f, ensure_ascii=False, indent=1)
    giveaways = sum(1 for a in answers if a["giveaway"])
    return {"ok": True, "n": len(packet), "packetDir": out_dir,
            "answersPath": answers_path,
            "stratification": SECTION_STRATIFICATION,
            "giveaways": giveaways,
            "giveawayRate": (giveaways / len(answers)) if answers else 0.0}


def _render(packet: List[dict]) -> str:
    out = [
        "NORMING PACKET — what would YOU have written?",
        "",
        "For each bar, the last word is missing. Write the word you think belongs",
        "there. You may give up to 5 guesses, best first, separated by commas.",
        "There is no trick: these are real bars from real songs, and the answer is",
        "whatever the artist actually wrote. Guess on instinct.",
        "",
        "Put your answers in ANSWER-SHEET.txt next to the matching number.",
        "=" * 72, "",
    ]
    for p in packet:
        out.append(f"--- {p['no']} ---")
        for line in p["before"]:
            out.append(f"    {line}")
        out.append(f"    {p['maskedLine']}      <-- fill the blank")
        for line in p["after"]:
            out.append(f"    {line}")
        hint = []
        if p.get("syllables"):
            hint.append(f"{p['syllables']} syllable(s)")
        if p.get("rhymeWith"):
            hint.append(f"rhymes with \"{p['rhymeWith']}\"")
        if hint:
            out.append(f"    [{'; '.join(hint)}]")
        out.append("")
    return "\n".join(out) + "\n"


def _render_sheet(packet: List[dict]) -> str:
    out = ["# One line per item: NUMBER = your guess(es), best first, comma-separated.",
           "# Example:   7 = money, honey", ""]
    out += [f"{p['no']} = " for p in packet]
    return "\n".join(out) + "\n"


def parse_sheet(text: str) -> Dict[int, List[str]]:
    """`7 = money, honey` -> {7: ["money", "honey"]}. Blank answers are dropped."""
    out: Dict[int, List[str]] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        left, right = line.split("=", 1)
        try:
            no = int(left.strip())
        except ValueError:
            continue
        guesses = [g.strip() for g in right.split(",") if g.strip()]
        if guesses:
            out[no] = guesses
    return out


def score(sheet: Dict[int, List[str]], answers: List[dict], *,
          rater: str = "") -> dict:
    """exact + top-5 for one rater, scored the SAME way the arms are.

    Uses `metrics.normalize` and `metrics.TOPK` rather than its own comparison,
    so the human ceiling and the arm scores are commensurable. A separate
    normalizer here would be the quiet way to make the two incomparable.
    """
    by_no = {a["no"]: normalize(a["answer"]) for a in answers}
    give = {a["no"]: bool(a.get("giveaway")) for a in answers}
    answered = exact = topk = 0
    cl_answered = cl_exact = cl_topk = 0
    for no, truth in by_no.items():
        guesses = [normalize(g) for g in sheet.get(no, [])]
        if not guesses:
            continue
        answered += 1
        hit1 = guesses[0] == truth
        hitk = truth in guesses[:TOPK]
        exact += hit1
        topk += hitk
        if not give.get(no):
            cl_answered += 1
            cl_exact += hit1
            cl_topk += hitk
    return {"rater": rater, "items": len(by_no), "answered": answered,
            # Scored over ANSWERED items, with `skipped` stated: a rater who
            # skips the hard ones would otherwise post a flattering ceiling.
            "skipped": len(by_no) - answered,
            "exact": (exact / answered) if answered else None,
            "topk": (topk / answered) if answered else None,
            "exactOfAll": (exact / len(by_no)) if by_no else None,
            "topkOfAll": (topk / len(by_no)) if by_no else None,
            # The honest ceiling: items whose answer was already on the page as
            # another line's end word measure copying, not writing.
            "giveawayItems": sum(1 for n in by_no if give.get(n)),
            "exactExGiveaway": (cl_exact / cl_answered) if cl_answered else None,
            "topkExGiveaway": (cl_topk / cl_answered) if cl_answered else None}


def pool(scores: List[dict]) -> dict:
    """The headline: the human ceiling, and the spread across raters.

    Reported as a RANGE as well as a mean — three raters who disagree wildly do
    not have a ceiling, they have a disagreement, and one number would hide it.
    """
    ok = [s for s in scores if s.get("exact") is not None]
    if not ok:
        return {"raters": 0, "ceiling": None}
    ex = [s["exactExGiveaway"] if s.get("exactExGiveaway") is not None
          else s["exact"] for s in ok]
    tk = [s["topk"] for s in ok if s.get("topk") is not None]
    return {"raters": len(ok),
            "exactMean": sum(ex) / len(ex), "exactMin": min(ex), "exactMax": max(ex),
            "topkMean": (sum(tk) / len(tk)) if tk else None,
            "spread": max(ex) - min(ex),
            "basis": "exact EXCLUDING give-away items (answer already visible as "
                     "another line's end word)",
            "replaces": "the 64.7% two-source pool ceiling used in prior "
                        "pre-registrations, which measured the ARMS and not the task"}
