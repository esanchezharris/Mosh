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
    """Share of repeated pairs the rater answered the same way. None = no repeats.
    A low number caps how much any agreement statistic can mean."""
    by_pair: Dict[str, List[str]] = {}
    for r in ratings:
        by_pair.setdefault(r.get("pairId"), []).append(str(r.get("choice", "")).lower())
    repeats = [v for v in by_pair.values() if len(v) > 1]
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


# ── the election ────────────────────────────────────────────────────────────────

def elect(owner: Dict[str, Optional[int]],
          columns: Dict[str, Dict[str, Optional[int]]], *, bar: float) -> dict:
    """Rank judge columns by owner agreement; the best one at/above `bar` earns
    the right to be optimized. Nothing clears it ⇒ halt=True (the program
    iterates on judges, never on arms)."""
    ranked = []
    for name, col in sorted(columns.items()):
        agr = pairwise_agreement(owner, col)
        if agr["accuracy"] is not None:
            ranked.append({"metric": name, **agr})
    ranked.sort(key=lambda r: (-r["accuracy"], r["metric"]))
    if not ranked or ranked[0]["accuracy"] < bar:
        return {"metric": None, "agreement": None, "halt": True, "bar": bar,
                "ranked": ranked, "runnerUp": ranked[1] if len(ranked) > 1 else None}
    best = ranked[0]
    return {"metric": best["metric"], "agreement": best["accuracy"],
            "ci": best["ci"], "n": best["n"], "halt": False, "bar": bar,
            "ranked": ranked, "runnerUp": ranked[1] if len(ranked) > 1 else None}


def render_report(by_granularity: Dict[str, dict], meta: dict) -> str:
    bar = meta.get("bar")
    lines = ["# Judge calibration — owner agreement", "",
             f"Labels: **{meta.get('labels')}** · owner self-consistency: "
             f"**{meta.get('selfConsistency')}** · trust bar: **{bar}**", ""]
    halted = [g for g, e in sorted(by_granularity.items()) if e.get("halt")]
    if halted:
        lines += [f"**HALT** — no column reaches the bar for: {', '.join(halted)}. "
                  f"Arm optimization stays blocked there; iterate on judges or "
                  f"item design instead.", ""]
    for gran, e in sorted(by_granularity.items()):
        lines.append(f"## {gran}")
        lines.append("")
        if e.get("halt"):
            lines.append(f"HALT — best column below the {bar} bar.")
        else:
            ci = e.get("ci") or (0, 0)
            lines.append(f"Trusted: **{e['metric']}** — agreement "
                         f"{e['agreement']:.3f} (95% CI {ci[0]:.2f}–{ci[1]:.2f}, "
                         f"n={e.get('n')})")
        lines.append("")
        lines.append("| column | agreement | n | 95% CI |")
        lines.append("|---|---|---|---|")
        for r in e.get("ranked", []):
            lo, hi = r["ci"]
            lines.append(f"| {r['metric']} | {r['accuracy']:.3f} | {r['n']} | "
                         f"{lo:.2f}–{hi:.2f} |")
        lines.append("")
    lines.append("*Generated by `bench_cli.py calibrate report` — do not hand-edit.*")
    return "\n".join(lines) + "\n"
