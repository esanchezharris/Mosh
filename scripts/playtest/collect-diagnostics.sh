#!/usr/bin/env bash
# collect-diagnostics.sh — bundle up everything a host needs to debug a guest's
# playtest session into one zip on the Desktop, so "it broke, here's the file" is a
# single command instead of a screen-share. Shipped INSIDE the app bundle at
# Contents/Resources/collect-diagnostics.sh (see scripts/playtest/package-guest-zip.sh).
#
# Deliberately conservative about what it collects: session STATE + LOGS + crash
# reports + environment facts, never audio content. Works whether Mosh is running or
# not (a crash report is exactly the case where it won't be).
#
# Usage:
#   bash /Applications/Mosh.app/Contents/Resources/collect-diagnostics.sh [--with-audio]
#
# Env overrides:
#   MOSH_APP_BUNDLE   which .app to inspect for CFBundleVersion/codesign/xattr
#                     (default: resolved from $0 if we're inside one, else
#                     /Applications/Mosh.app)
set -uo pipefail

WITH_AUDIO=0
[[ "${1:-}" == "--with-audio" ]] && WITH_AUDIO=1

SESSION_DIR="$HOME/Library/Mosh/session"
DESKTOP="$HOME/Desktop"
TS="$(date '+%Y%m%d-%H%M%S')"
ZIP_PATH="$DESKTOP/Mosh-diagnostics-$TS.zip"

# ── resolve which app to introspect (Contents/Resources/collect-diagnostics.sh -> the
# .app is two levels up; otherwise fall back to the conventional install location) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENTS_DIR="$(dirname "$SCRIPT_DIR")"
DERIVED_APP="$(dirname "$CONTENTS_DIR")"
if [[ -n "${MOSH_APP_BUNDLE:-}" ]]; then
  APP_ROOT="$MOSH_APP_BUNDLE"
elif [[ -f "$CONTENTS_DIR/Info.plist" && "$DERIVED_APP" == *.app ]]; then
  APP_ROOT="$DERIVED_APP"
else
  APP_ROOT="/Applications/Mosh.app"
fi

say() { printf '  %s\n' "$*"; }

echo "Mosh diagnostics collector"
say "session dir : $SESSION_DIR"
say "app         : $APP_ROOT"
[[ "$WITH_AUDIO" == 1 ]] && say "$(printf '\033[33m%s\033[0m' "--with-audio set: audio/renders/imports/phone-takes WILL be included")"
echo

STAGE_PARENT="$(mktemp -d -t mosh-diagnostics)"
STAGE="$STAGE_PARENT/Mosh-diagnostics-$TS"
trap 'rm -rf "$STAGE_PARENT"' EXIT
mkdir -p "$STAGE/session" "$STAGE/crash-reports"

# ── 1. session state (never audio content unless asked) ─────────────────────────
if [[ -d "$SESSION_DIR" ]]; then
  # mosh-log.jsonl, tail-capped at ~100 MB so a long-lived session doesn't balloon the zip.
  LOG_SRC="$SESSION_DIR/mosh-log.jsonl"
  if [[ -f "$LOG_SRC" ]]; then
    CAP=$((100 * 1024 * 1024))
    SZ="$(stat -f%z "$LOG_SRC" 2>/dev/null || stat -c%s "$LOG_SRC" 2>/dev/null || echo 0)"
    if [[ "$SZ" -gt "$CAP" ]]; then
      tail -c "$CAP" "$LOG_SRC" > "$STAGE/session/mosh-log.jsonl"
      echo "mosh-log.jsonl: original $SZ bytes, truncated to the last $CAP bytes" > "$STAGE/session/mosh-log.TRUNCATED.txt"
      say "mosh-log.jsonl: $SZ bytes -> truncated to last ${CAP} bytes"
    else
      cp "$LOG_SRC" "$STAGE/session/mosh-log.jsonl"
      say "mosh-log.jsonl: $SZ bytes (copied whole)"
    fi
  fi

  [[ -d "$SESSION_DIR/diagnostics" ]] && cp -R "$SESSION_DIR/diagnostics" "$STAGE/session/diagnostics" && say "diagnostics/ copied"
  [[ -f "$SESSION_DIR/identity.json" ]] && cp "$SESSION_DIR/identity.json" "$STAGE/session/identity.json" && say "identity.json copied"

  # session.tracktionedit + its backup-* siblings.
  EDIT_COUNT=0
  for f in "$SESSION_DIR"/session.tracktionedit "$SESSION_DIR"/session.tracktionedit.backup-*; do
    [[ -f "$f" ]] || continue
    cp "$f" "$STAGE/session/$(basename "$f")"
    EDIT_COUNT=$((EDIT_COUNT + 1))
  done
  say "session.tracktionedit + backups: $EDIT_COUNT file(s) copied"

  if [[ "$WITH_AUDIO" == 1 ]]; then
    for d in audio renders imports phone-takes; do
      [[ -d "$SESSION_DIR/$d" ]] && cp -R "$SESSION_DIR/$d" "$STAGE/session/$d" && say "$d/ copied (--with-audio)"
    done
  else
    say "$(printf '\033[2m%s\033[0m' "skipped audio/ renders/ imports/ phone-takes/ (pass --with-audio to include)")"
  fi
else
  say "no session dir found at $SESSION_DIR (nothing recorded yet)"
fi

# ── 2. newest 5 crash reports ─────────────────────────────────────────────────────
CRASH_DIR="$HOME/Library/Logs/DiagnosticReports"
CRASH_COUNT=0
if [[ -d "$CRASH_DIR" ]]; then
  while IFS=$'\t' read -r _ f; do
    [[ -z "$f" ]] && continue
    cp "$f" "$STAGE/crash-reports/"
    CRASH_COUNT=$((CRASH_COUNT + 1))
  done < <(
    find "$CRASH_DIR" -maxdepth 1 -type f -name 'Mosh-*.ips' 2>/dev/null \
      | while IFS= read -r f; do printf '%s\t%s\n' "$(stat -f '%m' "$f" 2>/dev/null || echo 0)" "$f"; done \
      | sort -rn | head -5
  )
fi
say "crash reports: $CRASH_COUNT copied (newest 5 of any found)"
[[ "$CRASH_COUNT" == 0 ]] && rmdir "$STAGE/crash-reports" 2>/dev/null || true

# ── 3. live /health + /capabilities (tolerate the app being closed) ─────────────
PORTFILE="$HOME/Library/Mosh/service.port"
HEALTH_OK=0
if [[ -f "$PORTFILE" ]]; then
  PORT="$(tr -d '[:space:]' < "$PORTFILE" 2>/dev/null)"
  if [[ -n "$PORT" ]]; then
    HEALTH_JSON="$(curl -s --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
    CAPS_JSON="$(curl -s --max-time 2 "http://127.0.0.1:${PORT}/capabilities" 2>/dev/null || true)"
    if [[ -n "$HEALTH_JSON" || -n "$CAPS_JSON" ]]; then
      {
        printf '{\n  "port": %s,\n  "health": %s,\n  "capabilities": %s\n}\n' \
          "${PORT:-null}" "${HEALTH_JSON:-null}" "${CAPS_JSON:-null}"
      } > "$STAGE/service-health.json"
      HEALTH_OK=1
    fi
  fi
fi
if [[ "$HEALTH_OK" == 1 ]]; then
  say "service-health.json: written (service is up)"
else
  echo '{"note": "service not reachable — app may be closed, or the service has not spawned yet"}' > "$STAGE/service-health.json"
  say "service-health.json: written (service not reachable — this is expected with the app closed)"
fi

# ── 4. environment report ────────────────────────────────────────────────────────
{
  echo "=== Mosh diagnostics — environment report ==="
  echo "generated: $(date)"
  echo
  echo "--- sw_vers ---"
  sw_vers 2>&1
  echo
  echo "--- uname -m ---"
  uname -m 2>&1
  echo
  echo "--- app bundle ---"
  echo "path: $APP_ROOT"
  if [[ -f "$APP_ROOT/Contents/Info.plist" ]]; then
    echo "CFBundleVersion: $(plutil -extract CFBundleVersion raw "$APP_ROOT/Contents/Info.plist" 2>&1)"
  else
    echo "CFBundleVersion: (Info.plist not found — app not at expected path)"
  fi
  echo
  echo "--- codesign -dv ---"
  codesign -dv "$APP_ROOT" 2>&1 || true
  echo
  echo "--- xattr (attribute NAMES only — see note) ---"
  # Names only, deliberately NOT `xattr -l` (which dumps VALUES too): macOS can attach
  # com.apple.metadata:kMDItemWhereFroms to a downloaded/AirDropped app, and its value
  # is often a live, still-usable download URL (e.g. a tokenized WeTransfer/S3 link).
  # This zip is designed to be forwarded to the host, so leaking that would hand a
  # stranger a working link into whatever delivered the file. Attribute NAMES (just
  # which ones are present, e.g. com.apple.quarantine) are diagnostically useful and
  # carry no such risk.
  xattr "$APP_ROOT" 2>&1 || true
  echo
  echo "--- df -h / ---"
  df -h / 2>&1
} > "$STAGE/environment-report.txt"
say "environment-report.txt written"

# ── 5. service logs, if present (see service/run.sh MOSH_SERVICE_LOG default) ───
LOGS_DIR="$HOME/Library/Mosh/logs"
if [[ -d "$LOGS_DIR" ]]; then
  LOG_COUNT="$(find "$LOGS_DIR" -maxdepth 1 -name '*.log*' -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$LOG_COUNT" -gt 0 ]]; then
    mkdir -p "$STAGE/logs"
    find "$LOGS_DIR" -maxdepth 1 -name '*.log*' -type f -exec cp {} "$STAGE/logs/" \; 2>/dev/null
    say "service logs: $LOG_COUNT file(s) copied from $LOGS_DIR"
  fi
fi

# ── 6. zip it ─────────────────────────────────────────────────────────────────────
mkdir -p "$DESKTOP"
rm -f "$ZIP_PATH"
if ditto -c -k --keepParent "$STAGE" "$ZIP_PATH" 2>/dev/null; then
  SIZE="$(du -sh "$ZIP_PATH" 2>/dev/null | awk '{print $1}')"
  echo
  echo "$(printf '\033[32m✓\033[0m') wrote $ZIP_PATH ($SIZE)"
  echo "  Note: paths inside this zip include your macOS username ($(whoami)) — normal, but worth knowing before you send it."
  echo "  Send this file to your host."
  exit 0
else
  echo "✗ ditto failed to create $ZIP_PATH" >&2
  exit 1
fi
