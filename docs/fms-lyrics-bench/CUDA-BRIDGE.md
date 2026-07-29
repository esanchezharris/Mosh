# CUDA↔MLX LoRA bridge — the sweeps lane runbook

*2026-07-28. Why this exists: an adapter is a correction term coupled to the
exact base function it trained against. Naive cross-stack training loses delta
(r5 measured ~17% kept through a fuse). This bridge trains CUDA LoRAs against
the DEQUANTIZED MLX base — the same function MLX serves — and converts the
adapter home with the scale/rank identities checked. Use it when SWEEPS
dominate wall-clock; a single tuned run is ~1h locally and needs none of this.*

All three tools live in `service/lyrics/bench/fim_bridge.py` (numpy+safetensors
only — no mlx import; the dequantizer must run on Linux). Packing verified
against `mx.dequantize` ground truth (err 2.4e-7); 5 sabotages RED.

## On the Vast box (prefer Vast over RunPod — capacity roulette; and re-run the
## driver AFTER uploads land: the 2026-07 idle-box incident was a driver raced
## against its own upload)

```bash
pip install torch transformers peft safetensors numpy ml_dtypes huggingface_hub
python -c "from huggingface_hub import snapshot_download as d; \
  print(d('mlx-community/Qwen2.5-14B-Instruct-4bit'))"        # ~8.5GB
```

Dequantize there (≈28GB bf16 out — never on the Mac, it has no disk for it):

```bash
python - <<'PY'
import sys; sys.path.insert(0, "service")   # repo checkout or scp'd bench dir
from lyrics.bench import fim_bridge
print(fim_bridge.dequantize_checkpoint("<hf-cache-snapshot-dir>", "base-bf16"))
PY
```

Ship the data up (`~/Library/Mosh/lyrics-bench/fim/mlx-data-v2/{train,valid}.jsonl`
— lyric text: scp to the box, never to a bucket), then train:

```bash
python service/lyrics/bench/_cuda_train_fim.py '{
  "base": "base-bf16", "data": "mlx-data-v2", "out": "peft-out",
  "recipe": '"$(python - <<'PY'
import json, sys; sys.path.insert(0, "service")
from lyrics.bench import fim_bridge
print(json.dumps(fim_bridge.cuda_recipe(json.load(open(
  "adapter_config.json")))))   # scp the serve adapter_config.json up with the data
PY
)"', "iters": 1500, "batch": 16, "lr": 2e-5, "seed": 20260728, "maxLength": 384}'
```

## Back on the Mac

```bash
scp vast:.../peft-out/{adapter_model.safetensors,adapter_config.json} /tmp/peft-out/
python3 - <<'PY'
import json, sys; sys.path.insert(0, "service")
from lyrics.bench import fim_bridge
mlx_cfg = json.load(open(
  "/Users/USER/Library/Mosh/lyrics-bench/fim/adapters/fim-v1/adapter_config.json"))
print(fim_bridge.peft_to_mlx_adapter("/tmp/peft-out",
  "/Users/USER/Library/Mosh/lyrics-bench/fim/adapters/bridged-vN",
  mlx_adapter_config=mlx_cfg))
PY
LYRICS_BENCH_MLX_ADAPTER=.../adapters/bridged-vN \
  python3 service/lyrics/bench/bench_cli.py run --arm local-constrained-endword-fp \
  --slice dev --granularity rhyme --limit 150
```

## The acceptance test that decides whether the bridge is trusted

Train the SAME recipe (seed, data, iters) once on CUDA-via-bridge and once
natively on MLX; the two adapters' bench `exact` on the frozen 150 must agree
within noise (±.02). Until that twin-run has been done ONCE, bridge-trained
adapters are sweep-search evidence, not shippable artifacts. Record the twin
result in PROGRAM.md when it happens.

Conventions pinned by tests: MLX `y += scale·(x@lora_a)@lora_b`, lora_a (in,r);
PEFT alpha/r must equal serve scale (refused otherwise); tensors transpose in
conversion; mlx `--num-layers N` = LAST N layers → PEFT `layers_to_transform`.

## 2026-07-29 — the twin as specified above is VOID (encoding asymmetry)

The first twin run exposed that the two stacks never trained the same task:
mlx_lm's `CompletionsDataset` re-wraps the `{"prompt","completion"}` row in a
SECOND user/assistant chat turn (`datasets.py::CompletionsDataset.process`
calls `apply_chat_template`), while `_cuda_train_fim.py` deliberately trains
the raw concatenation. Both believed they were serve-parity; only the raw
stream is. Empirically the double-wrapped recipe transfers to serve
(fim-v1/fim-v2 ≈ .393 exact) and the raw recipe anti-transfers (.173, below
base .253) despite a faithful conversion (bridged adapter reproduces its own
CUDA val loss under MLX: 1.296 vs 1.394; base control 10.75; probe:
`scratchpad/probe_raw_loss.py` pattern — separate-encode p/c, mask to
completion).

Consequences, until amended: (1) the ±.02 twin bar applies only once the CUDA
trainer reproduces mlx_lm's encoding byte-for-byte (wrap + mask to the
assistant boundary + its EOS handling); (2) do NOT "fix" the MLX side to raw —
raw is the recipe that measured worse; (3) `mlx_lm.lora --test` measures the
double-wrapped stream and cannot validate a raw-trained adapter; (4) the CUDA
trainer must save a checkpoint at every eval block (the first run's val
minimum was mid-run and unrecoverable).

## 2026-07-29 — twin result at n=600, and why the +/-.02 bar is the wrong shape

Same recipe both stacks (mlx-data-v2, 1500 iters, effective batch 16, lr 2e-5,
seed 20260728), compared at each side's val optimum (step 1000), on 600 dev
rhyme items (`itemsSha 9a187fc6`, identical both sides):

  CUDA-bridged .4217   MLX-native .4067   delta -0.015 (CUDA marginally higher)
  item-level agreement 565/600 = 94.2%    McNemar p = 0.175 (no difference)

Read honestly, the literal bar is NOT certified. The point estimate is inside
+/-.02, but *certifying* equivalence needs the 90% CI inside the band and ours
is [-0.031, +0.001]. Reaching that at +/-.02 would take ~6,300 eval items
(~19 h) — the bar was written tighter than the measurement can support.
What n=600 DOES establish: equivalence within **+/-0.035**, no detectable
difference, and 94.2% item agreement across different hardware, framework and
numerics. At n=150 the paired CI was +/-.043 — wider than the bar itself, i.e.
the original test could not have adjudicated its own threshold either way.

STATUS: the bridge is validated for SWEEP work (no systematic bias detected,
and the sign favours CUDA if anything). The "shippable, not just sweep
evidence" clause stays OPEN pending an owner restatement of the tolerance —
proposed: equivalence at +/-.035, or "no McNemar-detectable difference at
n>=600". Do not quietly relax the number in place; it is a registered bar.
