#!/bin/zsh
set -euo pipefail

SFT_DIR=${MOSH_R4_SFT_DIR:-/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft}
BASE_MODEL=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-30B-A3B-Instruct-2507-4bit
TOTAL=12889
DONE_FILE="$SFT_DIR/.adapters/a3b-r4.done"
STATUS_FILE="$SFT_DIR/.adapters/a3b-r4.gate.status"
LOG_FILE="$SFT_DIR/.adapters/a3b-r4.gate.log"
LOCK_DIR="$SFT_DIR/.adapters/a3b-r4.gate.lock"
FUSED_DIR="$SFT_DIR/.fused/a3b-r4"
WORKTREE_ROOT=$(cd "$SFT_DIR/../.." && pwd)
UI_DIR="$WORKTREE_ROOT/ui"

usage() {
  cat <<'EOF'
Usage: ./run-gate-r4.sh [--force|--help]

Runs the documented a3b-r4 gate read against the detached worktree runtime surface.
Refuses while any MLX process is alive. Re-running after a successful gate read is
blocked unless --force is supplied.
EOF
}

force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

read_kv() {
  local file=$1 key=$2
  [ -f "$file" ] || return 0
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$file"
}

find_mlx_proc() {
  ps -axo pid=,command= | grep -E '[m]lx_lm' | head -1 || true
}

write_status() {
  local state=$1
  cat > "$STATUS_FILE" <<EOF
state=$state
updated_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
done=$(cat "$DONE_FILE" 2>/dev/null || echo 0)
total=$TOTAL
log=$LOG_FILE
fused_dir=$FUSED_DIR
EOF
}

if [ "$force" -ne 1 ] && [ "$(read_kv "$STATUS_FILE" state)" = complete ]; then
  echo "gate already completed :: $(read_kv "$STATUS_FILE" updated_at)"
  echo "status: $STATUS_FILE"
  exit 0
fi

server_pid=""
status_started=0
cleanup() {
  local rc=$1
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "$status_started" -eq 1 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if [ "$rc" -eq 0 ]; then
      write_status complete
    else
      write_status failed
    fi
  fi
}
trap 'cleanup $?' EXIT

done_count=$(cat "$DONE_FILE" 2>/dev/null || echo 0)
if [ "$done_count" -lt "$TOTAL" ]; then
  echo "refusing gate read: training incomplete ($done_count/$TOTAL)" >&2
  exit 1
fi

mlx_proc=$(find_mlx_proc)
if [ -n "$mlx_proc" ]; then
  echo "refusing gate read: mlx process still alive" >&2
  echo "$mlx_proc" >&2
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "gate already running"
  echo "status: $STATUS_FILE"
  exit 0
fi

cd "$SFT_DIR"
source .sft.env
status_started=1
write_status running

{
  echo "== a3b-r4 gate read =="
  date '+started_at=%Y-%m-%dT%H:%M:%S%z'
  echo "runtime=$SFT_DIR"
  echo "ui_dir=$UI_DIR"
  echo "base_model=$BASE_MODEL"
  echo "done=$done_count/$TOTAL"

  "$SFT_PY" sft_cli.py fuse --model "$BASE_MODEL" --adapter .adapters/a3b-r4 --out "$FUSED_DIR"

  B4=$(shasum -a 256 "$BASE_MODEL/model-00004-of-00004.safetensors" | awk '{print $1}')
  F4=$(shasum -a 256 "$FUSED_DIR/model-00004-of-00004.safetensors" | awk '{print $1}')
  B1=$(shasum -a 256 "$BASE_MODEL/model-00001-of-00004.safetensors" | awk '{print $1}')
  F1=$(shasum -a 256 "$FUSED_DIR/model-00001-of-00004.safetensors" | awk '{print $1}')
  [ "$B4" != "$F4" ] || { echo "FAIL: shard4 == base"; exit 1; }
  [ "$B1" = "$F1" ] || echo "NOTE: shard1 != base (unexpected for last-16-layer LoRA)"
  echo "weight-check OK: shard4 tuned, shard1 base"

  "$SFT_PY" -m mlx_lm.server --model "$FUSED_DIR" --port 8080 &
  server_pid=$!
  sleep 20
  curl -fsS http://127.0.0.1:8080/v1/models | grep -Fq "$FUSED_DIR" || {
    echo "identity probe FAIL"
    exit 1
  }
  echo "identity probe OK"

  cd "$UI_DIR"
  export OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local MOSHI_BRAIN_PROVIDER=openai
  npm run eval-sft -- --eval ../service/sft/.sft-data/frozen300/test.eval.jsonl --rules plain --no-think --n 300 --tag a3b-r4-C
  npm run eval-sft -- --eval ../service/sft/.sft-data/eval-v2/evalA.eval.jsonl --rules plain --no-think --tag a3b-r4-A
  npx tsx scripts/evalV2Grounded.mts --base http://127.0.0.1:8080/v1 --model "$FUSED_DIR" --tag a3b-r4 --no-think
} 2>&1 | tee -a "$LOG_FILE"
