#!/usr/bin/env zsh
set -euo pipefail

ROOT="$(cd "$(dirname "${(%):-%N}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap '/bin/rm -rf "$TMP_DIR"' EXIT
target="$TMP_DIR/owner.env"
link="$TMP_DIR/env"
repair_root="$TMP_DIR/repairs"
secret="ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789"
/usr/bin/printf "export MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET='%s'\nKEEP_ME=yes\n" "$secret" > "$target"
/bin/chmod 600 "$target"
/bin/ln -s "$target" "$link"

run_provision() {
  MOSH_OWNER_ENV_FILE="$link" \
  MOSH_PLAYTEST_EVIDENCE_URL="https://example.invalid/functions/v1/playtest-evidence" \
  MOSH_GITHUB_REPOSITORY="owner/Mosh" \
  MOSH_REPOSITORY_PATH="$ROOT" \
  MOSH_REPAIR_WORKTREE_ROOT="$repair_root" \
  "$ROOT/scripts/owner-cockpit/provision-evidence-secret.sh"
}

first_digest="$(run_provision)"
second_digest="$(run_provision)"
expected_digest="$(/usr/bin/printf '%s' "$secret" | /usr/bin/openssl dgst -sha256 | /usr/bin/awk '{print $NF}')"
[[ "$first_digest" == "$expected_digest" ]]
[[ "$second_digest" == "$expected_digest" ]]
[[ -L "$link" ]]
[[ "$(/usr/bin/stat -f '%Lp' "$target")" == "600" ]]
[[ "$(/usr/bin/stat -f '%Lp' "$repair_root")" == "700" ]]
/usr/bin/grep -q '^KEEP_ME=yes$' "$target"
/usr/bin/grep -q "^MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET=$secret$" "$target"

rotated_digest="$(MOSH_ROTATE_EVIDENCE_SECRET=1 run_provision)"
[[ "$rotated_digest" != "$expected_digest" ]]
[[ -L "$link" ]]

/usr/bin/printf 'evidence provisioning: PASS\n'
