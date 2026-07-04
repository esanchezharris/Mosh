#!/usr/bin/env python3
"""Golden test for merge_labels.build_source_priors (owner keep/kill → retrieval nudges).

Laplace-smoothed, clamped to ±1, emitted only at n≥3 — a nudge inside a retrieval band
(vs the mood scorer's +3.0), never a ban.
"""
from __future__ import annotations

import os
import sys

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_REPO, "scripts", "verify-hardware"))

from merge_labels import build_source_priors  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
    if not cond:
        fails.append(name)


def row(value, sources, backbone=None):
    feats = {"sources": sources}
    if backbone:
        feats["backbone"] = backbone
    return {"kind": "keep", "value": value, "features": feats}


rows = ([row("keep", {"drums": "winner"}) for _ in range(3)]
        + [row("kill", {"drums": "loser"}) for _ in range(3)]
        + [row("keep", {"drums": "thin"})] * 2                  # n=2 → omitted
        + [row("keep", {"drums": "mixed"}), row("kill", {"drums": "mixed"}),
           row("keep", {"drums": "mixed"})]
        + [{"kind": "star", "value": "3"},                       # non-pack rows ignored
           {"kind": "keep", "value": ""}])                       # unrated card ignored
p = build_source_priors(rows)
check("3/3 keeps → prior 0.6 (Laplace)", abs(p["winner"]["prior"] - 0.6) < 1e-9, str(p.get("winner")))
check("0/3 keeps → prior −0.6", abs(p["loser"]["prior"] + 0.6) < 1e-9, str(p.get("loser")))
check("2/3 keeps → prior 0.2", abs(p["mixed"]["prior"] - 0.2) < 1e-9, str(p.get("mixed")))
check("n<3 sources are omitted", "thin" not in p)
check("counts carried for the audit trail", p["winner"]["n"] == 3 and p["winner"]["keeps"] == 3)

# a beat using a source in ANY group (or as backbone) counts ONCE
rows2 = [row("keep", {"drums": "dual", "808": "dual"}, backbone="dual") for _ in range(3)]
p2 = build_source_priors(rows2)
check("multi-group use of one source counts once per beat", p2["dual"]["n"] == 3, str(p2))

# priors are bounded: formula keeps |prior| < 1 for any n
rows3 = [row("keep", {"drums": "hot"}) for _ in range(50)]
p3 = build_source_priors(rows3)
check("prior stays inside ±1 at any n", 0 < p3["hot"]["prior"] < 1.0, str(p3["hot"]))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
