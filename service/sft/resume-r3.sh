#!/bin/zsh
# Resume r3 training after a clean stop (owner relocated the machine / powered off).
# mlx_lm checkpoints the adapter every 100 iters; this loads the latest and trains
# the REMAINING iters to reach the pre-registered total of 12,674 (§P7.3). One-time
# optimizer-moment reset at the seam — minor, documented in §R2; same mix, same
# total iters, same hyperparameters, so faithful to the recipe/gate.
set -euo pipefail
SFT_DIR=/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft
MODEL=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit
TOTAL=12674
cd "$SFT_DIR"
source .sft.env
if pgrep -fl mlx_lm >/dev/null 2>&1; then echo "REFUSING: an mlx proc is already running"; pgrep -fl mlx_lm; exit 1; fi

# Highest saved checkpoint number = iters already trained.
LAST=$(ls .adapters/a3b-r3/ | grep -oE '^[0-9]{7}_adapters\.safetensors$' | sort | tail -1)
DONE=$(echo "$LAST" | grep -oE '^[0-9]+' | sed 's/^0*//')
DONE=${DONE:-0}
REM=$((TOTAL - DONE))
if [ "$REM" -le 0 ]; then echo "Already at/over $TOTAL iters ($DONE). Nothing to resume — go to the gate read (GATE_READ_r3.md)."; exit 0; fi
echo "resuming from iter $DONE (adapters.safetensors) → $REM more iters to reach $TOTAL"

LOG="$SFT_DIR/.adapters/a3b-r3.train.log"
nohup "$SFT_PY" sft_cli.py train \
  --data .sft-data/s2-mix-v3 \
  --out .adapters/a3b-r3 \
  --model "$MODEL" \
  --iters "$REM" --batch-size 1 \
  --num-layers 16 --lr 1e-5 --max-seq-length 4096 \
  --resume-adapter-file .adapters/a3b-r3/adapters.safetensors \
  >> "$LOG" 2>&1 &
PID=$!
echo "$PID" > "$SFT_DIR/.adapters/a3b-r3.pid"
disown
echo "r3 RESUMED: pid=$PID remaining=$REM log=$LOG"
