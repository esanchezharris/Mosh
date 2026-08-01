#!/bin/zsh
set -euo pipefail

env_file="${MOSH_OWNER_ENV_FILE:-$HOME/.config/mosh/env}"
env_dir="${env_file:h}"
endpoint="${MOSH_PLAYTEST_EVIDENCE_URL:-https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/playtest-evidence}"
repository_path="${MOSH_REPOSITORY_PATH:-$(git rev-parse --show-toplevel)}"
worktree_root="${MOSH_REPAIR_WORKTREE_ROOT:-$HOME/Library/Mosh/work/repairs}"
github_repository="${MOSH_GITHUB_REPOSITORY:-$(cd "$repository_path" && gh repo view --json nameWithOwner --jq .nameWithOwner)}"

mkdir -p "$env_dir"
chmod 700 "$env_dir"
touch "$env_file"
chmod 600 "$env_file"

secret="$(/usr/bin/awk '
  /^([[:space:]]*export[[:space:]]+)?MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET=/ {
    value = substr($0, index($0, "=") + 1)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    first = substr(value, 1, 1)
    last = substr(value, length(value), 1)
    if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047"))
      value = substr(value, 2, length(value) - 2)
    if (length(value) == 64 && value !~ /[^[:xdigit:]]/) print value
  }
' "$env_file" | /usr/bin/tail -1)"
if [[ "${MOSH_ROTATE_EVIDENCE_SECRET:-0}" == "1" || "${#secret}" != "64" ]]; then
  secret="$(/usr/bin/openssl rand -hex 32)"
fi
temporary="$(/usr/bin/mktemp "${env_file}.XXXXXX")"
trap '/bin/rm -f "$temporary"' EXIT
chmod 600 "$temporary"

/usr/bin/awk '
  !/^([[:space:]]*export[[:space:]]+)?MOSH_PLAYTEST_EVIDENCE_(URL|OWNER_SECRET)=/ &&
  !/^([[:space:]]*export[[:space:]]+)?MOSH_(GITHUB_REPOSITORY|REPOSITORY_PATH|REPAIR_WORKTREE_ROOT)=/ { print }
' "$env_file" > "$temporary"
{
  /usr/bin/printf 'MOSH_PLAYTEST_EVIDENCE_URL=%s\n' "$endpoint"
  /usr/bin/printf 'MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET=%s\n' "$secret"
  /usr/bin/printf 'MOSH_GITHUB_REPOSITORY=%s\n' "$github_repository"
  /usr/bin/printf 'MOSH_REPOSITORY_PATH=%s\n' "$repository_path"
  /usr/bin/printf 'MOSH_REPAIR_WORKTREE_ROOT=%s\n' "$worktree_root"
} >> "$temporary"
/bin/cat "$temporary" > "$env_file"
/bin/rm -f "$temporary"
chmod 600 "$env_file"
trap - EXIT

mkdir -p "$worktree_root"
chmod 700 "$worktree_root"

/usr/bin/printf '%s' "$secret" | /usr/bin/openssl dgst -sha256 | /usr/bin/awk '{print $NF}'
