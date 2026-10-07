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
    "hardware_verify",
    "harness_session_reclaim"
  ])
  and (.steps[] | has("command"))
' >/dev/null

printf '%s\n' "$NO_DEPLOY_OUT" | jq -e '
  .pass == true
  and .dryRun == true
  and .skipDeploy == true
' >/dev/null

# ── a real (stubbed) run: its selftest sessions go only when the selftest passed ─────
# A stand-in app whose --selftest creates its session the way the engine does, stubbed
# codesign/python3, and a sandboxed MOSH_APP_DATA_DIR: nothing reaches the owner's
# ~/Library/Mosh or /Applications.
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
FAKE_APP="$SANDBOX/Mosh.app"
HARNESS="$SANDBOX/Mosh/_harness"
mkdir -p "$FAKE_APP/Contents/MacOS" "$SANDBOX/bin" "$HARNESS/installed-app-gate-1-1"
printf '%s' 'Mosh isolated harness session v1' > "$HARNESS/installed-app-gate-1-1/.mosh-harness-owned-v1"
cat > "$FAKE_APP/Contents/MacOS/Mosh" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = --selftest ] || exit 0
dir="$MOSH_APP_DATA_DIR/$MOSH_SELFTEST_SESSION"
mkdir -p "$dir/training/adapters"
printf '%s' 'Mosh isolated harness session v1' > "$dir/.mosh-harness-owned-v1"
printf '12 checks passed, %s failed\n' "${FAKE_SELFTEST_FAILED:-0}"
EOF
printf '#!/bin/sh\necho TeamIdentifier=ZYT77F9B27\n' > "$SANDBOX/bin/codesign"
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/bin/python3"
chmod +x "$FAKE_APP/Contents/MacOS/Mosh" "$SANDBOX/bin/codesign" "$SANDBOX/bin/python3"
run_stubbed_gate() {
  PATH="$SANDBOX/bin:$PATH" MOSH_INSTALLED_APP="$FAKE_APP" MOSH_APP_DATA_DIR="$SANDBOX/Mosh" \
    "$GATE" --no-deploy ui || true
}
run_sessions() { find "$HARNESS" -mindepth 1 -maxdepth 1 -name 'installed-app-gate-*' ! -name 'installed-app-gate-1-1' | wc -l | tr -d ' '; }

FAILED_OUT="$(FAKE_SELFTEST_FAILED=1 run_stubbed_gate)"
printf '%s\n' "$FAILED_OUT" | jq -e '
  (.steps[] | select(.name == "installed_selftest_x3") | .ok) == false
  and ([.steps[] | select(.name == "harness_session_reclaim") | .ok, (.detail.sessions | length)] == [true, 3])
  and all(.steps[] | select(.name == "harness_session_reclaim") | .detail.sessions[];
          test("^kept _harness/installed-app-gate-[123]-[0-9]+: the run did not pass$"))
' >/dev/null || { echo "a failing selftest did not report keeping its sessions: $FAILED_OUT" >&2; exit 1; }
[ "$(run_sessions)" = 3 ] || { echo "a failing selftest lost its sessions" >&2; exit 1; }
find "$HARNESS" -mindepth 1 -maxdepth 1 -name 'installed-app-gate-*' ! -name 'installed-app-gate-1-1' \
  -exec rm -rf {} +

PASSED_OUT="$(run_stubbed_gate)"
printf '%s\n' "$PASSED_OUT" | jq -e '
  (.steps[] | select(.name == "installed_selftest_x3") | .ok) == true
  and ([.steps[] | select(.name == "harness_session_reclaim") | .ok, (.detail.sessions | length)] == [true, 3])
  and all(.steps[] | select(.name == "harness_session_reclaim") | .detail.sessions[];
          test("^removed _harness/installed-app-gate-[123]-[0-9]+$"))
' >/dev/null || { echo "a passing selftest did not report removing its sessions: $PASSED_OUT" >&2; exit 1; }
[ "$(run_sessions)" = 0 ] || { echo "a passing selftest left its sessions behind" >&2; exit 1; }
[ -f "$HARNESS/installed-app-gate-1-1/.mosh-harness-owned-v1" ] \
  || { echo "another run's session was removed" >&2; exit 1; }
[ -z "$(find "$HARNESS" -mindepth 1 -maxdepth 1 -name '.mosh-reset*')" ] \
  || { echo "removal left a quarantine behind" >&2; exit 1; }

printf 'installed-app-gate-selftest: PASS\n'
