#!/usr/bin/env python3
"""Rung-1 GRPO trainer — on-device (mlx) RL for the command-emitting agent.

Closes the loop the teardown thread named as its handoff: a local Qwen3-4B LoRA
*policy* is optimized by group-relative policy gradient against a *reward*. In Rung 1
the reward is the deterministic clean-apply verifier (ui/src/rl + gepa/metric, scored
via a node subprocess) — no audio, fully reproducible — so we prove the RL machinery
and attack the SFT residual gaps (acts-shy / wrong-command) cheaply. Rung 2 swaps the
reward for the teardown `Reward` (floor + MERT pull over rendered audio) WITHOUT
touching this trainer: the reward is external (a subprocess contract), the policy and
the GRPO update are reused verbatim.

GRPO (DeepSeekMath, no value net): for each prompt q, sample G completions o_1..o_G
from the current policy; reward r_i each; group-normalize the advantage
A_i = (r_i - mean)/(std+eps); update with the token-level objective
  J = mean_i mean_t [ A_i * logπ_θ(o_{i,t}) - β · KL(π_θ‖π_ref) ]
KL is the k3 estimator vs a frozen π_ref (the SFT adapter) — the leash that keeps the
policy from drifting / reward-hacking. We sample and take one on-policy update, so the
importance ratio is 1 and the surrogate is the plain policy gradient.

Serve evals OFFLINE (HF_HUB_OFFLINE=1) so the served tokenizer == the training base —
the documented mlx tokenizer gotcha that silently inflates scores otherwise.

  python service/rl/grpo.py \
    --rl-data service/sft/.rl-data/rl-v1 \
    --sft-adapter service/sft/.adapters/v2 \
    --out service/sft/.adapters/rl-v1 \
    [--iters 150 --prompts-per-step 4 --group-size 6 --lr 1e-6 --beta 0.04 \
     --temp 0.9 --max-new-tokens 200 --eval-every 25 --gate-n 120 --smoke]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten, tree_map

from mlx_lm.utils import load
from mlx_lm.tuner.utils import load_adapters, print_trainable_parameters
from mlx_lm.generate import generate_step
from mlx_lm.sample_utils import make_sampler

REPO = Path(__file__).resolve().parents[2]
UI = REPO / "ui"
TSX = UI / "node_modules" / ".bin" / "tsx"

# Reward seam (the prime directive: swap the reward WITHOUT touching the trainer). Both
# scorer scripts read the SAME rollouts.jsonl and write the SAME {sampleId,reward,deferred}
# lines — only the implementation differs. MOSH_RL_REWARD=audio → Rung-2 (render each
# rollout to WAV, score with the teardown Reward); default → Rung-1 (symbolic clean-apply).
SCORER_SCRIPT = (
    "scripts/rl/scoreRolloutsAudio.mts"
    if os.environ.get("MOSH_RL_REWARD") == "audio"
    else "scripts/rl/scoreRollouts.mts"
)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ── model setup ──────────────────────────────────────────────────────────────
def build_model(model_id: str, sft_adapter: str, trainable: bool):
    """Base (frozen, quantized) + LoRA initialized from the SFT adapter. For the
    policy the LoRA is trainable; for the reference everything is frozen."""
    model, tok = load(model_id)
    model.freeze()
    load_adapters(model, sft_adapter)  # linear_to_lora_layers (unfreezes LoRA) + load SFT weights
    if not trainable:
        model.freeze()
        model.eval()
    else:
        model.train()
    return model, tok


# ── generation ───────────────────────────────────────────────────────────────
def generate_completion(model, tok, prompt_ids, sampler, max_new, eos_ids):
    """Sample one completion; return (token_ids:list[int], text:str)."""
    out = []
    for tokens, _ in generate_step(mx.array(prompt_ids), model, max_tokens=max_new, sampler=sampler):
        t = int(tokens.item()) if hasattr(tokens, "item") else int(tokens)
        if t in eos_ids:
            break
        out.append(t)
    text = tok.decode(out) if out else ""
    return out, text


# ── log-probs of a completion under a model ──────────────────────────────────
def seq_logprobs(model, prompt_ids, comp_ids):
    """Per-token logπ of the completion tokens given the prompt as context. (C,)."""
    P, C = len(prompt_ids), len(comp_ids)
    seq = mx.array(list(prompt_ids) + list(comp_ids))[None]  # (1, P+C)
    logits = model(seq[:, :-1])                              # (1, P+C-1, V)
    logits_c = logits[:, P - 1 : P + C - 1, :]               # logits predicting completion tokens
    targets = mx.array(list(comp_ids))[None]                 # (1, C)
    logp = -nn.losses.cross_entropy(logits_c, targets, reduction="none")  # (1, C)
    return logp[0]


# ── reward bridge (node scorer over the SAME verifier as SFT eval) ───────────
def score_rollouts(eval_path: Path, rollouts, workdir: Path):
    """rollouts: list of dicts {exId, sampleId, content}. Returns {sampleId: (reward, deferred)}."""
    rpath = workdir / "rollouts.jsonl"
    opath = workdir / "rewards.jsonl"
    rpath.write_text("\n".join(json.dumps(r) for r in rollouts) + "\n")
    subprocess.run(
        [str(TSX), SCORER_SCRIPT, "--eval", str(eval_path), "--rollouts", str(rpath), "--out", str(opath)],
        cwd=str(UI), check=True, stdout=subprocess.DEVNULL,
    )
    out = {}
    for line in opath.read_text().splitlines():
        if not line.strip():
            continue
        o = json.loads(line)
        out[o["sampleId"]] = (float(o["reward"]), bool(o.get("deferred")))
    return out


# ── gate eval (greedy generation → SAME offline evalSft --replies) ───────────
def gate_eval(model, tok, gate_prompts, eval_by_id, workdir: Path, tag: str, max_new, eos_ids):
    # Score ONLY the prompts we actually generate for — write a matching eval subset,
    # else evalSft treats the un-replied gate examples as (false) deferrals.
    sub_eval = workdir / f"gate_eval.{tag}.jsonl"
    sub_eval.write_text("\n".join(eval_by_id[p["id"]] for p in gate_prompts) + "\n")
    greedy = make_sampler(temp=0.0)
    replies = []
    for p in gate_prompts:
        _, text = generate_completion(model, tok, p["ids"], greedy, max_new, eos_ids)
        replies.append({"id": p["id"], "content": text})
    rp = workdir / f"gate_replies.{tag}.jsonl"
    rp.write_text("\n".join(json.dumps(r) for r in replies) + "\n")
    subprocess.run(
        [str(TSX), "scripts/evalSft.mts", "--eval", str(sub_eval), "--replies", str(rp), "--tag", f"rl_{tag}"],
        cwd=str(UI), check=True, stdout=subprocess.DEVNULL,
    )
    res = json.loads((workdir / f"eval_results.rl_{tag}.json").read_text())
    return float(res.get("cleanApply", 0.0)), int(res.get("deferrals", 0))


def save_adapter(model, out_dir: Path, sft_adapter: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    weights = dict(tree_flatten(model.trainable_parameters()))
    mx.save_safetensors(str(out_dir / "adapters.safetensors"), weights)
    shutil.copy(sft_adapter / "adapter_config.json", out_dir / "adapter_config.json")


def load_prompts(path: Path, tok):
    """prompts.jsonl: {id, messages:[{role,content}]} → {id, ids:[int]}."""
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        o = json.loads(line)
        ids = tok.apply_chat_template(o["messages"], add_generation_prompt=True, tokenize=True)
        out.append({"id": o["id"], "ids": list(ids)})
    return out


def main():
    ap = argparse.ArgumentParser(description="Rung-1 GRPO trainer (mlx, clean-apply reward)")
    ap.add_argument("--rl-data", required=True, help="dir from buildRlPrompts (rl_train.prompts/eval + gate.*)")
    ap.add_argument("--sft-adapter", default="service/sft/.adapters/v2", help="SFT LoRA dir (π_ref + π_θ init)")
    ap.add_argument("--model", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    ap.add_argument("--out", default="service/sft/.adapters/rl-v1")
    ap.add_argument("--iters", type=int, default=150)
    ap.add_argument("--prompts-per-step", type=int, default=4)
    ap.add_argument("--group-size", type=int, default=6)
    ap.add_argument("--lr", type=float, default=1e-6)
    ap.add_argument("--beta", type=float, default=0.04, help="KL leash to π_ref")
    ap.add_argument("--temp", type=float, default=0.9)
    ap.add_argument("--max-new-tokens", type=int, default=200)
    ap.add_argument("--eval-every", type=int, default=25)
    ap.add_argument("--gate-n", type=int, default=120, help="gate subsample per periodic eval (0=all)")
    ap.add_argument("--kl-log-every", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="tiny run to validate the machinery")
    a = ap.parse_args()

    if a.smoke:
        a.iters, a.prompts_per_step, a.group_size, a.eval_every, a.gate_n, a.max_new_tokens = 2, 2, 3, 2, 8, 96

    mx.random.seed(a.seed)
    # absolute paths — the node subprocesses (scorer / evalSft) run with cwd=ui
    rl_dir = Path(a.rl_data).resolve()
    sft_adapter = Path(a.sft_adapter).resolve()
    out_dir = Path(a.out).resolve()
    work = out_dir / "_work"
    work.mkdir(parents=True, exist_ok=True)
    rl_eval_path = rl_dir / "rl_train.eval.jsonl"
    gate_eval_path = rl_dir / "gate.eval.jsonl"

    reward_kind = "audio (Rung-2: render→teardown Reward)" if os.environ.get("MOSH_RL_REWARD") == "audio" else "symbolic (Rung-1: clean-apply)"
    log(f"▶ GRPO — model={a.model} sft={sft_adapter}")
    log(f"  reward = {reward_kind}  [{SCORER_SCRIPT}]")
    log(f"  loading policy (trainable) + reference (frozen)…")
    policy, tok = build_model(a.model, str(sft_adapter), trainable=True)
    ref, _ = build_model(a.model, str(sft_adapter), trainable=False)
    print_trainable_parameters(policy)
    eos_ids = set(tok.eos_token_ids) if getattr(tok, "eos_token_ids", None) else {tok.eos_token_id}

    log("  tokenizing prompts…")
    rl_prompts = load_prompts(rl_dir / "rl_train.prompts.jsonl", tok)
    gate_all = load_prompts(rl_dir / "gate.prompts.jsonl", tok)
    gate_by_id = {json.loads(l)["id"]: l for l in gate_eval_path.read_text().splitlines() if l.strip()}
    # deterministic gate subsample (stable across evals → comparable)
    gate_all.sort(key=lambda p: p["id"])
    gate_sub = gate_all[: a.gate_n] if a.gate_n and a.gate_n < len(gate_all) else gate_all
    log(f"  rl-train prompts: {len(rl_prompts)} | gate subsample: {len(gate_sub)}/{len(gate_all)}")

    sampler = make_sampler(temp=a.temp)
    opt = optim.Adam(learning_rate=a.lr)

    # baseline gate (the SFT π_ref, honest, correct-tokenizer)
    log("  baseline gate eval (SFT π_ref)…")
    base_score, base_def = gate_eval(policy, tok, gate_sub, gate_by_id, work, "baseline", a.max_new_tokens, eos_ids)
    log(f"  BASELINE clean-apply={base_score:.3f} ({base_def} deferrals / {len(gate_sub)})")

    history = [{"step": 0, "tag": "baseline", "gate_cleanapply": base_score, "gate_deferrals": base_def}]
    best_score, best_step = base_score, 0
    save_adapter(policy, out_dir, sft_adapter)  # checkpoint init (== SFT) so --out is always loadable

    # shuffle a stream of prompt indices
    order = list(range(len(rl_prompts)))
    rng = mx.random.key(a.seed)
    cursor = 0

    def next_prompts(n):
        nonlocal cursor, order
        picks = []
        for _ in range(n):
            if cursor >= len(order):
                # reshuffle deterministically
                perm = mx.random.permutation(mx.array(order), stream=mx.cpu)
                order = [int(x) for x in perm.tolist()]
                cursor = 0
            picks.append(rl_prompts[order[cursor]])
            cursor += 1
        return picks

    loss_and_grad = nn.value_and_grad(policy, lambda pids, cids, adv, ref_lp: _loss(policy, pids, cids, adv, ref_lp, a.beta))

    t0 = time.time()
    for step in range(1, a.iters + 1):
        prompts = next_prompts(a.prompts_per_step)
        # 1) sample G completions per prompt
        samples = []
        for pi, p in enumerate(prompts):
            for gi in range(a.group_size):
                ids, text = generate_completion(policy, tok, p["ids"], sampler, a.max_new_tokens, eos_ids)
                samples.append({"exId": p["id"], "groupIdx": pi, "sampleId": f"{step}_{pi}_{gi}", "prompt_ids": p["ids"], "comp_ids": ids, "content": text})

        # 2) reward (external verifier)
        rewards = score_rollouts(rl_eval_path, [{"exId": s["exId"], "sampleId": s["sampleId"], "content": s["content"]} for s in samples], work)
        for s in samples:
            r, d = rewards.get(s["sampleId"], (0.0, True))
            s["reward"], s["deferred"] = r, d

        # 3) group-relative advantages
        groups = {}
        for s in samples:
            groups.setdefault(s["groupIdx"], []).append(s)
        signal_groups = 0
        for g in groups.values():
            rs = [s["reward"] for s in g]
            mean = sum(rs) / len(rs)
            var = sum((r - mean) ** 2 for r in rs) / len(rs)
            std = var ** 0.5
            if std < 1e-6:
                for s in g:
                    s["adv"] = 0.0
            else:
                signal_groups += 1
                for s in g:
                    s["adv"] = (s["reward"] - mean) / (std + 1e-6)

        # 4) GRPO update (grad-accumulate over samples with non-zero advantage)
        active = [s for s in samples if abs(s["adv"]) > 1e-8 and len(s["comp_ids"]) > 0]
        acc, n = None, 0
        loss_sum = 0.0
        for s in active:
            ref_lp = mx.stop_gradient(seq_logprobs(ref, s["prompt_ids"], s["comp_ids"]))
            mx.eval(ref_lp)
            lv, grads = loss_and_grad(s["prompt_ids"], s["comp_ids"], float(s["adv"]), ref_lp)
            acc = grads if acc is None else tree_map(lambda x, y: x + y, acc, grads)
            n += 1
            loss_sum += float(lv)
            mx.eval(acc)
        if n > 0:
            acc = tree_map(lambda x: x / n, acc)
            opt.update(policy, acc)
            mx.eval(policy.parameters(), opt.state)

        # 5) tripwires
        all_r = [s["reward"] for s in samples]
        mean_r = sum(all_r) / len(all_r)
        frac_def = sum(1 for s in samples if s["deferred"]) / len(samples)
        distinct = len({s["content"] for s in samples}) / len(samples)
        klmsg = ""
        if step % a.kl_log_every == 0 and active:
            kls = []
            for s in active[: min(8, len(active))]:
                pol_lp = seq_logprobs(policy, s["prompt_ids"], s["comp_ids"])
                ref_lp = seq_logprobs(ref, s["prompt_ids"], s["comp_ids"])
                diff = ref_lp - pol_lp
                kls.append(float((mx.exp(diff) - diff - 1.0).mean()))
            klmsg = f" kl={sum(kls)/len(kls):.4f}"
        log(f"  step {step}/{a.iters} reward μ={mean_r:.3f} def={frac_def:.2f} signal={signal_groups}/{len(groups)} distinct={distinct:.2f} loss={loss_sum/max(n,1):.4f}{klmsg} ({(time.time()-t0)/step:.1f}s/step)")

        # 6) periodic gate eval + best-checkpoint
        if step % a.eval_every == 0 or step == a.iters:
            score, deff = gate_eval(policy, tok, gate_sub, gate_by_id, work, f"step{step}", a.max_new_tokens, eos_ids)
            history.append({"step": step, "tag": f"step{step}", "gate_cleanapply": score, "gate_deferrals": deff, "reward_mean": mean_r})
            improved = score > best_score
            log(f"  ── gate@{step}: clean-apply={score:.3f} ({deff} def)  baseline={base_score:.3f}  best={max(best_score,score):.3f}{'  ★ new best' if improved else ''}")
            if improved:
                best_score, best_step = score, step
                save_adapter(policy, out_dir, sft_adapter)

        mx.clear_cache()  # bound Metal buffer growth over a long run

    results = {
        "model": a.model, "sft_adapter": str(sft_adapter),
        "config": {k: getattr(a, k) for k in ["iters", "prompts_per_step", "group_size", "lr", "beta", "temp", "max_new_tokens", "gate_n", "seed"]},
        "baseline_cleanapply": base_score, "best_cleanapply": best_score, "best_step": best_step,
        "improved": best_score > base_score, "history": history,
        "rl_train_prompts": len(rl_prompts), "gate_n": len(gate_sub),
    }
    (out_dir / "rl_results.json").write_text(json.dumps(results, indent=2) + "\n")
    log(f"\n✅ done — baseline {base_score:.3f} → best {best_score:.3f} (step {best_step}); best adapter saved to {out_dir}")
    print(json.dumps({"ok": True, "baseline": base_score, "best": best_score, "best_step": best_step, "improved": results["improved"], "out": str(out_dir)}))


def _loss(policy, prompt_ids, comp_ids, adv, ref_lp, beta):
    pol_lp = seq_logprobs(policy, prompt_ids, comp_ids)  # (C,) with grad
    diff = ref_lp - pol_lp
    kl = mx.exp(diff) - diff - 1.0                         # k3, ≥0
    pg = adv * pol_lp
    return -(pg - beta * kl).mean()


if __name__ == "__main__":
    main()
