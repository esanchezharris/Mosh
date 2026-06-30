#!/usr/bin/env python3
"""Phase 2 — analyze the owner's blind ratings against the §12 composite decomposition.

Reads the private mapping + the owner-filled RATINGS.csv / AB_PAIRS.csv and answers the gating
question: does a HIGHER reward correspond to "sounds better to a human" — and is that carried by
`pull` (the learned, taste-bearing term) or only by `pq`/`clean` (the DSP surface)?

Outputs:
  • Spearman ρ(rating, X) for X ∈ {composite, pull, pq, clean}, pooled and per-base.
  • pull dynamic range across the set (the "structurally drowned" check).
  • A/B agreement rate per metric (does the metric pick the owner's winner?).
  • per-intent table: mean owner rating vs mean pull/composite (does good/bad align?).
  • a 🟢/🟡/🔴 verdict against the decision gate.

No scipy dependency — Spearman = Pearson on average-ranked values; significance via a t-approx.

  python analyze.py --pack ~/mosh-reward-probe
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path


def _avg_ranks(xs: list[float]) -> list[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        r = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    return ranks


def _pearson(a: list[float], b: list[float]) -> float:
    n = len(a)
    if n < 3:
        return float("nan")
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((x - mb) ** 2 for x in b)
    if va <= 0 or vb <= 0:
        return float("nan")
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    return cov / math.sqrt(va * vb)


def spearman(x: list[float], y: list[float]) -> tuple[float, float, int]:
    """(rho, approx two-sided p, n). p via t = rho*sqrt((n-2)/(1-rho^2))."""
    pairs = [(a, b) for a, b in zip(x, y) if a is not None and b is not None]
    n = len(pairs)
    if n < 3:
        return float("nan"), float("nan"), n
    rho = _pearson(_avg_ranks([p[0] for p in pairs]), _avg_ranks([p[1] for p in pairs]))
    if not math.isfinite(rho) or abs(rho) >= 1.0:
        return rho, (0.0 if abs(rho) >= 1 else float("nan")), n
    t = rho * math.sqrt((n - 2) / (1 - rho * rho))
    # crude normal approx to the two-sided t p-value (n large enough here)
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(t) / math.sqrt(2))))
    return rho, p, n


def load(pack: Path):
    mp = json.loads((pack / ".mapping.json").read_text())
    mapping = mp["mapping"]
    ratings = {}
    for row in csv.DictReader((pack / "RATINGS.csv").read_text().splitlines()):
        idx = (row.get("index") or "").strip()
        val = (row.get("rating") or "").strip()
        if idx and val:
            try:
                ratings[idx] = float(val)
            except ValueError:
                pass
    ab = []
    abf = pack / "AB_PAIRS.csv"
    if abf.exists():
        for row in csv.DictReader(abf.read_text().splitlines()):
            w = (row.get("winner") or "").strip().upper()
            if w in ("A", "B"):
                ab.append({"A": row["A"].strip(), "B": row["B"].strip(), "winner": w})
    return mapping, ratings, ab, mp.get("ab_pairs", [])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default="~/mosh-reward-probe")
    a = ap.parse_args()
    pack = Path(a.pack).expanduser()
    mapping, ratings, ab, _ = load(pack)

    rated = [idx for idx in mapping if idx in ratings]
    print(f"=== Reward-validity probe analysis ===")
    print(f"clips: {len(mapping)} | rated: {len(rated)}")
    if len(rated) < 10:
        print("Not enough ratings yet (need ≥10). Fill RATINGS.csv and re-run.")
        return 0

    def col(metric):
        return [mapping[i].get(metric) for i in rated]
    r = [ratings[i] for i in rated]

    print("\n-- pooled Spearman ρ(rating, metric) --")
    rhos = {}
    for m in ("composite", "pull", "pq", "clean"):
        rho, p, n = spearman(r, col(m))
        rhos[m] = rho
        star = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else " "
        print(f"  {m:10s} ρ={rho:+.3f}  p≈{p:.3g} {star}  (n={n})")

    # pull dynamic range
    pulls = [v for v in col("pull") if v is not None]
    if pulls:
        import statistics as st
        print(f"\n-- pull dynamic range (rated clips) --")
        print(f"  min={min(pulls):.3f} max={max(pulls):.3f} spread={max(pulls)-min(pulls):.3f} "
              f"std={st.pstdev(pulls):.4f}")

    # per-intent table
    print("\n-- per-intent: mean owner rating vs mean pull / composite --")
    intents = {}
    for i in rated:
        intents.setdefault(mapping[i]["intent"], []).append(i)
    order = ["good", "good_mid", "bad_density", "bad_timing", "bad_coherence", "bad_harmony", "bad_mix", "anchor"]
    for it in [o for o in order if o in intents] + [k for k in intents if k not in order]:
        ids = intents[it]
        mr = sum(ratings[i] for i in ids) / len(ids)
        mp_ = sum((mapping[i]["pull"] or 0) for i in ids) / len(ids)
        mc = sum(mapping[i]["composite"] for i in ids) / len(ids)
        print(f"  {it:14s} n={len(ids):2d}  rating={mr:.2f}  pull={mp_:.3f}  composite={mc:.3f}")

    # A/B agreement
    if ab:
        print(f"\n-- A/B agreement ({len(ab)} judged pairs): does the metric pick the owner's winner? --")
        for m in ("composite", "pull", "pq"):
            ok = 0
            for p in ab:
                va, vb = mapping[p["A"]].get(m), mapping[p["B"]].get(m)
                if va is None or vb is None:
                    continue
                pick = "A" if va > vb else "B"
                ok += (pick == p["winner"])
            print(f"  {m:10s} {ok}/{len(ab)} = {ok/len(ab):.0%}")

    # ── verdict ──
    rp, rq, rc = rhos.get("pull", float("nan")), rhos.get("pq", float("nan")), rhos.get("composite", float("nan"))
    spread = (max(pulls) - min(pulls)) if pulls else 0.0
    print("\n=== VERDICT ===")
    def sig(x):  # treat |ρ|<0.2 as "not meaningful"
        return math.isfinite(x) and abs(x) >= 0.2
    if sig(rp) and rp > 0 and (not math.isfinite(rq) or rp >= rq - 0.05):
        print("🟢 GREEN — pull correlates with your ears AND matches/beats pq. The reward is a valid")
        print("   absolute target; the bottleneck is purely POLICY. Greenlight policy investment")
        print("   (better SFT on multi-step content-building), then RL as refinement.")
    elif sig(rc) and rc > 0 and (not sig(rp) or rp < 0.2) :
        print("🟡 YELLOW — the composite correlates, but it's carried by pq (DSP surface), not pull")
        print(f"   (ρ_pull={rp:+.3f}, spread={spread:.3f}). Optimizing it would chase production, not")
        print("   taste. Broaden the 21 exemplars + rework the pull weighting BEFORE any training.")
    else:
        print("🔴 RED — nothing (composite/pull/pq) tracks your ears. Relative-ordering (the keystone)")
        print("   did NOT transfer to absolute validity. Stop and rework the reward before policy/RL.")
    print("\n(ρ_pull={:+.3f}  ρ_pq={:+.3f}  ρ_composite={:+.3f})".format(rp, rq, rc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
