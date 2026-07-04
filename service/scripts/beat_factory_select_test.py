#!/usr/bin/env python3
"""Pure-function tests for beat_factory.select_pack (pack diversity caps).

Pack-001 shipped ONE pad sample in 7/14 beats ("getting tired of this sound effect")
because (a) only (drums, backbone) pairs were capped and (b) the backfill loop ignored
every cap. Now: any single sample hash seats ≤2 pack beats, and caps relax in a
DECLARED order (mood → combo → sample LAST) only when the pack would run short.
"""
from __future__ import annotations

import os
import sys

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_REPO, "scripts", "verify-hardware"))

from beat_factory import select_pack  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
    if not cond:
        fails.append(name)


def cand(i, mood="dark", drums=None, backbone=None, pad="shared_pad.wav", sub=0.8):
    return {"id": f"c{i:02d}", "request": {"mood": mood},
            "sources": {"drums": drums or f"drumsrc{i}"}, "backbone": backbone or f"bb{i}",
            "samples": {"kick": f"kick{i}.wav", "pad": pad},
            "gate": {"keyRank": 0, "subRatio": sub}}


# 6 candidates all sharing one pad sample, distinct moods/combos → cap binds at 2
pool = [cand(i, mood=m) for i, m in enumerate(("dark", "chill", "dark", "chill",
                                               "aggressive", "emotional"))]
picks2 = select_pack(pool, 2)
check("2-pack from shared-pad pool honors the sample cap", len(picks2) == 2)
picks4 = select_pack(pool, 4)
pads4 = [p["samples"]["pad"] for p in picks4]
check("4-pack forces relaxation but still fills to size", len(picks4) == 4, str(len(picks4)))
check("strict phase seats exactly 2 shared-pad beats before relaxing",
      pads4.count("shared_pad.wav") == 4 and len(picks4) == 4)

# with DIVERSE pads the cap never binds and no relaxation happens
diverse = [cand(i, mood=("dark", "chill")[i % 2], pad=f"pad{i}.wav") for i in range(8)]
picks_d = select_pack(diverse, 6)
pad_counts = {}
for p in picks_d:
    pad_counts[p["samples"]["pad"]] = pad_counts.get(p["samples"]["pad"], 0) + 1
check("diverse pool: no sample exceeds the ≤2 cap", max(pad_counts.values()) <= 2)
check("diverse pool fills to size", len(picks_d) == 6)

# 3 candidates share a pad; pack of 3 must seat only 2 of them plus another candidate
mixed = ([cand(i, mood=("dark", "chill", "aggressive")[i], pad="hot.wav") for i in range(3)]
         + [cand(9, mood="emotional", pad="cool.wav")])
picks_m = select_pack(mixed, 3)
hot = sum(1 for p in picks_m if p["samples"]["pad"] == "hot.wav")
check("shared sample capped at 2 when alternatives exist", hot == 2 and len(picks_m) == 3,
      f"hot={hot} n={len(picks_m)}")

# determinism
check("selection is deterministic", [p["id"] for p in select_pack(pool, 4)]
      == [p["id"] for p in picks4])

# ── pack page: topPick replaces stars (owner: stars collapsed to all-3s) ──────
import tempfile

from beat_factory import build_pack_page

with tempfile.TemporaryDirectory() as td:
    picks_pg = [{"id": f"c{i}", "pack_file": f"{i:02d}_x.wav",
                 "request": {"style": "club-swag", "mood": "chill", "tempo": 132,
                             "key": "A minor"},
                 "sources": {"drums": "d"}, "samples": {},
                 "gate": {"keyRank": 0, "subRatio": 0.7}} for i in range(3)]
    page_path = build_pack_page(td, picks_pg)
    html = open(page_path).read()
check("stars are GONE from the pack page", ".stars" not in html and "★</button>" not in html)
check("every card carries exactly one TOP PICK button",
      html.count('data-k="top"') == 3)
check("CSV export carries the top column (no stars)",
      '"top"' in html and '"stars"' not in html)
check("export blocks until verdicts + top pick are set",
      "KEEP or KILL every beat first" in html and "Pick exactly ONE" in html)
check("cards show the style name", "club-swag" in html)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
