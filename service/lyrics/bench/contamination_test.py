#!/usr/bin/env python3
"""Golden tests for the contamination split (FMS WS1 / M5).

Run:  python3 service/lyrics/bench/contamination_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import contamination as C  # noqa: E402
from lyrics.bench.metrics import FAME_THRESHOLD  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


SONGS = [
    {"songId": "gs:new-small", "views": 900, "year": 2024, "source": "genius-scrape"},
    {"songId": "gs:new-huge", "views": 5_000_000, "year": 2024, "source": "genius-scrape"},
    {"songId": "gd:old-small", "views": 800, "year": 2016, "source": "genius"},
    {"songId": "gd:old-huge", "views": 9_000_000, "year": 2011, "source": "genius"},
    {"songId": "gs:noyear", "views": 10, "year": 0, "source": "genius-scrape"},
]
IDX = C.song_index(SONGS)

check("split: recent AND low-view is obscure", C.split_of(IDX["gs:new-small"]) == "obscure")
check("split: recent but CHARTING is famous — a year-only rule would miss this",
      C.split_of(IDX["gs:new-huge"]) == "famous")
check("split: old and low-view is famous (pretraining had years to see it)",
      C.split_of(IDX["gd:old-small"]) == "famous")
check("split: old and huge is famous", C.split_of(IDX["gd:old-huge"]) == "famous")
check("split: no year ⇒ unknown, never credited to obscure",
      C.split_of(IDX["gs:noyear"]) == "unknown")
check("split: a song absent from the corpus is unknown, not obscure",
      C.split_of(IDX.get("gs:missing")) == "unknown")
check("split: the threshold is SHARED with metrics, not re-declared",
      C.FAME_THRESHOLD is FAME_THRESHOLD)

ROWS = [
    {"itemId": "a", "songId": "gs:new-small", "granularity": "rhyme", "exact": 1,
     "topk": 1, "views": 900},
    {"itemId": "b", "songId": "gs:new-small", "granularity": "rhyme", "exact": 0,
     "topk": 1, "views": 900},
    {"itemId": "c", "songId": "gd:old-huge", "granularity": "rhyme", "exact": 1,
     "topk": 1, "views": 9_000_000},
    {"itemId": "d", "songId": "gs:noyear", "granularity": "rhyme", "exact": 1,
     "topk": 1, "views": 10},
]
C.annotate(ROWS, IDX)
agg = C.aggregate_by_contamination(ROWS)
check("annotate: every row is stamped",
      [r["contamination"] for r in ROWS] == ["obscure", "obscure", "famous", "unknown"],
      str([r["contamination"] for r in ROWS]))
check("aggregate: obscure bucket has n=2 and exact=0.5",
      agg["splits"]["obscure"]["n"] == 2
      and abs(agg["splits"]["obscure"]["rhyme"]["exact"] - 0.5) < 1e-9,
      str(agg["splits"]["obscure"]))
check("aggregate: famous bucket is reported separately",
      agg["splits"]["famous"]["n"] == 1
      and agg["splits"]["famous"]["rhyme"]["exact"] == 1.0)
check("aggregate: unknown is reported, not folded into either",
      agg["splits"]["unknown"]["n"] == 1)
check("aggregate: the split is versioned and states its thresholds",
      agg["version"] and agg["recentYear"] and agg["fameThreshold"])
# Fixture adequacy: the buckets must actually DIFFER here, or an aggregate that
# ignored the split entirely would look identical.
check("fixture: the two buckets have different exact scores (so the split bites)",
      agg["splits"]["obscure"]["rhyme"]["exact"]
      != agg["splits"]["famous"]["rhyme"]["exact"])
check("aggregate: an empty bucket reports n=0 rather than crashing",
      C.aggregate_by_contamination([])["splits"]["famous"]["n"] == 0)

# ---- integration: the REAL scored row must carry the join key ----
# The hand-built rows above all have songId, so they cannot catch its ABSENCE.
# It was absent: metrics.score_item did not emit it, and every row bucketed as
# "unknown" — the whole split reading as no-data while looking healthy.
from lyrics.bench import metrics as _m  # noqa: E402
from lyrics.bench._testlex import make_pron as _mp  # noqa: E402

_real_row = _m.score_item(
    {"itemId": "v2:rhyme:gs:new-small:s0:l0", "granularity": "rhyme",
     "songId": "gs:new-small", "views": 900,
     "target": {"text": "grind"}, "context": {"maskedLine": "up from the ____"},
     "constraints": {"syllables": 1, "syllableTol": 0, "rhymeWith": "mind",
                     "rhymeStrictness": "slant"}},
    ["grind"], _mp())
check("integration: the real scored row carries songId",
      _real_row.get("songId") == "gs:new-small", str(sorted(_real_row)))
C.annotate([_real_row], IDX)
check("integration: a real row buckets to a REAL split, not 'unknown'",
      _real_row["contamination"] == "obscure", _real_row["contamination"])

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
