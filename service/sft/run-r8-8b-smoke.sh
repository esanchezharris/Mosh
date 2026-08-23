#!/bin/zsh
set -euo pipefail

worktree=/Users/emiliosanchez-harris/.codex/worktrees/r8-size-ladder-takeover/Mosh
python=/Users/emiliosanchez-harris/Library/Mosh/venvs/sft/bin/python3
config=$worktree/service/sft/R8_8B_MLX_SMOKE.yaml
model=/Users/emiliosanchez-harris/AI/models/mlx/Qwen3-8B-4bit
data=/Users/emiliosanchez-harris/Library/Mosh/work/sft/r8-4b-smoke
adapter_dir=/Users/emiliosanchez-harris/Mosh/service/sft/.adapters/r8-8b-smoke

verify_sha256() {
  local expected=$1
  local path=$2
  local actual
  actual=$(/usr/bin/shasum -a 256 "$path" | /usr/bin/awk '{print $1}')
  if [[ "$actual" != "$expected" ]]; then
    print -u2 -r -- "sha256 mismatch: $path expected=$expected actual=$actual"
    return 1
  fi
}

# The owner waived only the direct-Codex-child threshold. Memory, swap, and
# disk gates remain canonical and unchanged.
MOSH_MAX_CODEX_CHILDREN=256 "$worktree/scripts/auto-loop/memory-preflight.sh"

verify_sha256 8e9b375b38ad2aec96e7fc058641f2fb2a8247c60c7c85155c3f48170d6d501c "$config"
verify_sha256 e5485285fd7e289e76e9cffa112f6dc2e3426519082f7db9b69041589f81a218 "$model/config.json"
verify_sha256 f2d29621aab300336ad645567ff38c42aac755513006ef4e8a579cf7ef5256d8 "$model/model.safetensors"
verify_sha256 392262600bc922b17fa863cdd5b26362f38fb24daa0b57ed3f57ac06ccb60150 "$data/train.jsonl"
verify_sha256 392262600bc922b17fa863cdd5b26362f38fb24daa0b57ed3f57ac06ccb60150 "$data/valid.jsonl"

if [[ -e "$adapter_dir" ]]; then
  print -u2 -r -- "refusing replay: adapter namespace already exists: $adapter_dir"
  exit 3
fi

if [[ "${R8_SMOKE_VERIFY_ONLY:-0}" == "1" ]]; then
  print -r -- "r8 8b poison-row smoke inputs verified"
  exit 0
fi

if /usr/bin/pgrep -f 'mlx_lm (lora|server)' >/dev/null 2>&1; then
  print -u2 -r -- "refusing concurrent MLX launch: another mlx_lm trainer/server is active"
  exit 4
fi

cd "$worktree"
exec "$python" -m mlx_lm lora --config "$config"
