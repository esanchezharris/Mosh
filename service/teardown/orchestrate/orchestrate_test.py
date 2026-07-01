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

# ── render + score stages (injected fakes; the REAL §9 execute / §12 reward are covered on the
#    binary by teardown_e2e.py / system_smoke.py — here we prove the orchestrator RUNS them) ──
def fake_render(rec):
    rec.yield_.actual = R.YieldScores(overall=0.9, drums=0.9, arrangement=0.9)
    rec.reconstruction_class = R.ReconstructionClass.inferred
    return {"nonsilent": True, "rms": 0.2, "yield": {"overall": 0.9}, "out_wav": "/tmp/recon.wav"}


def fake_reward(rec, render_out):
    assert render_out.get("out_wav")            # the score stage receives the render summary
    return {"pull": 0.6, "composite": 0.7}


with tempfile.TemporaryDirectory() as td:
    orc = Orchestrator(policy=Policy(), checkpoint_dir=td, skeleton_fn=fake_skeleton,
                       extract_fn=fake_extract, match_fn=fake_match, compile_fn=compile_recipe,
                       render_fn=fake_render, reward_fn=fake_reward)
    res = orc.teardown("vidR")
    check("render+score stages run when injected",
          res.stages_done == ["skeleton", "extract", "match", "compile", "render", "score"],
          str(res.stages_done))
    check("RunResult.render populated (§9 executed)",
          res.render.get("nonsilent") and res.render.get("out_wav"), str(res.render))
    check("RunResult.reward populated (§12 scored)", res.reward.get("pull") is not None, str(res.reward))
    check("render wrote yield.actual onto the recipe", res.recipe.yield_.actual.overall == 0.9)

# ── score SKIPS when the render produced no audio (nothing to score) ──────────
reward_calls: list = []


def silent_render(rec):
    return {"nonsilent": False, "rms": 0.0, "out_wav": "/tmp/s.wav"}


def counting_reward(rec, render_out):
    reward_calls.append(1)
    return {"pull": 0.1}


sr2 = Orchestrator(skeleton_fn=fake_skeleton, match_fn=fake_match, compile_fn=compile_recipe,
                   render_fn=silent_render, reward_fn=counting_reward).teardown("vidS")
check("silent render → score stage skipped (no reward call)",
      "render" in sr2.stages_done and "score" not in sr2.stages_done and not reward_calls,
      str(sr2.stages_done))

# ── resume after a render-only run STILL runs score (render_out reloaded from the checkpoint) ──
with tempfile.TemporaryDirectory() as td3:
    common = dict(checkpoint_dir=td3, skeleton_fn=fake_skeleton, extract_fn=fake_extract,
                  match_fn=fake_match, compile_fn=compile_recipe, render_fn=fake_render)
    Orchestrator(**common).teardown("vidRR")                 # run 1: render, NO reward_fn → score never ran
    got: dict = {}

    def resume_reward(rec, render_out):
        got["out_wav"] = render_out.get("out_wav")           # proves render_out survived the checkpoint
        return {"pull": 0.5, "composite": 0.6}

    res3 = Orchestrator(reward_fn=resume_reward, **common).teardown("vidRR", resume=True)
    check("resume after render-only fires score from the checkpointed render_out (was skipped before)",
          "score" in res3.stages_done and res3.reward.get("pull") == 0.5 and got.get("out_wav") == "/tmp/recon.wav",
          str((res3.stages_done, res3.reward, got)))

# ── back-compat: no render_fn → the run stops at compile (prior behaviour) ────
nr = Orchestrator(skeleton_fn=fake_skeleton, match_fn=fake_match, compile_fn=compile_recipe).teardown("vidN")
check("no render_fn → stops at compile (no render/score stage)",
      nr.stages_done == ["skeleton", "extract", "match", "compile"] and not nr.render and not nr.reward,
      str(nr.stages_done))

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
