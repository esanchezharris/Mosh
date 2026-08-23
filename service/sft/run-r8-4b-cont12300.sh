#!/bin/zsh
set -euo pipefail

worktree=/Users/emiliosanchez-harris/.codex/worktrees/r8-size-ladder-takeover/Mosh
python=/Users/emiliosanchez-harris/Library/Mosh/venvs/sft/bin/python3
config=$worktree/service/sft/R8_4B_MLX_CONT_12300.yaml
data=/Users/emiliosanchez-harris/Mosh/service/sft/.sft-data/s2-mix-v6-prep-r8-cont12300
adapter_dir=/Users/emiliosanchez-harris/Mosh/service/sft/.adapters/r8-4b-mlx-cont12300
resume=/Users/emiliosanchez-harris/Mosh/service/sft/.adapters/r8-4b-mlx-cont7500/0004800_adapters.safetensors

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

verify_sha256 83e916a52eb64d6ebb5e9e8f669507cb928153dde952015bc7ea2706b8956c2e "$config"
verify_sha256 c3ddedb5cd79e4b21fe6c34ed02b4b6594c8b64be160c8f1ca7422063bf11216 "$resume"
verify_sha256 48f252ee4c4a1f05eab13f4bf6dfb0cbaf69e6dc22c2791860243a621f2a9d98 "$data/train.jsonl"
verify_sha256 9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638 "$data/valid.jsonl"
verify_sha256 2e9d4bc0e45409a22578bd152bf6ad0906f3d8d53a6282c6924e06bb1d997c3f "$data/manifest.json"

if [[ -e "$adapter_dir" ]]; then
  print -u2 -r -- "refusing replay: adapter namespace already exists: $adapter_dir"
  exit 3
fi

if [[ "${R8_TAIL_VERIFY_ONLY:-0}" == "1" ]]; then
  print -r -- "r8 tail inputs verified"
  exit 0
fi

cd "$worktree"
exec "$python" -m mlx_lm lora --config "$config"
