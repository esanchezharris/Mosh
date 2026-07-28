#!/usr/bin/env python3
"""Per-item acceptable-substitute sets (FMS WS1 / M5c). Pure stdlib.

`exact` asks whether the arm reproduced the artist's word. That is a proxy, and
the owner's sitting 5 already showed the proxy has a wide margin of error in both
directions: the artist's real word read as keepable 86% of the time, so ~14% of
"correct" answers are not actually good, and plenty of non-exact fills are fine.

An accept-set records the owner's judgement directly: for a given item, which
OTHER words would he have kept. Score against it beside `exact` on every run, and
watch the gap — **exact climbing while accept-set stalls is the Goodhart alarm**,
the signature of an arm learning the benchmark rather than the craft.

Storage is an append-only JSONL log, one line per judgement, never rewritten.
Sets are materialized by replaying it, last verdict per (item, word) wins. That
is the same discipline as the program's decision ledger, and it means a sitting
can be interrupted, resumed, or revised without losing what came before.

Lives under `{data_root}` — a judgement names a corpus word, so it is
corpus-derived and never enters git.
"""
from __future__ import annotations

import json
import os
import time
from typing import Dict, List, Optional, Set

from lyrics.bench import paths
from lyrics.bench.metrics import normalize

ACCEPT_VERSION = "v1"


def log_path(slice_: str) -> str:
    return os.path.join(paths.subdir("accept_sets"), f"accept-{slice_}.jsonl")


def record(slice_: str, item_id: str, word: str, verdict: str, *,
           source: str = "cli", note: str = "") -> dict:
    """Append one judgement. `verdict` is "accept" or "reject"."""
    if verdict not in ("accept", "reject"):
        raise ValueError(f"verdict must be accept|reject, got {verdict!r}")
    row = {"v": ACCEPT_VERSION, "itemId": item_id, "word": normalize(word),
           "verdict": verdict, "source": source, "note": note,
           "ts": int(time.time())}
    with open(log_path(slice_), "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    return row


def load(slice_: str) -> Dict[str, Dict[str, Set[str]]]:
    """Replay the log into {itemId: {"accept": {...}, "reject": {...}}}.

    Last verdict per (item, word) wins, so a judgement can be revised by
    appending rather than by editing history.
    """
    out: Dict[str, Dict[str, Set[str]]] = {}
    path = log_path(slice_)
    if not os.path.exists(path):
        return out
    latest: Dict[tuple, str] = {}
    with open(path, encoding="utf-8") as f:
        for ln in f:
            if not ln.strip():
                continue
            try:
                r = json.loads(ln)
            except ValueError:
                continue          # a torn line is skipped, never fatal
            latest[(r["itemId"], r["word"])] = r["verdict"]
    for (item_id, word), verdict in latest.items():
        entry = out.setdefault(item_id, {"accept": set(), "reject": set()})
        entry["accept" if verdict == "accept" else "reject"].add(word)
    return out


def accept_score(item: dict, candidates: List[str],
                 sets: Dict[str, Dict[str, Set[str]]]) -> Optional[int]:
    """1 if the top candidate is the artist's word OR an owner-accepted substitute.

    Returns **None** when this item carries no judgement at all — an unlabelled
    item is not a failure, and counting it as 0 would make the metric look bad in
    exact proportion to how little labelling has happened.
    """
    if not candidates:
        return None
    entry = sets.get(item["itemId"])
    top = normalize(candidates[0])
    truth = normalize((item.get("target") or {}).get("text") or "")
    if top and top == truth:
        return 1
    if not entry:
        return None
    if top in entry["accept"]:
        return 1
    if top in entry["reject"]:
        return 0
    return None       # judged item, unjudged word: still no evidence


def annotate(rows: List[dict], items_by_id: Dict[str, dict],
             sets: Dict[str, Dict[str, Set[str]]]) -> List[dict]:
    for row in rows:
        item = items_by_id.get(row.get("itemId"))
        row["accept_fit"] = (accept_score(item, row.get("candidates") or [], sets)
                             if item else None)
    return rows


def summarize(rows: List[dict]) -> dict:
    """Accept-set score with its COVERAGE stated next to it.

    Coverage is not decoration: a 100% accept score over 3 judged items says
    nothing, and reporting the score without the denominator is how a number
    like that gets quoted later.
    """
    judged = [r for r in rows if r.get("accept_fit") is not None]
    exact = [r["exact"] for r in rows if r.get("exact") is not None]
    return {
        "version": ACCEPT_VERSION,
        "judgedItems": len(judged), "totalItems": len(rows),
        "coverage": (len(judged) / len(rows)) if rows else 0.0,
        "acceptFit": (sum(r["accept_fit"] for r in judged) / len(judged))
                     if judged else None,
        "exact": (sum(exact) / len(exact)) if exact else None,
    }


def goodhart_alarm(baseline: dict, candidate: dict, *,
                   exact_gain: float = 0.02, accept_slack: float = 0.0) -> dict:
    """Fire when `exact` climbs while accept-set does NOT.

    That is the shape of an arm getting better at reproducing the held-out token
    without getting better at writing — the failure the whole accept-set exists
    to make visible. Deliberately requires BOTH summaries to have real coverage;
    with nothing judged there is no alarm to raise, and saying so beats
    manufacturing one.
    """
    b_acc, c_acc = baseline.get("acceptFit"), candidate.get("acceptFit")
    b_ex, c_ex = baseline.get("exact"), candidate.get("exact")
    if None in (b_acc, c_acc, b_ex, c_ex):
        return {"status": "no-labels",
                "detail": "accept-set coverage is empty on one or both arms; "
                          "run `bench_cli.py accept mark` before reading a delta"}
    d_exact, d_accept = c_ex - b_ex, c_acc - b_acc
    fired = d_exact >= exact_gain and d_accept <= accept_slack
    return {"status": "ALARM" if fired else "ok",
            "deltaExact": round(d_exact, 4), "deltaAccept": round(d_accept, 4),
            "detail": ("exact rose while accept-set did not — the arm may be "
                       "learning the benchmark rather than the craft")
                      if fired else "exact and accept-set moved together"}
