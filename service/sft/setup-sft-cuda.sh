#!/usr/bin/env bash
# Bootstrap a rented CUDA box (Vast.ai / RunPod) for the Moshi SFT run. Run ON the
# box (Linux + NVIDIA). Vast.ai PyTorch images ship torch + CUDA already; this adds
# the training + serving stack. Idempotent.
set -euo pipefail

echo "— Mosh SFT CUDA setup —"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || { echo "✗ no NVIDIA GPU visible"; exit 1; }

PY="${PYTHON:-python3}"
# PIN exact versions (no `--upgrade` to latest, NO vllm). Lesson learned: letting
# pip grab latest dragged torch to 2.11/cu130 (broke the CUDA runtime) + trl 1.x
# (API drift). This combo is verified working: torch 2.5.1+cu124 + trl 0.21 (which
# pulls a compatible transformers+accelerate) + peft 0.14. Serving uses the stdlib
# serve_openai.py shim, NOT vllm (vllm hard-pins torch and re-breaks the env).
echo "pinning torch 2.5.1 + cu124…"
"$PY" -m pip install -q "torch==2.5.1" "torchvision==0.20.1" "torchaudio==2.5.1" --index-url https://download.pytorch.org/whl/cu124
echo "installing training stack (trl/peft/datasets)…"
"$PY" -m pip install -q "trl==0.21.0" "peft==0.14.0" "datasets==3.2.0"

"$PY" - <<'PYCHK'
import torch, transformers, trl, peft
from trl import SFTConfig
SFTConfig(output_dir="/tmp/_chk", max_length=2048, packing=False)  # API smoke
print(f"  torch {torch.__version__} | cuda {torch.cuda.is_available()} | gpu {torch.cuda.get_device_name(0)}")
print(f"  transformers {transformers.__version__} | trl {trl.__version__} | peft {peft.__version__}")
PYCHK

echo "✓ box ready. Next (on the box):"
echo "    ./launch-r4-cuda.sh"
echo "  or a short smoke:"
echo "    python sft_cuda_train.py --data ./sft-v2 --out ./adapter --max-steps 600 --batch-size 8 \\"
echo "        --no-grad-ckpt --save-steps 200"
echo "  then serve OpenAI-compatible (stdlib shim, no vllm):"
echo "    python serve_openai.py --base Qwen/Qwen3-30B-A3B-Instruct-2507 --adapter ./adapter --port 8000"
