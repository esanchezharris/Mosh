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

from teardown import recipe as R  # noqa: E402
from teardown.sourcing import Catalog, FakeSearcher, Scout, VideoMeta, predict_yield, prescreen  # noqa: E402
from teardown.sourcing.posture import map_license  # noqa: E402
from teardown.sourcing.score import predicted_from_skeleton, validate_yield  # noqa: E402

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

# ── §3 yield.predicted from skeleton signals (direct-URL teardown path) ───────
src_tut = {"title": "How to make a TRAP beat from scratch (Serum)", "license": "youtube"}
ms = {"daw": "FL Studio", "plugins": ["Serum", "Vital"], "pianoroll": True}
pred = predicted_from_skeleton(src_tut, ms)
check("predicted_from_skeleton yields all 5 fields in [0,1]",
      set(pred) == {"drums", "midi", "synth", "arrangement", "overall"}
      and all(0.0 <= v <= 1.0 for v in pred.values()), str(pred))
plain = predicted_from_skeleton({"title": "random vlog", "license": "youtube"}, {})
check("a tutorial (daw+plugins) predicts higher overall than a non-tutorial",
      pred["overall"] > plain["overall"], f"{pred['overall']} vs {plain['overall']}")
check("predicted_from_skeleton deterministic x3",
      len({predicted_from_skeleton(src_tut, ms)["overall"] for _ in range(3)}) == 1)

# ── validate_yield: the honesty guard (predicted vs actual) ───────────────────
rosy = {"drums": 0.9, "midi": 0.9, "synth": 0.9, "arrangement": 0.9, "overall": 0.9}
weak = {"drums": 0.3, "midi": 0.0, "synth": 0.1, "arrangement": 0.5, "overall": 0.25}
v_over = validate_yield(rosy, weak)
check("predicted >> actual → overconfident (not a silent pass)",
      v_over["status"] == "overconfident" and v_over["overconfident"], str(v_over.get("status")))
check("overconfident reports the overall delta + worst axis",
      v_over["overall_delta"] == 0.65 and v_over["worst_field"] in ("midi", "synth"), str(v_over))
close = {"drums": 0.5, "midi": 0.4, "synth": 0.3, "arrangement": 0.6, "overall": 0.45}
v_ok = validate_yield({"drums": 0.5, "midi": 0.5, "synth": 0.4, "arrangement": 0.6, "overall": 0.5}, close)
check("predicted ≈ actual → calibrated, not flagged",
      v_ok["status"] == "calibrated" and not v_ok["overconfident"], str(v_ok.get("status")))
check("actual >> predicted → NOT flagged (recovered more than expected)",
      not validate_yield(close, rosy)["overconfident"])
check("no prediction → unscored", validate_yield({}, weak)["status"] == "unscored")
check("not executed (rendered=False) → unrendered", validate_yield(rosy, {}, rendered=False)["status"] == "unrendered")
check("RAN but produced nothing (rendered=True, actual all-zero) → overconfident, NOT 'unrendered'",
      validate_yield(rosy, {}, rendered=True)["status"] == "overconfident", str(validate_yield(rosy, {}, rendered=True)))
check("validate_yield accepts a YieldScores object (not just dict)",
      validate_yield(R.YieldScores(**rosy), R.YieldScores(**weak))["overconfident"] is True)

# ── determinism ──────────────────────────────────────────────────────────────
scores = {(prescreen(vA).score, predict_yield(prescreen(vA).signals, "youtube")["overall"]) for _ in range(3)}
check("prescreen + yield deterministic x3", len(scores) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
