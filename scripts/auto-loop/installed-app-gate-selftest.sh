#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SELF_DIR/installed-app-gate.sh"

OUT="$("$GATE" --dry-run)"
NO_DEPLOY_OUT="$("$GATE" --dry-run --no-deploy)"

printf '%s\n' "$OUT" | jq -e '
  .pass == true
  and .dryRun == true
  and .skipDeploy == false
  and .app == "/Applications/Mosh.app"
  and ([.steps[].name] == [
    "deploy",
    "codesign",
    "team_id",
    "installed_selftest_x3",
    "installed_selftest_undo",
    "macos_ui_automation",
    "hardware_verify"
  ])
  and (.steps[] | has("command"))
' >/dev/null

printf '%s\n' "$NO_DEPLOY_OUT" | jq -e '
  .pass == true
  and .dryRun == true
  and .skipDeploy == true
' >/dev/null

printf 'installed-app-gate-selftest: PASS\n'
