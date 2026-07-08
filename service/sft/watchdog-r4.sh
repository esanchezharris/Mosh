#!/bin/zsh
# Self-healing Cycle-3 (a3b-r4) trainer. A 30B LoRA train sharing the Mac with the
# owner's music work hits occasional Metal GPU-OOM spikes (Ableton etc.). This
# watchdog resumes from the last 100-iter checkpoint on ANY non-clean exit, so a
# transient OOM costs ~25 min of recompute, not the run. Reaches the pre-registered
# total of 12,889 iters (§P8) then stops. Cumulative progress is tracked in a .done
# file (mlx renumbers checkpoints per-segment, so it can't be trusted for the total).
set -uo pipefail
SFT_DIR=/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft
MODEL=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit
TOTAL=12889
cd "$SFT_DIR"
source .sft.env
LOG="$SFT_DIR/.adapters/a3b-r4.train.log"
DONE_FILE="$SFT_DIR/.adapters/a3b-r4.done"
ADAPTER=.adapters/a3b-r4/adapters.safetensors

fails=0
while true; do
  done=$(cat "$DONE_FILE" 2>/dev/null || echo 0)
  rem=$(( TOTAL - done ))
  if [ "$rem" -le 0 ]; then echo "$(date '+%H:%M:%S') WATCHDOG: COMPLETE ($done/$TOTAL)"; break; fi
  if pgrep -fl mlx_lm >/dev/null 2>&1; then echo "WATCHDOG: mlx already running — abort"; exit 1; fi
  echo "$(date '+%H:%M:%S') WATCHDOG: launching segment — done=$done rem=$rem"
  start_lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  "$SFT_PY" sft_cli.py train \
    --data .sft-data/s2-mix-v4 --out .adapters/a3b-r4 --model "$MODEL" \
    --iters "$rem" --batch-size 1 --num-layers 16 --lr 1e-5 --max-seq-length 4096 \
    --resume-adapter-file "$ADAPTER" >> "$LOG" 2>&1
  rc=$?
  # iters this segment actually SAVED = max local "Iter N" among the new log lines,
  # floored to the last 100-checkpoint. Clean exit (rc 0) means it did all `rem`.
  seg_max=$(tail -n +"$((start_lines+1))" "$LOG" | tr -d '\r' | grep -aoE "^Iter [0-9]+: Train loss" | grep -oE "[0-9]+" | sort -n | tail -1)
  seg_max=${seg_max:-0}
  if [ "$rc" -eq 0 ]; then seg_saved=$rem; else seg_saved=$(( (seg_max/100)*100 )); fi
  done=$(( done + seg_saved ))
  echo "$done" > "$DONE_FILE"
  echo "$(date '+%H:%M:%S') WATCHDOG: segment exited rc=$rc seg_max=$seg_max seg_saved=$seg_saved → done=$done"
  if [ "$rc" -eq 0 ]; then continue; fi   # loop re-checks done>=TOTAL
  fails=$(( fails + 1 ))
  if [ "$fails" -ge 30 ]; then echo "WATCHDOG: 30 crashes — giving up"; exit 1; fi
  echo "$(date '+%H:%M:%S') WATCHDOG: crash #$fails — backing off 90s to let GPU memory settle"
  sleep 90
done
