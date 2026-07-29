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
