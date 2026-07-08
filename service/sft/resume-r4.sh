#!/bin/zsh
# Resume Cycle-3 (a3b-r4) training after a clean stop (machine freed). mlx checkpoints
# every 100 iters; loads the latest and trains the REMAINING iters to the pre-registered
# total of 12,889 (§P8). One-time optimizer-moment reset at the seam (minor; same mix,
# same total iters, same hyperparameters → faithful to the recipe). nohup-detached.
set -euo pipefail
SFT_DIR=/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft
MODEL=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit
TOTAL=12889
cd "$SFT_DIR"
source .sft.env
if pgrep -fl mlx_lm >/dev/null 2>&1; then echo "REFUSING: an mlx proc is already running"; pgrep -fl mlx_lm; exit 1; fi
LAST=$(ls .adapters/a3b-r4/ 2>/dev/null | grep -oE '^[0-9]{7}_adapters\.safetensors$' | sort | tail -1)
DONE=$(echo "$LAST" | grep -oE '^[0-9]+' | sed 's/^0*//'); DONE=${DONE:-0}
REM=$((TOTAL - DONE))
if [ "$REM" -le 0 ]; then echo "Already at/over $TOTAL ($DONE). Go to the gate read."; exit 0; fi
echo "resuming from iter $DONE → $REM more iters to reach $TOTAL"
LOG="$SFT_DIR/.adapters/a3b-r4.train.log"
nohup "$SFT_PY" sft_cli.py train \
  --data .sft-data/s2-mix-v4 --out .adapters/a3b-r4 --model "$MODEL" \
  --iters "$REM" --batch-size 1 --num-layers 16 --lr 1e-5 --max-seq-length 4096 \
  --resume-adapter-file .adapters/a3b-r4/adapters.safetensors \
  >> "$LOG" 2>&1 &
PID=$!; echo "$PID" > "$SFT_DIR/.adapters/a3b-r4.pid"; disown
echo "r4 RESUMED: pid=$PID remaining=$REM"
