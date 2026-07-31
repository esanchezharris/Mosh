#!/usr/bin/env bash
# package-guest-zip.sh — build the shareable "guest zip" for a remote playtest:
# a Release Mosh.app + proxy configuration + the two guest scripts (setup-guest.sh,
# collect-diagnostics.sh), ad-hoc re-signed, with every machine-local venv/model
# pointer file stripped so it never pins the guest's machine to the HOST's paths.
#
# IMPORTANT: this NEVER touches /Applications/Mosh.app. Every packaging step (bundling
# the service, proxy configuration, injecting Info.plist keys, signing) is done against a
# STAGING copy under dist/, by reusing the ACTUAL functions from run-mosh.sh (extracted
# textually, not hand-duplicated) so this script can never drift from the real deploy
# path. If a future step ever needs a real `deploy`, snapshot /Applications/Mosh.app
# first and restore it after — none of the steps below need that today.
#
# Usage:  bash scripts/playtest/package-guest-zip.sh
# Output: dist/Mosh-guest-<YYYYMMDD>-<shortsha>.zip
#
# Env overrides:
#   CPM_SOURCE_CACHE, FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE  — dep-cache locations
#     (default: read from ~/.mosh-auto-loop/auto-loop.env, else the documented
#      ~/Library/Mosh/work/{cpm-cache,deps/tracktion_engine-src})
#   MOSH_BRAIN_ENV_ZIP  — dotenv to load for the bundled proxy configuration (default:
#     $ROOT/ui/.env.local — NEVER the ambient MOSH_BRAIN_ENV; see the landmine note below)
#   SKIP_BUILD=1        — reuse the newest existing Release build instead of rebuilding
#
# `set -e` matters here beyond the usual reasons: we `eval` several functions verbatim
# out of run-mosh.sh (below), and those were AUTHORED assuming run-mosh.sh's own
# `set -euo pipefail`. Without -e in THIS script, a mid-function failure (e.g.
# install_app's `cp -R` failing) can fall through to a later, unrelated `if` with no
# `else` and return 0 anyway — the failure then surfaces confusingly, misattributed to
# whatever step happens to notice missing output several steps later. Keeping this
# script's options identical to run-mosh.sh's is what makes "eval the real function"
# actually safe to rely on.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

bold()  { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
header(){ printf '\n%s\n' "$(bold "══ $* ══")"; }
say()   { printf '  %s\n' "$*"; }

FAILS=()
note_ok()   { say "$(green "✓") $*"; }
note_bad()  { say "$(red "✗") $*"; FAILS+=("$*"); }
note_warn() { say "$(yellow "⚠") $*"; }

brain_env_configured() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 1
  grep -Eq '^[[:space:]]*MOSH_BRAIN_PROXY_URL=[[:space:]]*[^[:space:]]+' "$env_file" \
    && grep -Eq '^[[:space:]]*MOSH_BRAIN_PROXY_APIKEY=[[:space:]]*[^[:space:]]+' "$env_file"
}

brain_env_has_provider_key() {
  local env_file="$1"
  [[ -f "$env_file" ]] \
    && grep -Eq '^[[:space:]]*[A-Z0-9_]+_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]+' "$env_file"
}

# STAGE_ROOT is set once the staging dir is created (step 2); a failed run before or
# after that point should not leave a half-built staged app lying around under dist/ —
# clean it up whenever we exit non-zero (mirrors collect-diagnostics.sh's own trap,
# which always removes its temp stage — here we only remove it on FAILURE, since on
# success dist/stage/Mosh.app is a legitimate, inspectable intermediate artifact).
STAGE_ROOT=""
cleanup_stage_on_failure() {
  local rc=$?
  if [[ "$rc" != 0 && -n "$STAGE_ROOT" ]]; then
    rm -rf "$STAGE_ROOT" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup_stage_on_failure EXIT

# ── extract a function's literal text out of run-mosh.sh so we call the REAL deploy
# logic against a staging path, instead of hand-duplicating it (and drifting later) ──
extract_fn() {
  local name="$1" file="$2"
  awk -v name="$name" '
    $0 ~ "^" name "\\(\\) \\{" {p=1}
    p {print}
    p && /^}/ {p=0; exit}
  ' "$file"
}
for fn in resolve_app build_app load_dotenv bundle_service refuse_provider_brain_keys bundle_brain_key install_app sign_app; do
  fn_src="$(extract_fn "$fn" "$ROOT/run-mosh.sh")"
  if [[ -z "$fn_src" ]]; then
    echo "✗ could not extract function '$fn' from run-mosh.sh — has it been renamed/refactored?" >&2
    exit 1
  fi
  eval "$fn_src"
done

# ─────────────────────────── 1. fresh Release build ─────────────────────────────
header "1/10  build (Release)"

if [[ ! -d "$ROOT/ui/node_modules" ]]; then
  # Worktree gotcha (docs/superpowers memory: mosh-worktree-ui-build-esbuild-sigkill):
  # a fresh `npm install` in a worktree can SIGKILL esbuild's postinstall. Reuse the
  # main checkout's already-installed node_modules via symlink (never cp — the
  # esbuild/vite .bin symlinks break under a copy). Non-fatal if it can't be created —
  # the ui build's own npm install will just populate a real node_modules instead.
  MAIN_CHECKOUT="$HOME/Mosh"
  if [[ -d "$MAIN_CHECKOUT/ui/node_modules" && "$MAIN_CHECKOUT" != "$ROOT" ]]; then
    if ln -s "$MAIN_CHECKOUT/ui/node_modules" "$ROOT/ui/node_modules" 2>/dev/null; then
      note_ok "symlinked ui/node_modules -> $MAIN_CHECKOUT/ui/node_modules (worktree esbuild-SIGKILL workaround)"
    else
      note_warn "could not symlink ui/node_modules (non-fatal — npm install will populate a real one)"
    fi
  fi
fi

# Dep-cache locations: prefer the auto-loop's healed, proven values; fall back to the
# documented default; env overrides win over both.
AL_ENV="$HOME/.mosh-auto-loop/auto-loop.env"
# shellcheck disable=SC1090  # intentionally dynamic — optional per-machine dep-cache env
[[ -f "$AL_ENV" ]] && source "$AL_ENV"
CPM_SOURCE_CACHE="${CPM_SOURCE_CACHE:-${AL_CPM_CACHE:-$HOME/Library/Mosh/work/cpm-cache}}"
FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE="${FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE:-${AL_TRACTION_SRC:-$HOME/Library/Mosh/work/deps/tracktion_engine-src}}"
say "CPM_SOURCE_CACHE = $CPM_SOURCE_CACHE"
say "FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE = $FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE"

if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  note_warn "SKIP_BUILD=1 — reusing the newest existing Release build (not rebuilding)"
else
  say "configuring…"
  if ! cmake --preset macos-arm64-release \
      -DCPM_SOURCE_CACHE="$CPM_SOURCE_CACHE" \
      -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE="$FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE"; then
    note_bad "cmake configure failed"
    exit 1
  fi
  say "building (Mosh + MoshStageUI + MoshFixInfoPlist)…"
  if ! cmake --build --preset macos-arm64-release-app; then
    note_bad "cmake build failed"
    exit 1
  fi
  note_ok "build complete"
fi

BUILT_APP="$(resolve_app)"
if [[ -z "$BUILT_APP" || ! -x "$BUILT_APP/Contents/MacOS/Mosh" ]]; then
  note_bad "no built Mosh.app found under build-macos-arm64-release/"
  exit 1
fi
note_ok "built app: $BUILT_APP"

# ────────────────────── 2. bundle service + brain proxy (staged) ───────────────
header "2/10  bundle service + brain proxy (staging copy, never /Applications)"

DIST_DIR="$ROOT/dist"
mkdir -p "$DIST_DIR"
STAGE_ROOT="$DIST_DIR/stage"
rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_ROOT"
STAGED="$STAGE_ROOT/Mosh.app"

install_app "$BUILT_APP" "$STAGED" || { note_bad "install_app (staging copy) failed"; exit 1; }
note_ok "staged copy at $STAGED"

# CRITICAL landmine (CLAUDE.md working notes, 2026-07-16): the owner's login shell
# exports MOSH_BRAIN_ENV to a nonexistent path, so a non-interactive script that
# reads the ambient env silently ships a KEYLESS bundle. We must EXPLICITLY set the
# dotenv path here and never fall through to any inherited MOSH_BRAIN_ENV.
unset MOSH_BRAIN_ENV
ENV_FILE="${MOSH_BRAIN_ENV_ZIP:-$ROOT/ui/.env.local}"
if [[ -f "$ENV_FILE" ]]; then
  load_dotenv "$ENV_FILE"
  note_ok "loaded brain proxy dotenv from $ENV_FILE (explicit path, not inherited)"
else
  note_warn "no dotenv at $ENV_FILE — the bundled app will ship WITHOUT a brain proxy"
fi

bundle_service "$STAGED" || { note_bad "bundle_service failed (partial/broken service bundle)"; exit 1; }
note_ok "service bundled"
bundle_brain_key "$STAGED" || { note_bad "bundle_brain_key failed"; exit 1; }

# ───────────────────── 3. strip machine-local .*.env pointers ───────────────────
header "3/10  strip machine-local venv/model pointer files"

SVC_DIR="$STAGED/Contents/Resources/service"
STRIPPED=0
if [[ -d "$SVC_DIR" ]]; then
  while IFS= read -r -d '' f; do
    rm -f "$f"
    STRIPPED=$((STRIPPED + 1))
  done < <(find "$SVC_DIR" -type f -name '.*.env' -print0 2>/dev/null)
fi
say "stripped $STRIPPED file(s)"
REMAINING="$(find "$SVC_DIR" -type f -name '.*.env' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$REMAINING" == "0" ]]; then
  note_ok "no .*.env pointer files remain in the bundle"
else
  note_bad "$REMAINING .*.env file(s) still present after stripping — packaging bug"
  find "$SVC_DIR" -type f -name '.*.env'
  exit 1
fi

# ───────────────────── 4. copy the guest scripts into the bundle ────────────────
header "4/10  copy guest scripts into Contents/Resources"

cp "$ROOT/scripts/playtest/setup-guest.sh" "$STAGED/Contents/Resources/setup-guest.sh"
cp "$ROOT/scripts/playtest/collect-diagnostics.sh" "$STAGED/Contents/Resources/collect-diagnostics.sh"
chmod +x "$STAGED/Contents/Resources/setup-guest.sh" "$STAGED/Contents/Resources/collect-diagnostics.sh"
note_ok "setup-guest.sh + collect-diagnostics.sh copied + made executable"

# ───────────────────────────── 5. re-seal ───────────────────────────────────────
header "5/10  re-seal (ad-hoc)"
sign_app "$STAGED" "guest-zip staging" || { note_bad "sign_app failed"; exit 1; }

# ─────────────────────────────── 6. verify ──────────────────────────────────────
header "6/10  verify bundle contents"

PLIST="$STAGED/Contents/Info.plist"
if SPEECH_TEXT="$(plutil -extract NSSpeechRecognitionUsageDescription raw "$PLIST" 2>&1)" && [[ -n "$SPEECH_TEXT" ]]; then
  note_ok "NSSpeechRecognitionUsageDescription present (TCC-safe)"
else
  note_bad "NSSpeechRecognitionUsageDescription MISSING — this bundle would TCC-crash on voice"
fi

BRAIN_ENV="$STAGED/Contents/Resources/brain.env"
if [[ -f "$BRAIN_ENV" ]]; then
  if brain_env_has_provider_key "$BRAIN_ENV"; then
    note_bad "brain.env contains a provider API key — refusing to produce a guest artifact"
    exit 1
  elif brain_env_configured "$BRAIN_ENV"; then
    note_ok "brain.env present with proxy configuration (guest's Moshi has a brain out of the box)"
  else
    note_warn "brain.env present but carries no complete proxy configuration — Moshi edits fail visibly without mutation"
  fi
else
  note_warn "no brain.env in the bundle — configure the proxy and re-run to enable Moshi edits"
fi

[[ -f "$SVC_DIR/server.py" ]] && note_ok "service/server.py present" || note_bad "service/server.py MISSING"
[[ -f "$STAGED/Contents/Resources/setup-guest.sh" ]] && note_ok "setup-guest.sh present" || note_bad "setup-guest.sh MISSING"
[[ -f "$STAGED/Contents/Resources/collect-diagnostics.sh" ]] && note_ok "collect-diagnostics.sh present" || note_bad "collect-diagnostics.sh MISSING"

PIN_FILE="$SVC_DIR/sa3/guest/UPSTREAM_PIN"
if [[ -f "$PIN_FILE" ]]; then
  note_ok "service/sa3/guest/UPSTREAM_PIN present (SA3 vendor files rode the whole-dir 'sa3' service copy)"
else
  note_bad "service/sa3/guest/UPSTREAM_PIN MISSING — the whole-dir 'sa3' copy in bundle_service() did not carry it"
fi

# Every whole-dir module bundle_service() copies (run-mosh.sh's own `for d in ...`
# whitelist, line ~183) must have actually landed non-empty. A partial/broken copy here
# would only otherwise surface as a runtime ModuleNotFoundError deep in a route handler
# on the guest's machine — catch it here instead.
SERVICE_MODULE_DIRS=(adapters colors recipes sa3 scripts training lyrics phonology skeleton whisper soulx bestofn compiler loras)
MODULE_DIR_FAIL=0
for d in "${SERVICE_MODULE_DIRS[@]}"; do
  moddir="$SVC_DIR/$d"
  if [[ -d "$moddir" && -n "$(find "$moddir" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
    :
  else
    note_bad "service/$d MISSING or empty in the staged bundle (bundle_service()'s whole-dir copy)"
    MODULE_DIR_FAIL=1
  fi
done
[[ "$MODULE_DIR_FAIL" == 0 ]] && note_ok "all ${#SERVICE_MODULE_DIRS[@]} whitelisted service module dirs present + non-empty"

LIVE_SA3="$HOME/AI/stable-audio-3"
if [[ -d "$LIVE_SA3" ]]; then
  DRIFT=0
  for f in dit_mlx_medium.py sa3_mlx.py; do
    live=""
    case "$f" in
      dit_mlx_medium.py) live="$LIVE_SA3/optimized/mlx/models/defs/dit_mlx_medium.py" ;;
      sa3_mlx.py)        live="$LIVE_SA3/optimized/mlx/scripts/sa3_mlx.py" ;;
    esac
    vendored="$SVC_DIR/sa3/guest/$f"
    if [[ -f "$live" && -f "$vendored" ]] && ! diff -q "$live" "$vendored" >/dev/null 2>&1; then
      note_warn "vendored $f DIFFERS from the live checkout at $live — re-vendor if the owner's local edits changed"
      DRIFT=1
    fi
  done
  [[ "$DRIFT" == 0 ]] && note_ok "vendored SA3 guest files match the live ~/AI/stable-audio-3 checkout"
else
  note_warn "no ~/AI/stable-audio-3 checkout on this machine — skipped the vendor-drift diff"
fi

# ────────────────────────── 7. selftest the staged app ──────────────────────────
header "7/10  selftest staged app"
SELFTEST_SESSION="session-package-zip-$$"
rm -rf "$HOME/Library/Mosh/${SELFTEST_SESSION}" "$HOME/Library/Mosh/${SELFTEST_SESSION}-undo" 2>/dev/null || true
ST_LOG="$(mktemp -t pkg-guest-selftest.XXXX.log)"
if MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SELFTEST_SESSION" "$STAGED/Contents/MacOS/Mosh" --selftest >"$ST_LOG" 2>&1; then
  RESULT="$(grep -oE '[0-9]+/[0-9]+ checks passed' "$ST_LOG" | tail -1)"
  note_ok "staged-app selftest — ${RESULT:-passed, no summary line matched}"
else
  RESULT="$(tail -20 "$ST_LOG")"
  note_bad "staged-app selftest FAILED — see $ST_LOG"
  echo "$RESULT" | sed 's/^/    /'
fi

# ────────────── fail-fast: never zip a bundle that failed verification ──────────
# A zip's existence must mean it passed everything — a broken bundle handed to a
# friend is worse than no bundle at all (the earlier version zipped regardless and
# only reported failures in the final summary; a guest could still receive it).
if [[ "${#FAILS[@]}" -gt 0 ]]; then
  header "ABORTING — ${#FAILS[@]} check(s) failed before packaging"
  printf '   - %s\n' "${FAILS[@]}"
  echo
  echo "$(red "✗ package-guest-zip: refusing to produce a zip from a bundle that failed verification.")"
  exit 1
fi

# ─────────────────────────────── 8. zip it ──────────────────────────────────────
header "8/10  zip"
SHORT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DATE_STAMP="$(date '+%Y%m%d')"
ZIP_NAME="Mosh-guest-${DATE_STAMP}-${SHORT_SHA}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
rm -f "$ZIP_PATH"
if ditto -c -k --keepParent "$STAGED" "$ZIP_PATH"; then
  note_ok "wrote $ZIP_PATH"
else
  note_bad "ditto zip failed"
  exit 1
fi

# ───────────────────────────── 9. guest simulation ──────────────────────────────
header "9/10  guest simulation (extract + quarantine + selftest, in a scratch dir)"

SIM_DIR="$(mktemp -d -t mosh-guest-sim)"
if ditto -x -k "$ZIP_PATH" "$SIM_DIR"; then
  SIM_APP="$SIM_DIR/Mosh.app"
  if [[ -d "$SIM_APP" ]]; then
    if codesign --verify --deep --strict "$SIM_APP" 2>/dev/null; then
      note_ok "extracted copy: signature valid"
    else
      note_bad "extracted copy: codesign --verify FAILED"
    fi

    # Simulate the Gatekeeper quarantine flag a real AirDrop/download would attach,
    # then clear it with the shipped unquarantine.sh — proving the guest's actual
    # first-run remedy works against a bundle produced by this exact pipeline.
    xattr -w com.apple.quarantine "0083;00000000;Safari;" "$SIM_APP" 2>/dev/null || true
    if xattr -p com.apple.quarantine "$SIM_APP" >/dev/null 2>&1; then
      if bash "$ROOT/scripts/playtest/unquarantine.sh" "$SIM_APP" >/dev/null 2>&1 \
         && ! xattr -p com.apple.quarantine "$SIM_APP" >/dev/null 2>&1; then
        note_ok "unquarantine.sh clears the synthetic quarantine flag"
      else
        note_bad "unquarantine.sh did NOT clear the synthetic quarantine flag"
      fi
    else
      note_warn "could not attach a synthetic quarantine xattr to test unquarantine.sh (non-fatal)"
    fi

    SIM_SESSION="session-package-zip-sim-$$"
    rm -rf "$HOME/Library/Mosh/${SIM_SESSION}" "$HOME/Library/Mosh/${SIM_SESSION}-undo" 2>/dev/null || true
    SIM_LOG="$(mktemp -t pkg-guest-sim-selftest.XXXX.log)"
    if MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SIM_SESSION" "$SIM_APP/Contents/MacOS/Mosh" --selftest >"$SIM_LOG" 2>&1; then
      SIM_RESULT="$(grep -oE '[0-9]+/[0-9]+ checks passed' "$SIM_LOG" | tail -1)"
      note_ok "extracted-copy selftest — ${SIM_RESULT:-passed, no summary line matched}"
    else
      note_bad "extracted-copy selftest FAILED — see $SIM_LOG"
    fi

    SIM_ENV_LEFT="$(find "$SIM_APP/Contents/Resources/service" -type f -name '.*.env' 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$SIM_ENV_LEFT" == "0" ]]; then
      note_ok "extracted copy: no stripped .*.env files reappeared"
    else
      note_bad "extracted copy: $SIM_ENV_LEFT .*.env file(s) present (should be zero)"
    fi
  else
    note_bad "extraction did not produce Mosh.app"
  fi
else
  note_bad "extracting $ZIP_PATH failed"
fi
rm -rf "$SIM_DIR"

# The guest-simulation step above can ALSO discover a problem (it re-tests the actual
# zip contents, post-extraction) even when everything before it was clean — honor the
# same "a zip's existence must mean it passed everything" invariant from step 8: if
# FAILS grew during step 9, the zip we already wrote is NOT trustworthy. Delete it
# rather than leave a known-broken zip sitting in dist/ that a future run (or a human
# skimming dist/) could mistake for a good one.
if [[ "${#FAILS[@]}" -gt 0 ]]; then
  header "guest simulation found problems — deleting the zip"
  printf '   - %s\n' "${FAILS[@]}"
  rm -f "$ZIP_PATH"
  echo
  echo "$(red "✗ package-guest-zip: guest simulation failed — $ZIP_PATH was deleted (not a trustworthy handoff).")"
  exit 1
fi

# ──────────────────────────────── 10. summary ───────────────────────────────────
header "10/10  summary"
SIZE="$(du -sh "$ZIP_PATH" 2>/dev/null | awk '{print $1}')"
SHA="$(shasum -a 256 "$ZIP_PATH" 2>/dev/null | awk '{print $1}')"
say "zip:    $ZIP_PATH"
say "size:   ${SIZE:-?}"
say "sha256: ${SHA:-?}"

QUICKSTART="$ROOT/docs/TESTER_QUICKSTART.md"
if [[ -f "$QUICKSTART" ]]; then
  cp "$QUICKSTART" "$DIST_DIR/READ-ME-FIRST.txt"
  note_ok "copied docs/TESTER_QUICKSTART.md -> dist/READ-ME-FIRST.txt"
else
  note_warn "docs/TESTER_QUICKSTART.md not found (being written on another branch) — no READ-ME-FIRST.txt bundled this run"
fi

echo
echo "── paste-ready message for your friend ──"
cat <<MSG
Hey! Here's Mosh — unzip it, drag Mosh.app to Applications, then:
  xattr -dr com.apple.quarantine /Applications/Mosh.app
and double-click to open (see docs/PLAYTEST_SETUP.md for the full walkthrough).

Once it's open, for the full experience (real AI re-imagine + lyric tools instead of
placeholders), open Terminal and run:
  bash /Applications/Mosh.app/Contents/Resources/setup-guest.sh --all
(~10-15 min + a few GB download; --status shows what's real vs. placeholder any time.)

If anything looks wrong, run:
  bash /Applications/Mosh.app/Contents/Resources/collect-diagnostics.sh
and send me the zip it drops on your Desktop.
MSG
echo "──────────────────────────────────────────"

echo
if [[ "${#FAILS[@]}" -eq 0 ]]; then
  echo "$(green "✓ package-guest-zip: all checks passed.")"
  exit 0
else
  # Unreachable in practice (the fail-fast gate above already aborts before the zip
  # step whenever FAILS is non-empty) — kept as a defensive final check.
  printf '%s\n' "$(red "✗ package-guest-zip: ${#FAILS[@]} check(s) failed:")"
  printf '   - %s\n' "${FAILS[@]}"
  exit 1
fi
