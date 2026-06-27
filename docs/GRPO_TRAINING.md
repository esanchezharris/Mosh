# GRPO — RL-tune the local agent against a reward

This is the **culmination rung**: the teardown→reward thread ("Agent YT Ripper") named
its frontier as *"GRPO agent-training = the external audio-taste RL handoff — I train the
REWARD; the loop that optimizes the command-emitting agent is a separate system; Reward +
PromptFeed is the exposed contract."* This is that separate system — the on-device GRPO
loop that fuses **this thread's policy** (the SFT'd Qwen3-4B LoRA) with a **reward**.

It ships in two rungs so the expensive musical reward lands on already-proven machinery:

| | reward | needs | cost |
|---|---|---|---|
| **Rung 1** (here) | clean-apply verifier (`ui/src/rl` → `gepa/metric`), pure-TS, no audio | only the SFT half | cheap, deterministic |
| **Rung 2** (next) | teardown `Reward` (floor + MERT pull over rendered audio) + `PromptFeed` | PR #158 + a trained `reward_head.json` | render-in-the-loop |

The reward is an **external subprocess contract**, so Rung 2 swaps it in without touching
the trainer, the policy, or the GRPO update.

## What GRPO does here

For each prompt q, sample `G` completions from the current policy; score each with the
reward `r_i`; group-normalize the advantage `A_i = (r_i − mean)/(std+ε)`; update with the
token-level objective `mean_i mean_t [ A_i·logπ_θ(o_{i,t}) − β·KL(π_θ‖π_ref) ]`. KL (k3
estimator vs the frozen SFT adapter π_ref) is the **leash** against drift / reward-hacking.
Signal comes from *within-group variance* — exactly the SFT residual failures
(**acts-shy**: a question-phrased ask the model sometimes answers, sometimes defers on;
**wrong-command**), so temperature > 0 is what surfaces the gradient.

## Pieces

| Stage | Code |
|---|---|
| RL-train prompts (balanced, **leakage-filtered** vs the gate) | `ui/src/rl/prompts.ts` + `ui/scripts/rl/buildRlPrompts.mts` |
| Reward seam (one swap-point for Rung 2) | `ui/src/rl/score.ts` (wraps `gepa/metric.scoreReply`) |
| Reward bridge (Python↔TS) | `ui/scripts/rl/scoreRollouts.mts` |
| GRPO trainer (mlx) | `service/rl/grpo.py` |
| DoD compare (SFT vs RL-best, frozen gate) | `service/rl/dod_compare.py` |
| Orchestrator | `service/rl/run_grpo.sh` |

## Run it

```bash
service/rl/run_grpo.sh        # builds RL data → trains → DoD compare
# knobs: ITERS GROUP PPS TEMP LR BETA EVAL_EVERY GATE_N  (env vars)
```

Or by hand:

```bash
# 1) data — gate = the SAME frozen v2/test.eval the SFT 0.62 was measured on; the RL-train
#    pool excludes every example sharing a source with the gate (no leakage).
cd ui && npm run build-rl-prompts -- --gate ../service/sft/.sft-data/v2/test.eval.jsonl \
  --pool ../service/sft/.sft-data/v2-daw/test.eval.jsonl --pool ../service/sft/.sft-data/v2-midi/test.eval.jsonl \
  --pool ../service/sft/.sft-data/daw/test.eval.jsonl  --pool ../service/sft/.sft-data/midi/test.eval.jsonl \
  --out ../service/sft/.rl-data/rl-v1 --per-shape 250

# 2) train  (HF_HUB_OFFLINE=1 pins the tokenizer — see the gotcha)
HF_HUB_OFFLINE=1 service/sft/.venv/bin/python service/rl/grpo.py \
  --rl-data service/sft/.rl-data/rl-v1 --sft-adapter service/sft/.adapters/v2 \
  --out service/sft/.adapters/rl-v1 --iters 60 --group-size 6 --temp 1.0 --eval-every 15

# 3) DoD — best RL adapter vs SFT baseline on the frozen gate, identical tool
HF_HUB_OFFLINE=1 service/sft/.venv/bin/python service/rl/dod_compare.py \
  --rl-data service/sft/.rl-data/rl-v1 --sft-adapter service/sft/.adapters/v2 \
  --rl-adapter service/sft/.adapters/rl-v1 --n 300 --out service/sft/.adapters/rl-v1/dod.json

# smoke (tiny, validates the machinery in minutes): add --smoke to step 2
```

## Tripwires (logged per step)

`reward μ` · `def` (deferral frac) · `signal=k/G` (groups with within-group variance →
gradient) · `distinct` (completion diversity — collapse guard) · `loss` · `kl` (every
`--kl-log-every`). The periodic gate eval prints clean-apply vs the SFT baseline and saves
the **best-by-gate** adapter (early-stop on the metric, not the loss).

## ⚠️ Serving gotcha (inherited from SFT)

`mlx_lm.server`, run **online**, can resolve to a *similarly-named* HF model and load **its**
chat template, silently swinging the score. Everything here runs **`HF_HUB_OFFLINE=1`** so the
served/loaded tokenizer == the training base (`Qwen3-4B-Instruct-2507-4bit`). See
`docs/AUTONOMOUS_SFT.md`.

## Honest expectations

Rung 1 can only fix *command-selection* (acts-shy / wrong-command) — it cannot teach musical
taste (that is Rung 2's whole point). A flat result is itself a finding: it means the SFT
failures are *consistent* (no within-group variance for GRPO to exploit) and need different
**data**, not RL. Either way the machinery + an honest before/after is the Rung-1 deliverable.
Results land in `service/sft/.adapters/rl-v1/{rl_results,dod}.json` (gitignored).
