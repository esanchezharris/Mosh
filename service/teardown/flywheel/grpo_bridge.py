#!/usr/bin/env python3
"""§12 → GRPO bridge — the handoff surface for the EXTERNAL audio-taste RL trainer.

The GRPO trainer itself is external (it optimizes the command-emitting agent against this reward; see
the audio-taste RL handoff). This module is the ONLY thing it imports from the teardown lane:

  1. `make_reward()` — the ACTIVATED reward. Returns a §12 `Reward` whose `pull` is the validated
     composite [raw-MuQ timbre]+[learned timing] head (beats raw CLAP on every axis, held-out-by-source,
     artifact-controlled). Floor-only graceful fallback if the artifact/venv is absent. This is the
     `MOSH_RL_REWARD=audio` seam: the trainer scores a rendered rollout WAV via `reward.score_audio(y,sr)`
     then `reward.composite(scores)` (or uses the raw components — see the clean-gate note below).
  2. `reward_example(program, scores, ...)` + `append_rewards_jsonl(...)` — emit reward-LABELLED rollouts
     to `rewards.jsonl` (offline warm-start / logging). Each line carries the gated `composite` AND the
     raw components {pq, clean, pull} so the trainer isn't limited to the gated scalar.
  3. `seed_promptfeed(programs)` — a `PromptFeed` of guaranteed-renderable §9-compiled command sequences
     (the policy's base prompt distribution; fixes "ops on empty tracks render to silence").

CLEAN-GATE NOTE (honest): `Reward.composite = clean·(0.5·pq/10 + 0.5·pull)` — the floor's BINARY `clean`
gate (Audiobox PQ flags) zeros the composite for sparse/drum-only content even when `pull` discriminates
well. So for drum-loop targets the trainer should read the `pull`/`components` directly; for full
arrangements `clean→1` and the composite flows. The emitter always logs both.

    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/grpo_bridge.py \
        --results run1.json run2.json --out ~/grpo-bridge   # → rewards.jsonl + promptfeed.json
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# NB: teardown.flywheel.reward (the AUDIO path) is imported lazily inside the functions that
# need it — it pulls numpy/oracle.score, which the deterministic recipe reward does NOT need, so
# the MOSH_RL_REWARD=recipe path runs with zero audio deps.
from teardown.flywheel.recipe_verifier import recipe_from_program, verify_recipe  # noqa: E402

# Which reward the trainer maximizes. "audio" = the §12 composite over a rendered WAV (the
# original seam; pull validity is unproven — the probe found ρ≈0 vs owner taste). "recipe" =
# the DETERMINISTIC verifier over the rollout's symbolic DNA — no render, no GPU, no venv, and
# a VALID target (hardened: ranks good>bad, all 24 red-team exploits <0.7, parity-pinned to the
# TS verifier). The owner's reframe (2026-06-29): grade the recipe (the parts), not the audio.
REWARD_KIND = os.environ.get("MOSH_RL_REWARD", "audio").strip().lower()


def score_program_recipe(program: list, key: dict | None = None, bars: int | None = None) -> dict:
    """The RECIPE reward: reconstruct the recipe from a rollout's MoshOps program and grade its
    musical DNA deterministically. Pure — no render, no audio deps. Returns {recipe_reward 0..1,
    recipe_dims, recipe_reasons}. This is the `MOSH_RL_REWARD=recipe` scalar the trainer maximizes."""
    recipe = recipe_from_program(program, bars=bars)
    if key:
        recipe["key"] = {"tonic": key.get("tonic", recipe["key"]["tonic"]), "mode": key.get("mode", recipe["key"]["mode"])}
    v = verify_recipe(recipe)
    return {"recipe_reward": v["total"], "recipe_dims": v["dims"], "recipe_reasons": v["reasons"]}


def make_reward(prefer_composite: bool = True):
    """The ACTIVATED reward for the GRPO loop. Composite pull when the artifact+venv are present,
    else the floor-only Reward (never crashes the trainer). Returns (Reward, info_dict)."""
    from teardown.flywheel.reward import Reward  # lazy: pulls numpy/oracle.score (audio path only)
    pull, version, kind = None, "reward-v0", "floor-only"
    if prefer_composite:
        try:
            from teardown.flywheel.reward_encoder import CompositeRewardHead
            if CompositeRewardHead.available():
                head = make_reward._head = CompositeRewardHead()   # cache on the fn so exemplars persist
                pull, version, kind = head.pull, head.version, "composite"
        except Exception as e:
            print(f"[grpo_bridge] composite head unavailable ({type(e).__name__}) → floor-only",
                  file=sys.stderr)
    return Reward(pull=pull, version=version), {"kind": kind, "version": version, "has_pull": pull is not None}


def reward_example(program: list, scores: dict, source: str = "", example_id: str = "") -> dict:
    """One reward-LABELLED rollout for rewards.jsonl. `program` = the §9-compiled MoshOps command
    sequence (what the policy emits); `scores` = Reward.score_audio output (+ composite/has_pull).

    The maximized scalar `reward` switches on MOSH_RL_REWARD: in "recipe" mode it's the
    deterministic verifier over the program's DNA (auto-scored here if not pre-supplied — needs
    no audio venv); in "audio" mode it's the gated composite (legacy). Both are always logged."""
    rr = scores.get("recipe_reward")
    if REWARD_KIND == "recipe" and rr is None:             # auto-score the DNA from the program
        rr = score_program_recipe(program).get("recipe_reward")
    comp = scores.get("composite")
    if comp is None and any(k in scores for k in ("clean", "pq", "pull")):  # raw audio score dict
        comp = round(float(scores.get("clean", 1.0)) *
                     (0.5 * min(1.0, scores.get("pq", 0.0) / 10.0) + 0.5 * scores.get("pull", 0.0)), 4)
    reward = rr if (REWARD_KIND == "recipe" and rr is not None) else comp
    eid = example_id or hashlib.sha1((source + json.dumps(program, sort_keys=True)).encode()).hexdigest()[:16]
    out = {
        "id": eid,
        "program": program,                                # list[{command,args}] — the rollout
        "reward": reward,                                  # the scalar the trainer maximizes
        "reward_kind": REWARD_KIND,
        "components": {k: scores.get(k) for k in ("pq", "clean", "pull", "composite") if k in scores},
        "has_pull": bool(scores.get("has_pull", scores.get("pull") is not None)),
        "reward_version": scores.get("version", ""),
        "source": source,
    }
    if rr is not None:
        out["recipe_reward"] = rr
    return out


def append_rewards_jsonl(records: list, path: str) -> int:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    return len(records)


def seed_promptfeed(programs: list):
    """Flatten a list of §9-compiled command-programs into one renderable prompt distribution."""
    from teardown.flywheel.reward import PromptFeed  # lazy (audio-lane dep)
    flat = [cmd for prog in programs for cmd in prog]
    return PromptFeed(flat)


def save_promptfeed(pf: PromptFeed, path: str) -> int:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    prompts = pf.renderable_prompts(10 ** 9)
    json.dump(prompts, open(path, "w"), indent=1)
    return len(prompts)


def _program_of(result: dict) -> list:
    """Best-effort: pull the compiled MoshOps program out of an orchestrator result (commands, or
    compile the recipe via §9)."""
    if isinstance(result.get("commands"), list):
        return result["commands"]
    rec = result.get("recipe")
    if rec:
        try:
            from teardown.render.compile import compile_recipe
            return compile_recipe(rec).get("commands", [])
        except Exception:
            pass
    return []


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="§12→GRPO bridge: build rewards.jsonl + promptfeed.json from teardown results")
    ap.add_argument("--results", nargs="*", default=[], help="orchestrator result JSON files (each {recipe|commands, reward})")
    ap.add_argument("--out", required=True, help="output dir for rewards.jsonl + promptfeed.json")
    ns = ap.parse_args(argv)

    print(f"  MOSH_RL_REWARD={REWARD_KIND}")
    if REWARD_KIND != "recipe":
        rw, info = make_reward()
        print(f"  audio reward seam: {info}")
    records, programs = [], []
    for rp in ns.results:
        try:
            res = json.load(open(rp))
        except Exception as e:
            print(f"  skip {rp}: {type(e).__name__}", file=sys.stderr)
            continue
        prog = _program_of(res)
        if prog:
            programs.append(prog)
        scores = res.get("reward") or res.get("scores") or {}
        # recipe mode needs no audio scores — it grades the program's DNA directly
        if prog and (scores or REWARD_KIND == "recipe"):
            records.append(reward_example(prog, scores, source=res.get("url", rp)))
    rj = os.path.join(ns.out, "rewards.jsonl")
    pf = os.path.join(ns.out, "promptfeed.json")
    n_r = append_rewards_jsonl(records, rj) if records else 0
    n_p = save_promptfeed(seed_promptfeed(programs), pf) if programs else 0
    print(f"  wrote {n_r} reward-labelled rollouts → {rj}")
    print(f"  wrote PromptFeed of {n_p} renderable commands → {pf}")
    if REWARD_KIND == "recipe":
        print("  EXTERNAL GRPO contract (recipe): `from teardown.flywheel.grpo_bridge import score_program_recipe` "
              "then per rollout: `score_program_recipe(program)['recipe_reward']` — deterministic, no render.")
    else:
        print("  EXTERNAL GRPO contract (audio): `from teardown.flywheel.grpo_bridge import make_reward; rw,_=make_reward()` "
              "then per rollout WAV: `rw.composite(rw.score_audio(y, sr))`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
