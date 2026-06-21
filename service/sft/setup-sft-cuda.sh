#!/usr/bin/env bash
# Bootstrap a rented CUDA box (Vast.ai / RunPod) for the Moshi SFT run. Run ON the
# box (Linux + NVIDIA). Vast.ai PyTorch images ship torch + CUDA already; this adds
# the training + serving stack. Idempotent.
set -euo pipefail

echo "— Mosh SFT CUDA setup —"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || { echo "✗ no NVIDIA GPU visible"; exit 1; }

PY="${PYTHON:-python3}"
"$PY" -c "import torch; assert torch.cuda.is_available()" 2>/dev/null || {
  echo "torch/CUDA not found — installing a CUDA torch wheel…"
  "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q torch --index-url https://download.pytorch.org/whl/cu124
}

echo "installing training + serving stack…"
"$PY" -m pip install -q --upgrade \
  "transformers>=4.46" "trl>=0.12" "peft>=0.13" "accelerate>=1.0" \
  "datasets>=3.0" "bitsandbytes>=0.44" "huggingface_hub>=0.25" "vllm>=0.6"

"$PY" - <<'PYCHK'
import torch, transformers, trl, peft
print(f"  torch {torch.__version__} | cuda {torch.version.cuda} | gpu {torch.cuda.get_device_name(0)}")
print(f"  transformers {transformers.__version__} | trl {trl.__version__} | peft {peft.__version__}")
PYCHK

echo "✓ box ready. Next (on the box):"
echo "    python sft_cuda_train.py --data ./sft-v2 --out ./adapter --epochs 1   # 80GB: bf16 LoRA"
echo "    # 40GB card: add --4bit (QLoRA)"
echo "  then serve OpenAI-compatible:"
echo "    vllm serve Qwen/Qwen3-4B-Instruct-2507 --enable-lora --lora-modules sft=./adapter --port 8000"
