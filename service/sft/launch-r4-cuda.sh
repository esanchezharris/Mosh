#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
MODEL="${MODEL:-Qwen/Qwen3-30B-A3B-Instruct-2507}"
DATA_DIR="${DATA_DIR:-$ROOT/.sft-data/s2-mix-v4}"
OUT_DIR="${OUT_DIR:-$ROOT/.adapters/a3b-r4-cuda}"
MAX_STEPS="${MAX_STEPS:-12889}"
BATCH_SIZE="${BATCH_SIZE:-1}"
GRAD_ACCUM="${GRAD_ACCUM:-1}"
LR="${LR:-1e-5}"
LORA_R="${LORA_R:-16}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-4096}"
LAST_LAYERS="${LAST_LAYERS:-16}"
SAVE_STEPS="${SAVE_STEPS:-200}"

ARGS=(
  "$ROOT/sft_cuda_train.py"
  --data "$DATA_DIR"
  --model "$MODEL"
  --out "$OUT_DIR"
  --epochs 1
  --max-steps "$MAX_STEPS"
  --batch-size "$BATCH_SIZE"
  --grad-accum "$GRAD_ACCUM"
  --lr "$LR"
  --lora-r "$LORA_R"
  --max-seq-len "$MAX_SEQ_LEN"
  --last-layers "$LAST_LAYERS"
  --save-steps "$SAVE_STEPS"
)

if [ "${BIT4:-0}" = "1" ]; then
  ARGS+=(--4bit)
fi
if [ "${NO_GRAD_CKPT:-0}" = "1" ]; then
  ARGS+=(--no-grad-ckpt)
fi
if [ "${NO_ASSISTANT_LOSS:-0}" = "1" ]; then
  ARGS+=(--no-assistant-loss)
fi
if [ -n "${LAYERS_TO_TRANSFORM:-}" ]; then
  ARGS+=(--layers-to-transform "$LAYERS_TO_TRANSFORM")
fi
if [ -n "${LAYERS_PATTERN:-}" ]; then
  ARGS+=(--layers-pattern "$LAYERS_PATTERN")
fi
if [ -n "${RESUME_FROM_CHECKPOINT:-}" ]; then
  ARGS+=(--resume-from-checkpoint "$RESUME_FROM_CHECKPOINT")
fi

exec "$PYTHON_BIN" "${ARGS[@]}" "$@"
