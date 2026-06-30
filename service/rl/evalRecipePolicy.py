#!/usr/bin/env python3
"""Eval a local policy adapter with the RECIPE reward — did SFT-distill teach it to write beats?

Greedy-generate one completion per note-eliciting prompt, score each with the deterministic
recipe verifier (scoreRolloutsRecipe.mts), and report mean reward + deferral rate. Run it on
owner-v1 (the deferring baseline) vs beat-v0 (post-distillation) on the SAME prompts to see
whether the local model now emits full note-bearing beats instead of deferring.

  HF_HUB_OFFLINE=1 service/sft/.venv/bin/python service/rl/evalRecipePolicy.py \
      --adapter service/sft/.adapters/beat-v0 --rl-data service/sft/.rl-data/rl-beat-v1 \
      --n 12 --max-new-tokens 1400
"""
import argparse
import json
import os
import sys
from pathlib import Path

os.environ["MOSH_RL_REWARD"] = "recipe"  # before importing grpo (sets SCORER_SCRIPT)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import grpo  # noqa: E402  (reuse build_model / load_prompts / generate_completion / score_rollouts)
from mlx_lm.sample_utils import make_sampler  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--rl-data", required=True)
    ap.add_argument("--model", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--max-new-tokens", type=int, default=1400)
    ap.add_argument("--temp", type=float, default=0.0)  # greedy = the deployable policy
    a = ap.parse_args()

    rl = Path(a.rl_data).resolve()
    work = Path(a.adapter).resolve() / "_eval"
    work.mkdir(parents=True, exist_ok=True)

    model, tok = grpo.build_model(a.model, str(Path(a.adapter).resolve()), trainable=False)
    eos = set(tok.eos_token_ids) if getattr(tok, "eos_token_ids", None) else {tok.eos_token_id}
    prompts = grpo.load_prompts(rl / "gate.prompts.jsonl", tok)[: a.n]
    sampler = make_sampler(temp=a.temp)

    rollouts = []
    for p in prompts:
        _, text = grpo.generate_completion(model, tok, p["ids"], sampler, a.max_new_tokens, eos)
        rollouts.append({"exId": p["id"], "sampleId": p["id"], "content": text})
    rewards = grpo.score_rollouts(rl / "rl_train.eval.jsonl", rollouts, work)

    rs = [rewards.get(p["id"], (0.0, True)) for p in prompts]
    vals = [r for r, _ in rs]
    defr = sum(1 for _, d in rs if d) / max(1, len(rs))
    mean = sum(vals) / max(1, len(vals))
    print(json.dumps({
        "adapter": a.adapter, "n": len(prompts), "reward_mean": round(mean, 4),
        "reward_min": round(min(vals), 4), "reward_max": round(max(vals), 4),
        "deferral_rate": round(defr, 3), "rewards": [round(v, 3) for v in vals],
    }, indent=2))


if __name__ == "__main__":
    main()
