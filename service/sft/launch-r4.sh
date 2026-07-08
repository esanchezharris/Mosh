#!/bin/zsh
# Launch Cycle-3 (a3b-r4) full-epoch training on s2-mix-v4, per §P8.
# nohup-detached (survives the session); refuses if an mlx proc is already running.
set -euo pipefail
SFT_DIR=/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft
MODEL=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit
ITERS=${1:-12889}
cd "$SFT_DIR"
source .sft.env
if pgrep -fl mlx_lm >/dev/null 2>&1; then echo "REFUSING: an mlx proc is already running"; pgrep -fl mlx_lm; exit 1; fi
LOG="$SFT_DIR/.adapters/a3b-r4.train.log"
mkdir -p .adapters/a3b-r4
nohup "$SFT_PY" sft_cli.py train \
  --data .sft-data/s2-mix-v4 \
  --out .adapters/a3b-r4 \
  --model "$MODEL" \
  --iters "$ITERS" --batch-size 1 \
  --num-layers 16 --lr 1e-5 --max-seq-length 4096 \
  > "$LOG" 2>&1 &
PID=$!
echo "$PID" > "$SFT_DIR/.adapters/a3b-r4.pid"
disown
echo "r4 launched: pid=$PID iters=$ITERS log=$LOG"
