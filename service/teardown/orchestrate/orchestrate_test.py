#!/usr/bin/env python3
"""Hermetic test for the §10 conductor — injected fake stages (the compile stage is the
REAL §9 compiler), so it exercises the staging/checkpoint/resume/gating logic without any
network/binary.

    python3 service/teardown/orchestrate/orchestrate_test.py
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
from teardown.orchestrate import Orchestrator, Policy  # noqa: E402
from teardown.render.compile import compile_recipe  # noqa: E402  (the real §9 compile stage)

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def fake_skeleton(video_ref):
    return R.Recipe(
        source=R.Source(video_id=video_ref),
        meta=R.Meta(tempo_bpm=R.MetaField(value=140, confidence=0.7)),
        arrangement=R.Arrangement(sections=[R.Section(name="section 1", start_s=0, end_s=8),
                                            R.Section(name="section 2", start_s=8, end_s=16)]),
        elements=[R.Element(element_id="lead0", role="lead",
                            synth_patch=R.SynthPatch(status="unknown", plugin=R.Plugin(name="Serum")))],
    )


def fake_extract(rec, video_ref):
    rec.elements.append(R.Element(element_id="kick0", role="kick", audio_ref="/tmp/kick.wav"))


def fake_match(rec, element_id):
    el = next(e for e in rec.elements if e.element_id == element_id)
    el.sample_match.status = R.SampleStatus.matched
    el.sample_match.matched_path = "lib/kicks/owned.wav"
    el.sample_match.distance = 0.1


# ── full staged run ──────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    orc = Orchestrator(policy=Policy(), checkpoint_dir=td,
                       skeleton_fn=fake_skeleton, extract_fn=fake_extract,
                       match_fn=fake_match, compile_fn=compile_recipe)
    res = orc.teardown("vidA")
    check("all stages ran in order", res.stages_done == ["skeleton", "extract", "match", "compile"],
          str(res.stages_done))
    check("extract added a drum element", any(e.role.value == "kick" for e in res.recipe.elements))
    check("drum element got §1-matched", any(e.sample_match.status == R.SampleStatus.matched
                                             for e in res.recipe.elements))
    check("sections renamed off 'section N'", res.recipe.arrangement.sections[0].name == "intro")
    check("elements labeled", all(e.label for e in res.recipe.elements))
    check("real §9 compile produced commands", len(res.commands) > 0)
    check("status torn_down above the floor", res.status == "torn_down", f"{res.status} c={res.completeness}")
    check("checkpoint files written", (Path(td) / "vidA.recipe.json").exists())

    # ── resume: re-run must NOT re-invoke skeleton (loads from checkpoint) ──────
    def boom(_):
        raise AssertionError("skeleton should not be called on resume")

    orc2 = Orchestrator(policy=Policy(), checkpoint_dir=td,
                        skeleton_fn=boom, extract_fn=fake_extract, match_fn=fake_match, compile_fn=compile_recipe)
    res2 = orc2.teardown("vidA", resume=True)
    check("resume skips completed stages (skeleton not called)", res2.status in ("torn_down", "needs_review"))
    check("resume preserves the matched drum element",
          any(e.sample_match.status == R.SampleStatus.matched for e in res2.recipe.elements))

# ── gating: a sparse recipe → needs_review ───────────────────────────────────
sparse = Orchestrator(policy=Policy(review_floor=0.35),
                      skeleton_fn=lambda v: R.Recipe(elements=[R.Element(element_id="x", role="other")]),
                      extract_fn=None, match_fn=fake_match, compile_fn=compile_recipe)
rs = sparse.teardown("vidB")
check("sparse recipe → needs_review (no confident-but-wrong)", rs.status == "needs_review",
      f"{rs.status} c={rs.completeness}")

# ── failure isolation: a throwing stage → failed status, no crash ────────────
def throw(_):
    raise RuntimeError("skeleton kaboom")

bad = Orchestrator(skeleton_fn=throw, match_fn=fake_match, compile_fn=compile_recipe)
rb = bad.teardown("vidC")
check("a throwing stage → status failed, error set, no crash", rb.status == "failed" and bool(rb.error))

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
