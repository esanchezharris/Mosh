"""Blind-pair minting + judge-vs-owner agreement (FMS lyrics-bench I2).

This module decides which automated metric the program is allowed to optimize.
The program's governing lesson — five instrument "wins" that lost by ear — is
encoded here as a HALT: until some column agrees with the owner's blind labels
at or above the bar, no arm work starts.

Two invariants the tests pin, because both fail silently:
  * **The rated pairs carry no truth marker.** The blind key is a separate
    structure; a page rendered from `pairs` cannot leak which side is human.
  * **Balance.** Pairs are spread across (arm × granularity) cells, so one
    granularity cannot quietly decide the verdict.

Label convention, shared with `judge.py`: 1 = the CANDIDATE was preferred over
the human line, 0 = the human line was preferred, None = tie/unusable.
"""
from __future__ import annotations

import hashlib
import math
import random
from typing import Dict, List, Optional, Sequence, Tuple

Z95 = 1.959963984540054


# ── minting ─────────────────────────────────────────────────────────────────────

def completed_pool(rows: Sequence[dict]) -> List[dict]:
    """Replace bare fills with the LINES they complete.

    The LLM panel judges completed lines (`judge._completed`). If the owner's
    page showed bare span fragments — "real grim about my" vs "ugh and mug for" —
    the two raters would be answering different questions and their agreement
    would measure nothing. Rows carrying `maskedLine` are completed here; whole
    -line rows pass through.
    """
    from lyrics.bench.metrics import apply_fill

    out = []
    for row in rows:
        masked = row.get("maskedLine")
        if not masked:
            out.append(dict(row))
            continue
        stub = {"granularity": row.get("granularity", "span"),
                "context": {"maskedLine": masked}}
        out.append({**row,
                    "truth": apply_fill(stub, row["truth"]),
                    "candidate": apply_fill(stub, row["candidate"])})
    return out

def _cell(row: dict) -> Tuple[str, str]:
    return (row.get("arm", ""), row.get("granularity", ""))


def mint_pairs(pool: Sequence[dict], *, n: int, dupes: int = 0,
               seed: int = 0) -> Tuple[List[dict], Dict[str, dict]]:
    """Draw `n` blind pairs (including `dupes` deliberate repeats) balanced over
    the (arm, granularity) cells present in `pool`.

    Returns (pairs, blind_key). `pairs` is safe to render; `blind_key` names the
    truth side and must be stored where the rater cannot read it.
    """
    rng = random.Random(seed)
    distinct_n = max(1, n - dupes)

    by_cell: Dict[Tuple[str, str], List[dict]] = {}
    for row in pool:
        by_cell.setdefault(_cell(row), []).append(row)
    cells = sorted(by_cell)
    for c in cells:
        by_cell[c] = sorted(by_cell[c], key=lambda r: r["itemId"])
        rng.shuffle(by_cell[c])

    # Round-robin the cells so the draw stays balanced even when a cell is thin.
    chosen: List[dict] = []
    cursor = {c: 0 for c in cells}
    while len(chosen) < distinct_n and any(cursor[c] < len(by_cell[c]) for c in cells):
        for c in cells:
            if len(chosen) >= distinct_n:
                break
            if cursor[c] < len(by_cell[c]):
                chosen.append(by_cell[c][cursor[c]])
                cursor[c] += 1

    pairs: List[dict] = []
    key: Dict[str, dict] = {}
    for row in chosen:
        pair_id = hashlib.sha256(
            f"{seed}|{row['arm']}|{row['itemId']}".encode("utf-8")).hexdigest()[:16]
        truth_left = rng.random() < 0.5
        left = row["truth"] if truth_left else row["candidate"]
        right = row["candidate"] if truth_left else row["truth"]
        pairs.append({
            "pairId": pair_id, "granularity": row["granularity"], "arm": row["arm"],
            "before": list((row.get("context") or {}).get("before") or []),
            "after": list((row.get("context") or {}).get("after") or []),
            "left": left, "right": right,
        })
        key[pair_id] = {"truthSide": "left" if truth_left else "right",
                        "truthText": row["truth"], "itemId": row["itemId"],
                        "arm": row["arm"], "granularity": row["granularity"]}

    # Repeats measure the rater against THEMSELVES; spread them across cells so
    # self-consistency isn't an artifact of one kind of pair.
    if dupes and pairs:
        seen_cells: Dict[Tuple[str, str], dict] = {}
        for p in pairs:
            seen_cells.setdefault((p["arm"], p["granularity"]), p)
        rotation = [seen_cells[c] for c in sorted(seen_cells)]
        for i in range(dupes):
            src = rotation[i % len(rotation)]
            pairs.append({**src, "isDupe": True})

    return pairs, key


# ── owner side ──────────────────────────────────────────────────────────────────

def owner_labels(ratings: Sequence[dict], key: Dict[str, dict]) -> Dict[str, Optional[int]]:
    """Resolve raw {pairId, choice} rows against the blind key.

    A pair the owner answered inconsistently across repeats resolves to None:
    genuinely ambiguous input must not become a confident label.
    """
    by_pair: Dict[str, List[str]] = {}
    for r in ratings:
        pid = r.get("pairId")
        if pid in key:
            by_pair.setdefault(pid, []).append(str(r.get("choice", "")).lower())
    out: Dict[str, Optional[int]] = {}
    for pid, choices in by_pair.items():
        sides = {c for c in choices if c in ("left", "right")}
        if "tie" in choices and not sides:
            out[pid] = None
            continue
        if len(sides) != 1:
            out[pid] = None
            continue
        chose = sides.pop()
        out[pid] = 0 if chose == key[pid]["truthSide"] else 1
    return out


def self_consistency(ratings: Sequence[dict]) -> Optional[float]:
    """Share of repeated answers the rater gave the same way. None = no repeats.
    A low number caps how much any agreement statistic can mean.

    Keyed on (pairId, side) so it works under BOTH instruments. Grouping on
    pairId alone and comparing a `choice` field — the v1 shape — scored every
    per-fill repeat as identical (`"" == ""`) and reported a flat 1.0.
    """
    by_slot: Dict[Tuple[str, str], List[str]] = {}
    for r in ratings:
        pid = r.get("pairId")
        if not pid:
            continue
        if r.get("rating") is not None:
            slot = (pid, str(r.get("side", "")).lower())
            answer = str(r.get("rating", "")).lower()
        else:
            slot = (pid, "choice")
            answer = str(r.get("choice", "")).lower()
        by_slot.setdefault(slot, []).append(answer)
    repeats = [v for v in by_slot.values() if len(v) > 1]
    if not repeats:
        return None
    return sum(1 for v in repeats if len(set(v)) == 1) / len(repeats)


# ── statistics ──────────────────────────────────────────────────────────────────

def wilson_ci(k: int, n: int, z: float = Z95) -> Tuple[float, float]:
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def pairwise_agreement(owner: Dict[str, Optional[int]],
                       column: Dict[str, Optional[int]]) -> dict:
    """How often a judge column matches the owner on pairs BOTH scored."""
    hits = 0
    n = 0
    for pid, label in owner.items():
        other = column.get(pid)
        if label is None or other is None:
            continue
        n += 1
        if label == other:
            hits += 1
    return {"accuracy": (hits / n) if n else None, "n": n, "hits": hits,
            "ci": wilson_ci(hits, n)}


def _avg_ranks(xs: Sequence[float]) -> List[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def spearman(xs: Sequence[float], ys: Sequence[float]) -> Optional[float]:
    """Rank correlation with average ranks (tie-safe). None when undefined."""
    pts = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pts) < 2:
        return None
    rx = _avg_ranks([p[0] for p in pts])
    ry = _avg_ranks([p[1] for p in pts])
    n = len(pts)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx)
                    * sum((b - my) ** 2 for b in ry))
    return (num / den) if den > 1e-12 else None


def cohens_kappa(a: Sequence[int], b: Sequence[int]) -> Optional[float]:
    """Chance-corrected agreement between two binary raters."""
    pts = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if not pts:
        return None
    n = len(pts)
    po = sum(1 for x, y in pts if x == y) / n
    pa = sum(x for x, _ in pts) / n
    pb = sum(y for _, y in pts) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    return 1.0 if abs(1 - pe) < 1e-12 else (po - pe) / (1 - pe)


# ── absolute acceptability (I2c) ────────────────────────────────────────────────
#
# The election answers "which automated column tracks the owner's taste". It does
# NOT answer the owner's actual question, which is absolute: does the generated
# bar work? Forced choice could not answer it — the winner of two bad bars still
# wins. Per-fill ratings can, and the honest form of the answer is a rate against
# the rate the REAL bar achieves on the same scale.

WORKS = ("keep", "passable")


def _machine_side(entry: dict) -> Optional[str]:
    """Which side of a pair is the arm's fill. Both sides on vs_arm; on vs_truth
    it is whichever side the truth is not."""
    if entry.get("kind") == "vs_truth":
        return "left" if entry.get("truthSide") == "right" else "right"
    return None                              # vs_arm: both sides are machine


def _rate(vals: Sequence[str]) -> dict:
    n = len(vals)
    works = sum(1 for v in vals if v in WORKS)
    keeps = sum(1 for v in vals if v == "keep")
    return {"n": n,
            "worksRate": (works / n) if n else None,
            "keepRate": (keeps / n) if n else None,
            "worksCi": wilson_ci(works, n), "keepCi": wilson_ci(keeps, n),
            "works": works, "keeps": keeps}


def acceptability(rated: Dict[str, dict], key: Dict[str, dict]) -> dict:
    """Per-arm rates at which the MACHINE fills were judged to work.

    `rated` is `mixpairs.owner_ratings` output. On vs_arm pairs both sides are
    machine fills and each is credited to its own arm; on vs_truth only the
    non-truth side counts, or the human bar would inflate the arm's rate.
    """
    by_arm: Dict[str, List[str]] = {}
    for pid, row in rated.items():
        entry = key.get(pid)
        if not entry:
            continue
        if entry.get("kind") == "vs_arm":
            for side, arm in (("left", entry.get("armLeft")),
                              ("right", entry.get("armRight"))):
                if row.get(side) and arm:
                    by_arm.setdefault(arm, []).append(row[side])
            continue
        side = _machine_side(entry)
        if row.get(side):
            by_arm.setdefault(entry.get("arm", "?"), []).append(row[side])
    return {"arms": {arm: _rate(vals) for arm, vals in sorted(by_arm.items())}}


def ceiling(rated: Dict[str, dict], key: Dict[str, dict]) -> dict:
    """How often the REAL bar itself reads as working — the reference the arms
    are measured against.

    Read from the ANCHOR stratum only. Disagreement pairs were selected because
    the metrics split on them, so any absolute rate computed over them is a rate
    for a deliberately unusual subset. Under per-fill rating the human bar gets
    rated on every vs_truth pair for free, which makes it tempting to use them
    all; that would buy a tighter interval around the wrong number.
    """
    vals: List[str] = []
    for pid, row in rated.items():
        entry = key.get(pid)
        if not entry or entry.get("kind") != "vs_truth":
            continue
        if entry.get("selection") != "anchor":
            continue
        side = entry.get("truthSide")
        if row.get(side):
            vals.append(row[side])
    return {**_rate(vals), "stratum": "anchor"}


def diff_ci(k1: int, n1: int, k2: int, n2: int, z: float = Z95) -> dict:
    """Difference of two proportions with a Newcombe interval.

    Newcombe composes the two Wilson intervals rather than assuming normality,
    so it stays sane at the small counts a one-sitting stratum actually
    produces — which is where a textbook normal interval would run past 0 or 1
    and quietly imply more confidence than the data holds.
    """
    p1 = (k1 / n1) if n1 else 0.0
    p2 = (k2 / n2) if n2 else 0.0
    l1, u1 = wilson_ci(k1, n1, z)
    l2, u2 = wilson_ci(k2, n2, z)
    lo = (p1 - p2) - math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)
    hi = (p1 - p2) + math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)
    return {"diff": p1 - p2, "ci": (max(-1.0, lo), min(1.0, hi)),
            "n1": n1, "n2": n2}


def by_condition(rated: Dict[str, dict], key: Dict[str, dict]) -> dict:
    """The control read: machine-fill acceptability split by whether the song was
    named, and by whether the owner actually played it.

    If un-blinding moved the ratings, it shows up here — which is what lets a
    later low agreement number be attributed to the judges rather than to the
    instrument having changed underneath them.
    """
    buckets: Dict[str, List[str]] = {"shown": [], "hidden": [],
                                     "heard": [], "notHeard": []}
    for pid, row in rated.items():
        entry = key.get(pid)
        if not entry:
            continue
        sides = (["left", "right"] if entry.get("kind") == "vs_arm"
                 else [_machine_side(entry)])
        vals = [row[s] for s in sides if row.get(s)]
        if not vals:
            continue
        buckets["hidden" if entry.get("identityHidden") else "shown"] += vals
        buckets["heard" if row.get("heard") else "notHeard"] += vals
    return {name: _rate(vals) for name, vals in buckets.items()}


# ── the election ────────────────────────────────────────────────────────────────

MIN_KAPPA = 0.4  # "moderate" agreement — below this a column has no real skill


def elect(owner: Dict[str, Optional[int]],
          columns: Dict[str, Dict[str, Optional[int]]], *, bar: float,
          min_kappa: float = MIN_KAPPA) -> dict:
    """Rank judge columns by CHANCE-CORRECTED agreement; the best one that clears
    both floors earns the right to be optimized.

    Raw accuracy alone is not enough and the program learned that the hard way:
    when the owner preferred the human line 94% of the time, a column that says
    "human" forever scored 0.96 and was elected — pure base rate, zero skill.
    Cohen's κ is 0 for any constant column by construction, so ranking on κ (and
    reporting the majority-class baseline next to accuracy) makes the inflation
    both impossible to win on and visible on the page.
    """
    labels = [v for v in owner.values() if v is not None]
    baseline = (max(labels.count(0), labels.count(1)) / len(labels)) if labels else None
    ranked = []
    for name, col in sorted(columns.items()):
        agr = pairwise_agreement(owner, col)
        if agr["accuracy"] is None:
            continue
        paired = [(owner[p], col[p]) for p in owner
                  if owner.get(p) is not None and col.get(p) is not None]
        k = cohens_kappa([a for a, _ in paired], [b for _, b in paired])
        ranked.append({"metric": name, **agr, "kappa": (0.0 if k is None else k),
                       "constant": len({b for _, b in paired}) < 2})
    ranked.sort(key=lambda r: (-r["kappa"], -r["accuracy"], r["metric"]))
    head = {"bar": bar, "minKappa": min_kappa, "baseline": baseline,
            "ranked": ranked, "runnerUp": ranked[1] if len(ranked) > 1 else None}
    if not columns:
        # "Nothing was measured" is a different state from "everything measured
        # failed". An arm-vs-arm taste sitting carries no judge columns at all,
        # and reporting that as HALT would send someone off to fix judges that
        # were never run.
        return {"metric": None, "agreement": None, "halt": True,
                "noColumns": True, **head}
    if (not ranked or ranked[0]["kappa"] < min_kappa
            or ranked[0]["accuracy"] < bar
            or (baseline is not None and ranked[0]["accuracy"] <= baseline)):
        return {"metric": None, "agreement": None, "halt": True, **head}
    best = ranked[0]
    return {"metric": best["metric"], "agreement": best["accuracy"],
            "kappa": best["kappa"], "ci": best["ci"], "n": best["n"],
            "halt": False, **head}


def _pct(x: Optional[float]) -> str:
    return "—" if x is None else f"{100 * x:.0f}%"


def _acceptability_section(meta: dict) -> List[str]:
    """The headline: does the generated bar work, against the rate the real bar
    works. This is the PRODUCT read; the election below is the instrument read,
    and the pre-registered gate stays on the election."""
    acc, ceil_ = meta.get("acceptability"), meta.get("ceiling")
    if not acc:
        return []
    out = ["## Does the bar work?", ""]
    c_n = (ceil_ or {}).get("n") or 0
    if c_n:
        out.append(f"The real bar itself reads as working **{_pct(ceil_['worksRate'])}** "
                   f"of the time (keep: {_pct(ceil_['keepRate'])}), over {c_n} "
                   f"anchor-stratum bars. That is the ceiling — not 100%.")
    else:
        out.append("**No anchor-stratum human bars were rated**, so there is no "
                   "measured ceiling to compare against; treat the rates below "
                   "as uncalibrated.")
    out += ["", "| arm | works (keep+passable) | keep | n | vs the real bar |",
            "|---|---|---|---|---|"]
    for arm, r in sorted(acc.get("arms", {}).items()):
        lo, hi = r["worksCi"]
        gapstr = "—"
        if c_n:
            g = diff_ci(r["works"], r["n"], ceil_["works"], ceil_["n"])
            glo, ghi = g["ci"]
            verdict = ("as good as" if glo <= 0 <= ghi
                       else ("BETTER" if g["diff"] > 0 else "worse"))
            gapstr = f"{g['diff']:+.0%} ({glo:+.0%}…{ghi:+.0%}) — {verdict}"
        out.append(f"| {arm} | {_pct(r['worksRate'])} "
                   f"({lo:.0%}–{hi:.0%}) | {_pct(r['keepRate'])} | {r['n']} | "
                   f"{gapstr} |")
    cond = meta.get("conditions") or {}
    if cond:
        out += ["", "Control read — did naming the song change the ratings?", "",
                "| condition | works | n |", "|---|---|---|"]
        for name in ("shown", "hidden", "heard", "notHeard"):
            r = cond.get(name) or {}
            out.append(f"| {name} | {_pct(r.get('worksRate'))} | {r.get('n', 0)} |")
        out.append("")
        out.append("*A large shown-vs-hidden gap means the instrument moved, not "
                   "the arms — read the election below with that in mind.*")
    return out + [""]


def render_report(by_granularity: Dict[str, dict], meta: dict) -> str:
    bar = meta.get("bar")
    lines = ["# Judge calibration — owner agreement", "",
             f"Labels: **{meta.get('labels')}** · owner self-consistency: "
             f"**{meta.get('selfConsistency')}** · trust bar: **{bar}**", ""]
    lines += _acceptability_section(meta)
    no_cols = [g for g, e in sorted(by_granularity.items()) if e.get("noColumns")]
    if no_cols:
        lines += [f"*No automated column was available for: {', '.join(no_cols)} — "
                  f"nothing to elect. This is what an arm-vs-arm taste sitting "
                  f"looks like; the election path belongs to judge calibration.*",
                  ""]
    halted = [g for g, e in sorted(by_granularity.items())
              if e.get("halt") and not e.get("noColumns")]
    if halted:
        lines += [f"**HALT** — no column reaches the bar for: {', '.join(halted)}. "
                  f"Arm optimization stays blocked there; iterate on judges or "
                  f"item design instead.", ""]
    for gran, e in sorted(by_granularity.items()):
        lines.append(f"## {gran}")
        lines.append("")
        base = e.get("baseline")
        if base is not None:
            lines.append(f"Majority-class baseline: **{base:.3f}** — any column at "
                         f"or below this is riding the base rate, not reading taste.")
            lines.append("")
        if e.get("noColumns"):
            lines.append("No automated column was scored for this granularity, "
                         "so there was nothing to elect.")
        elif e.get("halt"):
            lines.append(f"HALT — no column clears both floors "
                         f"(accuracy > baseline and ≥ {bar}, κ ≥ "
                         f"{e.get('minKappa')}).")
        else:
            ci = e.get("ci") or (0, 0)
            lines.append(f"Trusted: **{e['metric']}** — agreement "
                         f"{e['agreement']:.3f} (95% CI {ci[0]:.2f}–{ci[1]:.2f}, "
                         f"n={e.get('n')}), κ={e.get('kappa'):.3f}")
        lines.append("")
        lines.append("| column | agreement | κ (chance-corrected) | n | 95% CI | |")
        lines.append("|---|---|---|---|---|---|")
        for r in e.get("ranked", []):
            lo, hi = r["ci"]
            flag = "constant — no skill" if r.get("constant") else (
                "below baseline" if base is not None and r["accuracy"] <= base else "")
            lines.append(f"| {r['metric']} | {r['accuracy']:.3f} | {r['kappa']:.3f} | "
                         f"{r['n']} | {lo:.2f}–{hi:.2f} | {flag} |")
        lines.append("")
    lines.append("*Generated by `bench_cli.py calibrate report` — do not hand-edit.*")
    return "\n".join(lines) + "\n"
