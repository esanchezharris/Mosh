#!/usr/bin/env python3
"""Hermetic test for §3 sourcing (FakeSearcher — no network/yt-dlp).

    python3 service/teardown/sourcing/sourcing_test.py   (exit 0 = all pass)

Guards: dedup by video_id, the metadata pre-screen (tutorial kept, reaction skipped),
yield prediction (tutorial > reaction), the CC rank boost (planted pair), license 100%
populated + normalized, the ranked queue order + status transition, and determinism.
"""
import os
import sys
import tempfile
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.sourcing import Catalog, FakeSearcher, Scout, VideoMeta, predict_yield, prescreen  # noqa: E402
from teardown.sourcing.posture import map_license  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


vA = VideoMeta(video_id="aaa", url="u/aaa", title="How to make a TRAP beat from scratch in FL Studio (Serum)",
               channel="BeatLab", duration_s=720, license="youtube",
               description="full tutorial, fl studio, serum, 808s", tags=["trap", "fl studio"],
               chapters=5, has_captions=True)
vR = VideoMeta(video_id="rrr", url="u/rrr", title="Reacting to fire type beats", channel="ReactGuy",
               duration_s=600, license="youtube", description="my reaction to these beats")
vCC = VideoMeta(video_id="ccc", url="u/ccc", title="Drill beat from scratch tutorial", channel="CCBeats",
                duration_s=700, license="creativeCommon", description="start to finish drill tutorial",
                tags=["drill"], chapters=3, has_captions=True)

fake = FakeSearcher({
    "type beat tutorial": [vA, vR],
    "creative commons beat tutorial": [vCC, vA],  # vA repeats → dedup
})

# ── discover + dedup ─────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    cat = Catalog(Path(td) / "cat.sqlite")
    scout = Scout(cat, searcher=fake, clock=lambda: 1000.0)
    added = scout.discover(["type beat tutorial", "creative commons beat tutorial"], max_results=10)
    check("discover added 3 unique (vA dedup'd across templates)", added == 3, str(added))
    check("re-discover adds nothing (dedup by video_id)",
          scout.discover(["type beat tutorial"], 10) == 0)
    check("all discovered", cat.counts().get("discovered") == 3, str(cat.counts()))

    # ── prescreen ─────────────────────────────────────────────────────────────
    scout.prescreen()
    rA, rR, rCC = cat.get("aaa"), cat.get("rrr"), cat.get("ccc")
    check("tutorial kept (screened)", rA.status == "screened")
    check("reaction dropped (skipped)", rR.status == "skipped", rR.status)
    check("CC tutorial kept (screened)", rCC.status == "screened")
    check("tutorial outscores reaction (prescreen)", rA.prescreen_score > rR.prescreen_score,
          f"{rA.prescreen_score} vs {rR.prescreen_score}")
    check("tutorial yield.overall > reaction", (rA.yield_overall or 0) > (rR.yield_overall or 0))

    # ── ranked queue + status transition ───────────────────────────────────────
    picked = cat.queue(2, min_overall=0.0)
    check("queue returns the 2 kept tutorials", {v.video_id for v in picked} == {"aaa", "ccc"},
          str([v.video_id for v in picked]))
    check("queue is ordered by overall desc",
          all((picked[i].yield_overall or 0) >= (picked[i + 1].yield_overall or 0) for i in range(len(picked) - 1)))
    check("queued rows transitioned to 'queued'", cat.get("aaa").status == "queued")
    check("reaction never queued", cat.get("rrr").status == "skipped")

# ── CC rank boost (planted pair: identical signals, different license) ────────
sig = prescreen(vCC).signals
y_cc = predict_yield(sig, "creativeCommon")
y_yt = predict_yield(sig, "youtube")
check("CC sources get an overall boost", y_cc["overall"] > y_yt["overall"], f"{y_cc['overall']} vs {y_yt['overall']}")

# ── license normalization (100% populated, never empty) ──────────────────────
check("license maps CC string", map_license("Creative Commons Attribution license (reuse allowed)") == "creativeCommon")
check("license maps absent → unknown", map_license(None) == "unknown")
check("license maps other → youtube", map_license("Standard YouTube License") == "youtube")

# ── determinism ──────────────────────────────────────────────────────────────
scores = {(prescreen(vA).score, predict_yield(prescreen(vA).signals, "youtube")["overall"]) for _ in range(3)}
check("prescreen + yield deterministic x3", len(scores) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
