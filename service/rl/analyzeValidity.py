#!/usr/bin/env python3
"""Analyze the reward-validity pack: does the deterministic recipe verifier track owner taste?

Reads <pack>/.mapping.json (index→verifier score, tier), RATINGS.csv (index,rating 1-7), and AB.csv
(pair,A,B,winner). Reports Spearman ρ(rating, verifier), per-tier mean rating vs mean verifier (does
the verifier order tiers the way the owner does?), the decisive auto-vs-degraded gap, and A/B agreement
(does the higher-verifier clip win?). Verdict 🟢 (ρ≳0.5 → optimize) / 🟡 (0.2-0.5 → competence gate only)
/ 🔴 (≈0 → same failure as the audio reward).

  python3 service/rl/analyzeValidity.py --pack ~/mosh-validity
  (with RATINGS.csv / AB.csv dropped into the pack dir by the owner)
"""
import argparse
import csv
import json
import os


def spearman(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:  # average ties
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    den = (sum((rx[i] - mx) ** 2 for i in range(n)) * sum((ry[i] - my) ** 2 for i in range(n))) ** 0.5
    return None if den == 0 else round(num / den, 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=os.path.expanduser("~/mosh-validity"))
    a = ap.parse_args()
    m = {x["index"]: x for x in json.load(open(os.path.join(a.pack, ".mapping.json")))["mapping"]}

    rpath = os.path.join(a.pack, "RATINGS.csv")
    if not os.path.isfile(rpath):
        print(f"no RATINGS.csv in {a.pack} yet — owner rates via index.html, then re-run.")
        return
    ratings = {}
    for row in csv.DictReader(open(rpath)):
        if row.get("rating", "").strip():
            ratings[row["index"]] = float(row["rating"])

    paired = [(m[i]["verifier"], ratings[i], m[i]["tier"]) for i in ratings if i in m]
    if len(paired) < 3:
        print(f"only {len(paired)} rated — need ≥3."); return
    vers = [p[0] for p in paired]
    rats = [p[1] for p in paired]
    rho = spearman(vers, rats)

    # per-tier
    tiers = {}
    for v, r, t in paired:
        tiers.setdefault(t, []).append((v, r))
    print(f"=== reward-validity: recipe verifier vs owner taste (n={len(paired)}) ===")
    print(f"Spearman ρ(verifier, rating) = {rho}")
    print(f"{'tier':12} {'n':>2}  {'mean_verifier':>13}  {'mean_rating':>11}")
    order = []
    for t in ["optimized", "plain", "flat", "flat_clone"]:
        if t in tiers:
            vs = [x[0] for x in tiers[t]]; rs = [x[1] for x in tiers[t]]
            mv, mr = sum(vs) / len(vs), sum(rs) / len(rs)
            order.append((t, mv, mr))
            print(f"{t:12} {len(vs):>2}  {mv:>13.3f}  {mr:>11.2f}")
    # decisive: does the verifier order tiers the way the owner does?
    if len(order) >= 2:
        by_ver = [t for t, _, _ in sorted(order, key=lambda x: -x[1])]
        by_rat = [t for t, _, _ in sorted(order, key=lambda x: -x[2])]
        print(f"tier order by verifier: {by_ver}")
        print(f"tier order by rating  : {by_rat}")
        print(f"orders agree: {by_ver == by_rat}")

    # A/B agreement: does the higher-verifier clip win?
    abp = os.path.join(a.pack, "AB.csv")
    if os.path.isfile(abp):
        agree = tot = 0
        for row in csv.DictReader(open(abp)):
            w = row.get("winner", "").strip()
            if w not in ("A", "B"):
                continue
            A, B = row["A"], row["B"]
            if A not in m or B not in m:
                continue
            tot += 1
            hi = "A" if m[A]["verifier"] >= m[B]["verifier"] else "B"
            if hi == w:
                agree += 1
        if tot:
            print(f"A/B: verifier agrees with owner pick {agree}/{tot}")

    verdict = "🟢 valid ranking signal — OK to optimize" if (rho or 0) >= 0.5 else \
              "🟡 competence-gate only — use as a GATE, learn taste from preferences (BT/DPO)" if (rho or 0) >= 0.2 else \
              "🔴 NOT valid — same failure as the audio reward; do not optimize the score"
    print(f"\nVERDICT: {verdict}")


if __name__ == "__main__":
    main()
