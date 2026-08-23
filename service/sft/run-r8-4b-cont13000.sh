#!/bin/zsh
set -euo pipefail

worktree=/Users/emiliosanchez-harris/.codex/worktrees/r8-size-ladder-takeover/Mosh
python=/Users/emiliosanchez-harris/Library/Mosh/venvs/sft/bin/python3
config=$worktree/service/sft/R8_4B_MLX_CONT_13000.yaml
data=/Users/emiliosanchez-harris/Mosh/service/sft/.sft-data/s2-mix-v6-prep-r8-cont13000
adapter_dir=/Users/emiliosanchez-harris/Mosh/service/sft/.adapters/r8-4b-mlx-cont13000
resume=/Users/emiliosanchez-harris/Mosh/service/sft/.adapters/r8-4b-mlx-cont12300/0000700_adapters.safetensors

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

# The owner explicitly waived only the direct-Codex-child threshold for this
# run. All memory, swap, and disk thresholds remain canonical and unchanged.
MOSH_MAX_CODEX_CHILDREN=256 "$worktree/scripts/auto-loop/memory-preflight.sh"

verify_sha256 eb25b38b38ae0af41d63c10a9d92f7f00551aa4745c8c815bc51e3d6d9005853 "$config"
verify_sha256 b022b10c3477e0b58eff5a9d8ed465dbcb06df10ba6e2b3954286f0582310cea "$resume"
verify_sha256 aea90e3765128a1f63456b13b9b14ed73b2c478f8b3ffb34c1ddac25814b141d "$data/train.jsonl"
verify_sha256 9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638 "$data/valid.jsonl"
verify_sha256 f425119f8bdfa842ca51c0241456d2c8f555e71efb2d8c0b0f287d71ff3bc14b "$data/manifest.json"

if [[ -e "$adapter_dir" ]]; then
  print -u2 -r -- "refusing replay: adapter namespace already exists: $adapter_dir"
  exit 3
fi

if [[ "${R8_TAIL_VERIFY_ONLY:-0}" == "1" ]]; then
  print -r -- "r8 global-13000 tail inputs verified"
  exit 0
fi

cd "$worktree"
exec "$python" -m mlx_lm lora --config "$config"
