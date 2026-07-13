#!/usr/bin/env bash
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF/../../.." && pwd)"
TMP="$(mktemp -d)"
WT="$TMP/lane"
RUNTIME="$TMP/runtime"
PROBE="$WT/ui/node_modules/.cn-sandbox-write-probe"

cleanup() {
  rm -f "$PROBE" 2>/dev/null || true
  git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

CODEX_BIN="${CN_CODEX_BIN:-$(command -v codex)}"
[ -x "$CODEX_BIN" ] || {
  printf 'sandbox-test: codex is unavailable\n' >&2
  exit 1
}
OWNER_AUTH="/Users/$(/usr/bin/id -un)/.codex/auth.json"
[ -f "$OWNER_AUTH" ] || {
  printf 'sandbox-test: owner auth canary is unavailable\n' >&2
  exit 1
}

mkdir -p "$RUNTIME/home" "$RUNTIME/tmp" "$RUNTIME/codex-home"
git -C "$ROOT" worktree add --detach "$WT" HEAD >/dev/null
ln -s "$ROOT/ui/node_modules" "$WT/ui/node_modules"

export CN_REPO="$ROOT"
export CN_CONTROL_REPO="$ROOT"
. "$SELF/orchestrator.sh"
permissions="$(cn_agent_permissions_arg "$WT" "$RUNTIME" write)" \
  || cn_die "sandbox-test could not build the cn_lane profile"

/usr/bin/env -i \
  CODEX_HOME="$RUNTIME/codex-home" HOME="$RUNTIME/home" TMPDIR="$RUNTIME/tmp" \
  PATH="$CN_PINNED_PATH" LANG=C CN_REAL_NPM="$CN_REAL_NPM" \
  OWNER_AUTH="$OWNER_AUTH" TRUSTED_DEPS="$WT/ui/node_modules" \
  "$CODEX_BIN" sandbox -c "$permissions" \
    -c 'permissions.cn_lane.network.enabled=false' \
    -c 'default_permissions="cn_lane"' -P cn_lane -C "$WT" \
    /bin/sh -c '
      set -eu
      cd ui
      [ "$(node --version)" = v24.16.0 ]
      [ "$(npm --version)" = 11.13.0 ]
      npm run typecheck
      npm test -- src/agent/commands.test.ts
      [ "$(./node_modules/.bin/playwright --version)" = "Version 1.61.0" ]
      if /usr/bin/head -c 1 "$OWNER_AUTH" >/dev/null 2>&1; then exit 90; fi
      if /usr/bin/touch "$TRUSTED_DEPS/.cn-sandbox-write-probe" 2>/dev/null; then exit 91; fi
      if /usr/bin/curl -fsS --max-time 2 https://example.com >/dev/null 2>&1; then exit 92; fi
    '

[ ! -e "$PROBE" ] || {
  printf 'sandbox-test: trusted dependency write escaped the profile\n' >&2
  exit 1
}
[ -z "$(git -C "$WT" status --porcelain=v1 --untracked-files=all)" ] || {
  printf 'sandbox-test: live profile probe mutated the detached worktree\n' >&2
  exit 1
}
printf 'sandbox-test: Node, npm, TypeScript, Vitest, and Playwright readable; auth, dependency writes, and network denied\n'
