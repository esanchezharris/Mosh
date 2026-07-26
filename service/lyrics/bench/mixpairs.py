"""Mixed calibration pairs + full-stanza context (FMS lyrics-bench I2b).

Sitting 1 produced labels that were 94% "the human bar is better". With a
distribution that one-sided, a column that answers "human" forever scores 0.96
and no judge can be distinguished from it — the sitting cost 45 minutes and
could not, even in principle, elect a metric.

So the redo mints two kinds of pair:

  * **vs_truth** — machine fill against the real recorded bar. The ceiling
    check: it says how far the arms are from human writing.
  * **vs_arm** — one arm's fill against the other's on the SAME gap. Balanced by
    construction (neither side is systematically better), and it is exactly the
    question promotion asks: which arm do you prefer?

Both normalize to ONE binary label — 1 = "the canonical option won" — so the
agreement statistics in `calibrate` apply unchanged. For vs_truth the canonical
option is the machine fill; for vs_arm it is the alphabetically-first arm, which
is stable across the sitting and independent of which side got rendered left.

Context is the whole stanza around the gap — and, since I2c, the SONG IDENTITY
too. Sitting 3 stopped mid-way because flow is not judgeable on a page: syllable
counts are not cadence, and the owner has to be able to pull the track up. The
deciding argument is that blinding is unenforceable anyway — he would hear the
real bar the moment he pressed play — so the honest design is to show identity
and record it, rather than collect a silent mix of blinded and accidentally
un-blinded labels.

Two things stay blind regardless:
  * **Provenance.** Which fill is the human's is never in the page. He may infer
    it by ear on tracks he plays (recorded as `heard`), but a page that LABELLED
    it would contaminate the pairs he did not play.
  * **A control stratum.** `blind_frac` of pairs keep identity hidden, so the
    report can tell "the judges are bad" apart from "we moved the ruler".
"""
from __future__ import annotations

import hashlib
import random
import urllib.parse
from typing import Dict, List, Optional, Sequence, Tuple


def _parse_item(item_id: str) -> Optional[Tuple[str, int, int]]:
    """(songId, sectionIndex, lineIndex) from an itemId, or None if unparseable."""
    parts = item_id.split(":")
    try:
        return (parts[2] + ":" + parts[3], int(parts[4].lstrip("s")),
                int(parts[5].lstrip("l")))
    except (IndexError, ValueError):
        return None


def listen_url(artist: str, title: str) -> str:
    """A search link, not a stored URL — the corpus records no streaming id, and
    a search reaches the track on whatever service the rater actually uses."""
    q = urllib.parse.quote_plus(f"{artist} {title}".strip())
    return f"https://www.youtube.com/results?search_query={q}"


def identity_of(item_id: str, songs: Optional[Dict[str, dict]]) -> Optional[dict]:
    """Artist / title / year / section label for the gap's song. None when the
    song is unknown — an unknown song is shown as a control, never as a guess."""
    parsed = _parse_item(item_id)
    if not songs or not parsed:
        return None
    song_id, si, _ = parsed
    song = songs.get(song_id)
    if not song:
        return None
    sections = song.get("sections") or []
    section = ""
    if si < len(sections):
        section = sections[si].get("label") or sections[si].get("kind") or ""
    artist, title = song.get("artist") or "", song.get("title") or ""
    return {"artist": artist, "title": title, "year": song.get("year"),
            "section": section, "listenUrl": listen_url(artist, title)}


def stanza_context(item_id: str, songs: Dict[str, dict], radius: int = 99) -> dict:
    """Every other line of the gap's own section, split before/after.

    Bounded by the SECTION, not the song: bars from the next verse are not this
    verse's flow. An unknown song degrades to empty context.
    """
    parts = item_id.split(":")
    try:
        song_id = parts[2] + ":" + parts[3]
        si = int(parts[4].lstrip("s"))
        li = int(parts[5].lstrip("l"))
    except (IndexError, ValueError):
        return {"before": [], "after": []}
    song = songs.get(song_id)
    if not song:
        return {"before": [], "after": []}
    sections = song.get("sections") or []
    if si >= len(sections):
        return {"before": [], "after": []}
    lines = sections[si].get("lines") or []
    return {"before": lines[max(0, li - radius):li],
            "after": lines[li + 1:li + 1 + radius]}


_POOL_METRICS = ("exact", "topk", "rhyme_fit", "rhyme_perfect", "multi_depth",
                 "syl_fit", "constrained_fit")


def pool_from_runs(rows_by_arm: Dict[str, Sequence[dict]],
                   items: Dict[str, dict]) -> List[dict]:
    """A calibration pool built straight from arm run results.

    The judged-file path exists to carry LLM-panel columns. When the question is
    "which of these two arms reads better", the panel adds nothing and paying for
    it would be waste — so the pool comes from the runs themselves, joined to the
    eval items for the truth and the masked line.

    An arm that produced no candidate for an item is skipped rather than entered
    with a blank: a pair rendered against an empty fill would ask the rater to
    judge nothing.
    """
    out: List[dict] = []
    for arm in sorted(rows_by_arm):
        for row in rows_by_arm[arm]:
            item = items.get(row.get("itemId"))
            cands = row.get("candidates") or []
            if not item or not cands or not cands[0]:
                continue
            ctx = item.get("context") or {}
            out.append({
                "itemId": row["itemId"], "arm": arm,
                "granularity": row.get("granularity") or item.get("granularity"),
                "truth": (item.get("target") or {}).get("text", ""),
                "candidate": cands[0],
                "maskedLine": ctx.get("maskedLine"),
                "context": {"before": list(ctx.get("before") or []),
                            "after": list(ctx.get("after") or [])},
                "views": row.get("views", item.get("views", 0)),
                "metrics": {k: row.get(k) for k in _POOL_METRICS if k in row},
            })
    return out


def rank_by_disagreement(item_ids: Sequence[str],
                         columns: Dict[str, Dict[str, Optional[int]]]) -> List[str]:
    """Items ordered by how much the metric columns disagree about them.

    Measured on sitting 2's mint: 54% of pairs had every column agreeing, so the
    owner's label there only re-confirmed the base rate. A label is only worth a
    rater's time if it can separate one judge from another — which requires the
    judges to have said different things. Ties break on itemId for stability.
    """
    scored = []
    for item in item_ids:
        vals = [c.get(item) for c in columns.values()]
        live = [v for v in vals if v is not None]
        if len(live) < 2:
            spread = 0.0
        else:
            ones = sum(1 for v in live if v)
            spread = min(ones, len(live) - ones) / (len(live) / 2)
        scored.append((-spread, item))
    scored.sort()
    return [i for _, i in scored]


def _pair_id(seed: int, kind: str, item_id: str, tag: str) -> str:
    return hashlib.sha256(
        f"{seed}|{kind}|{item_id}|{tag}".encode("utf-8")).hexdigest()[:16]


def mint_mixed(pool: Sequence[dict], *, n: int, dupes: int = 0, seed: int = 0,
               arm_frac: float = 0.5,
               songs: Optional[Dict[str, dict]] = None,
               radius: int = 99,
               columns: Optional[Dict[str, Dict[str, Optional[int]]]] = None,
               anchor_frac: float = 0.25,
               blind_frac: float = 0.0) -> Tuple[List[dict], Dict[str, dict]]:
    """Mint `n` blind pairs, `arm_frac` of them arm-vs-arm.

    `pool` rows are per (item, arm) with `truth`, `candidate` and `metrics`.
    Items carrying two or more arms are eligible for vs_arm pairs.
    """
    rng = random.Random(seed)
    by_item: Dict[str, List[dict]] = {}
    for row in pool:
        by_item.setdefault(row["itemId"], []).append(row)
    for rows in by_item.values():
        rows.sort(key=lambda r: r["arm"])

    # Deal across items in hashed order — never id order, which tracks era.
    items = sorted(by_item, key=lambda i: hashlib.blake2b(
        i.encode("utf-8"), digest_size=8).digest())

    want_total = max(0, n - dupes) if dupes else n
    strata: List[Tuple[str, List[str], int]] = [("random", items, want_total)]
    if columns:
        # Most of the budget buys discrimination; an ANCHOR stratum stays
        # randomly drawn, because accuracy measured only on disagreement pairs
        # is a biased estimate of accuracy on the population.
        n_anchor = max(1, int(round(want_total * anchor_frac)))
        anchors = items[:n_anchor]
        ordered = rank_by_disagreement([i for i in items if i not in set(anchors)],
                                       columns)
        strata = [("anchor", anchors, n_anchor),
                  ("disagreement", ordered, want_total - n_anchor)]

    # Split each stratum into the two kinds SEPARATELY. Allocating vs_arm from
    # the front of one combined list consumed the whole anchor stratum, leaving
    # the ceiling ("how often is the real bar itself a keep?") with zero
    # unbiased samples — measured on the first I2c mint: 0 anchor vs_truth pairs.
    selection: Dict[str, str] = {}
    arm_ids: List[str] = []
    truth_ids: List[str] = []
    for name, pool_ids, want in strata:
        take = pool_ids[:max(0, want)]
        for i in take:
            selection[i] = name
        multi = [i for i in take if len(by_item[i]) >= 2]
        n_arm = min(int(round(len(take) * arm_frac)), len(multi))
        chosen_arm = multi[:n_arm]
        arm_ids += chosen_arm
        truth_ids += [i for i in take if i not in set(chosen_arm)]

    pairs: List[dict] = []
    key: Dict[str, dict] = {}

    def ctx_for(item_id: str, row: dict) -> dict:
        if songs:
            c = stanza_context(item_id, songs, radius=radius)
            if c["before"] or c["after"]:
                return c
        return {"before": list((row.get("context") or {}).get("before") or []),
                "after": list((row.get("context") or {}).get("after") or [])}

    def emit(pair_id: str, item_id: str, gran: str, left: str, right: str,
             row: dict, entry: dict) -> None:
        c = ctx_for(item_id, row)
        pairs.append({"pairId": pair_id, "granularity": gran,
                      "arm": entry.get("arm") or entry.get("optionArm", ""),
                      "before": c["before"], "after": c["after"],
                      "left": left, "right": right})
        key[pair_id] = entry

    for item_id in arm_ids:
        rows = by_item[item_id]
        a, b = rows[0], rows[1]
        left_is_a = rng.random() < 0.5
        left_row, right_row = (a, b) if left_is_a else (b, a)
        pid = _pair_id(seed, "vs_arm", item_id, f"{a['arm']}|{b['arm']}")
        emit(pid, item_id, a["granularity"],
             _completed(left_row), _completed(right_row), a,
             {"kind": "vs_arm", "itemId": item_id, "granularity": a["granularity"],
              "armLeft": left_row["arm"], "armRight": right_row["arm"],
              "optionArm": min(a["arm"], b["arm"]),
              "arms": [a["arm"], b["arm"]],
              "selection": selection.get(item_id, "random")})

    for item_id in truth_ids:
        row = by_item[item_id][rng.randrange(len(by_item[item_id]))]
        truth_left = rng.random() < 0.5
        truth_text, cand_text = _completed(row, truth=True), _completed(row)
        left, right = ((truth_text, cand_text) if truth_left
                       else (cand_text, truth_text))
        pid = _pair_id(seed, "vs_truth", item_id, row["arm"])
        emit(pid, item_id, row["granularity"], left, right, row,
             {"kind": "vs_truth", "itemId": item_id,
              "granularity": row["granularity"], "arm": row["arm"],
              "truthSide": "left" if truth_left else "right",
              "truthText": truth_text,
              "selection": selection.get(item_id, "random")})

    # Identity, and the control stratum that withholds it. Chosen by hash so the
    # subset is deterministic, and STRATIFIED by kind so the control is not
    # accidentally all machine-vs-machine (where identity matters least).
    hidden = _blind_subset(key, seed=seed, frac=blind_frac)
    for p in pairs:
        pid = p["pairId"]
        ident = identity_of(key[pid]["itemId"], songs)
        key[pid]["identityHidden"] = pid in hidden or ident is None
        key[pid].update({"artist": (ident or {}).get("artist", ""),
                         "title": (ident or {}).get("title", "")})
        if key[pid]["identityHidden"]:
            p["identityHidden"] = True
            continue
        p.update(ident)

    if dupes and pairs:
        seen: Dict[str, dict] = {}
        for p in pairs:
            seen.setdefault(f"{key[p['pairId']]['kind']}/{p['granularity']}", p)
        rotation = [seen[k] for k in sorted(seen)]
        for i in range(dupes):
            pairs.append({**rotation[i % len(rotation)], "isDupe": True})

    return pairs, key


def _blind_subset(key: Dict[str, dict], *, seed: int, frac: float) -> set:
    """The pairIds whose song identity stays hidden — the un-blinding control."""
    if frac <= 0:
        return set()
    by_kind: Dict[str, List[str]] = {}
    for pid, entry in key.items():
        by_kind.setdefault(entry.get("kind", "?"), []).append(pid)
    out = set()
    for kind, pids in sorted(by_kind.items()):
        ordered = sorted(pids, key=lambda p: hashlib.sha256(
            f"{seed}|blind|{p}".encode("utf-8")).digest())
        out.update(ordered[:max(1, int(round(len(pids) * frac)))])
    return out


def _completed(row: dict, truth: bool = False) -> str:
    text = row["truth"] if truth else row["candidate"]
    masked = row.get("maskedLine")
    if not masked:
        return text
    from lyrics.bench.metrics import apply_fill
    return apply_fill({"granularity": row.get("granularity", "span"),
                       "context": {"maskedLine": masked}}, text)


# The I2c scale. Ordered, so "as good as" is a comparison rather than a claim.
RATINGS = ("no", "passable", "keep")
_SCORE = {name: i for i, name in enumerate(RATINGS)}


def owner_ratings(ratings: Sequence[dict],
                  key: Dict[str, dict]) -> Dict[str, dict]:
    """Resolve per-fill rating rows into {pairId: {left, right, heard}}.

    A side rated inconsistently resolves to None — with one exception. An
    UNFLAGGED repeat is the duplicate-pair probe that measures the rater against
    themselves, and reconciling it would destroy the measurement; a repeat
    carrying `revision` is a deliberate correction after arrowing back, and there
    the latest answer is the one meant.
    """
    seen: Dict[str, Dict[str, List[dict]]] = {}
    heard: Dict[str, bool] = {}
    for r in ratings:
        pid = r.get("pairId")
        side = str(r.get("side", "")).lower()
        val = str(r.get("rating", "")).lower()
        if pid not in key or side not in ("left", "right") or val not in _SCORE:
            continue
        seen.setdefault(pid, {}).setdefault(side, []).append(r)
        heard[pid] = heard.get(pid, False) or bool(r.get("heard"))

    out: Dict[str, dict] = {}
    for pid, sides in seen.items():
        row: Dict[str, object] = {"heard": bool(heard.get(pid))}
        for side, rows in sides.items():
            revisions = [r for r in rows if r.get("revision")]
            if revisions:
                row[side] = str(revisions[-1]["rating"]).lower()
                continue
            vals = {str(r["rating"]).lower() for r in rows}
            row[side] = vals.pop() if len(vals) == 1 else None
        out[pid] = row
    return out


def owner_labels(ratings: Sequence[dict],
                 key: Dict[str, dict]) -> Dict[str, Optional[int]]:
    """1 = the canonical option won, 0 = it lost, None = tie/contradictory.

    Reads BOTH instruments: the I2c per-fill ratings (the better-rated side wins,
    equal is a genuine tie) and the older forced choice. A pair carrying both is
    None — two instruments on one pair is ambiguity, not evidence.
    """
    out: Dict[str, Optional[int]] = {}

    def resolve(pid: str, side: str) -> int:
        entry = key[pid]
        if entry["kind"] == "vs_arm":
            arm = entry["armLeft"] if side == "left" else entry["armRight"]
            return 1 if arm == entry["optionArm"] else 0
        return 0 if side == entry["truthSide"] else 1

    for pid, row in owner_ratings(ratings, key).items():
        left, right = row.get("left"), row.get("right")
        if left is None or right is None or _SCORE[left] == _SCORE[right]:
            out[pid] = None
            continue
        out[pid] = resolve(pid, "left" if _SCORE[left] > _SCORE[right] else "right")

    by_pair: Dict[str, List[str]] = {}
    for r in ratings:
        pid = r.get("pairId")
        if pid in key and "choice" in r:
            by_pair.setdefault(pid, []).append(str(r.get("choice", "")).lower())
    for pid, choices in by_pair.items():
        if pid in out:                       # both instruments on one pair
            out[pid] = None
            continue
        sides = {c for c in choices if c in ("left", "right")}
        out[pid] = resolve(pid, sides.pop()) if len(sides) == 1 else None
    return out


# Higher is better for these; ppl is a cost, so its sign flips.
_LOWER_IS_BETTER = ("ppl",)


def column_predictions(key: Dict[str, dict], machine: Dict[str, dict],
                       column: str) -> Dict[str, Optional[int]]:
    """What a metric column predicts, on the SAME binary convention as
    `owner_labels`. A column that cannot separate the two sides returns None for
    that pair — an abstention, never a coin flip."""
    out: Dict[str, Optional[int]] = {}
    for pid, entry in key.items():
        if entry["kind"] == "vs_truth":
            m = machine.get(f"{entry['itemId']}|{entry['arm']}", {})
            v = m.get(column)
            if v is None:
                out[pid] = None
            elif column == "judge_win":
                out[pid] = int(v)
            else:
                # emb: only a near-identical line argues the machine matched the
                # human; ppl: fluent-as-truth (<= 0) argues the same.
                out[pid] = (1 if v < 0 else 0) if column in _LOWER_IS_BETTER \
                    else (1 if v > 0.98 else 0)
            continue
        a, b = entry["arms"][0], entry["arms"][1]
        va = machine.get(f"{entry['itemId']}|{a}", {}).get(column)
        vb = machine.get(f"{entry['itemId']}|{b}", {}).get(column)
        if va is None or vb is None or va == vb:
            out[pid] = None
            continue
        better = a if ((va < vb) if column in _LOWER_IS_BETTER else (va > vb)) else b
        out[pid] = 1 if better == entry["optionArm"] else 0
    return out
