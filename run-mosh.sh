#!/usr/bin/env bash
# run-mosh.sh — launch the built Mosh.app with brain configuration + native voice, for a live
# smoke test of the packaged-app pieces (LLM brain + macOS speech-to-text).
#
# THIS SCRIPT CONTAINS NO KEYS. It loads them from, in order:
#   1. ui/.env.local   — the gitignored dotenv you paste keys into (see ui/.env.example)
#   2. whatever is already exported in your current shell
#
# It launches the app's inner binary directly (NOT `open`) so the app inherits the
# exported environment — `open(1)` would drop it. The mic/speech permission prompts
# still appear on first use (they key off the bundle, not the launch method).
#
# Usage:
#   ./run-mosh.sh           launch the GUI (talk/type to Moshi — tests voice + brain)
#   ./run-mosh.sh smoke     non-interactive native brain round-trip; prints the reply
#   ./run-mosh.sh build     (re)build the app, then launch the GUI
#   ./run-mosh.sh deploy    (re)build, then install ONE canonical /Applications/Mosh.app
#                               (ad-hoc signed, local — fast; the everyday path)
#   ./run-mosh.sh deploy-anira  build the gated anira (real-time RAVE) target + install
#                               it self-contained (LibTorch bundled) to /Applications
#   ./run-mosh.sh release   build Release → Developer-ID sign + Hardened Runtime +
#                               entitlements → notarize (Apple) → staple → DMG + zip,
#                               written to ~/Desktop/Mosh-share/. The shareable artifact
#                               friends can open by DOUBLE-CLICKING — no right-click /
#                               `xattr` dance. Requires a "Developer ID Application"
#                               cert + a one-time notary creds profile (see below).
#
# Env knobs: MOSH_BRAIN_ENV (override the dotenv path), MOSH_ENABLE_SA3 (default 1;
#            set 0 to force FakeAdapter), MOSH_BRAIN_SMOKE_PROMPT (prompt for `smoke`),
#            MOSH_NOTARY_PROFILE (notarytool keychain profile, default "mosh-notary"),
#            MOSH_RELEASE_DIR (release output dir, default ~/Desktop/Mosh-share),
#            MOSH_SIGN_IDENTITY (pin an exact codesign identity instead of
#            auto-discovering the first "Developer ID Application" cert),
#            MOSH_NOTARY_APPLE_ID/MOSH_NOTARY_TEAM_ID/MOSH_NOTARY_PASSWORD (notarize
#            with an explicit Apple-ID/team/app-specific-password instead of a
#            keychain profile — no keychain profile setup needed; this is the mode
#            .github/workflows/release.yml uses in CI).
#
# One-time setup for `release` (secrets stay in your keychain, never in the repo) —
# full runbook incl. the CI path: docs/release/SIGNING_RUNBOOK.md. Short version:
#   1. Create the cert: Xcode ▸ Settings ▸ Accounts ▸ <Apple ID> ▸ Manage Certificates…
#      ▸ + ▸ "Developer ID Application".  (An "Apple Development" cert can NOT notarize
#      for direct distribution — this is a separate certificate you must create.)
#   2. Store notary creds once (make an app-specific password at appleid.apple.com):
#        xcrun notarytool store-credentials "mosh-notary" \
#          --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-pw>
#   3. Sanity-check both without spending a build: `scripts/release/sign-and-notarize.sh
#      --preflight-only` (fails closed with exact instructions if either is missing) or
#      `--dry-run` (also previews the exact codesign/notarytool commands, no creds needed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${MOSH_BRAIN_ENV:-$ROOT/ui/.env.local}"
MODE="${1:-gui}"

# Resolve the newest built Mosh.app. The documented build is the
# `macos-arm64-debug` preset (-> build-macos-arm64/); we also check the legacy
# build/ dir. (The old hardcoded build/.../Release/Mosh.app path was stale —
# the preset never produced it.)
resolve_app() {
  # Newest Mosh.app by mtime. Pure-bash loop (no head/sort pipe) so it is safe
  # under `set -o pipefail` — a truncating pipe would SIGPIPE and abort the script.
  local p t best=0 newest=""
  while IFS= read -r p; do
    t="$(stat -f '%m' "$p" 2>/dev/null || echo 0)"
    if [ "$t" -ge "$best" ]; then best="$t"; newest="$p"; fi
  done < <(find "$ROOT/build-macos-arm64-release" "$ROOT/build-macos-arm64" "$ROOT/build" -maxdepth 3 -name 'Mosh.app' -type d 2>/dev/null)
  printf '%s\n' "$newest"
}

# build_app [configurePreset] [buildPreset] — defaults to the Debug app preset for
# fast iteration; `deploy` passes the Release presets so the installed app is optimized.
build_app() {
  local cfg="${1:-macos-arm64-debug}" bld="${2:-macos-arm64-app}"
  echo "building Mosh ($cfg → $bld)…"
  cmake --preset "$cfg"
  cmake --build --preset "$bld"
}

# --- load a dotenv file WITHOUT printing any values -------------------------------
load_dotenv() {
  local f="$1"; [ -f "$f" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"             # left-trim
    case "$line" in ''|'#'*) continue;; *=*) ;; *) continue;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$val" in
      \"*\") val="${val%\"}"; val="${val#\"}";;          # "quoted"
      \'*\') val="${val%\'}"; val="${val#\'}";;          # 'quoted'
      *) val="${val%% #*}";;                              # strip " # inline comment"
    esac
    val="${val%"${val##*[![:space:]]}"}"                 # right-trim
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -n "$key" ] && export "$key=$val"
  done < "$f"
}
load_dotenv "$ENV_FILE"

# SA3 "imagine" is on by default (the service auto-selects the MLX venv when the
# model is installed, and falls back to FakeAdapter when it isn't). Set
# MOSH_ENABLE_SA3=0 to force FakeAdapter even when the model is present.
export MOSH_ENABLE_SA3="${MOSH_ENABLE_SA3:-1}"

if [[ "$MODE" == "deploy" || "$MODE" == "deploy-anira" ]] && [[ "${MOSH_DEPLOY_INNER:-0}" != "1" ]]; then
  MOSH_DEPLOY_INNER=1 "$0" "$@"
  DEPLOY_RC=$?
  if [[ "$DEPLOY_RC" == "0" ]]; then
    DEST="/Applications/Mosh.app"
    XATTR_OUT="$(mktemp /tmp/mosh-deploy-xattrs.XXXXXX)"
    XATTR_LABEL="studio.mosh.deploy-xattrs.$$.$RANDOM"
    if launchctl submit -l "$XATTR_LABEL" -- /bin/bash -lc '
      set -euo pipefail
      DEST="$1"
      OUT="$2"
      sleep 1
      xattr -cr "$DEST" 2>/dev/null || true
      {
        codesign --verify --deep --strict "$DEST" && echo "  signature: valid after final xattr cleanup"
        XATTR_COUNT=$(find "$DEST" -xattr -print | wc -l | tr -d " ")
        if [[ "$XATTR_COUNT" == "0" ]]; then
          echo "  xattrs: stripped"
        else
          echo "  xattrs: ${XATTR_COUNT} residual attribute-bearing paths (run from Terminal/Full Disk Access if provenance is protected)"
        fi
      } > "$OUT" 2>&1
    ' mosh-deploy-finalize "$DEST" "$XATTR_OUT" >/dev/null 2>&1; then
      for _ in {1..80}; do
        [[ -s "$XATTR_OUT" ]] && break
        sleep 0.25
      done
      cat "$XATTR_OUT"
      launchctl remove "$XATTR_LABEL" >/dev/null 2>&1 || true
      rm -f "$XATTR_OUT"
    else
      rm -f "$XATTR_OUT"
      /bin/bash -lc '
        set -euo pipefail
        DEST="$1"
        sleep 1
        xattr -cr "$DEST" 2>/dev/null || true
        codesign --verify --deep --strict "$DEST" && echo "  signature: valid after final xattr cleanup"
        XATTR_COUNT=$(find "$DEST" -xattr -print | wc -l | tr -d " ")
        if [[ "$XATTR_COUNT" == "0" ]]; then
          echo "  xattrs: stripped"
        else
          echo "  xattrs: ${XATTR_COUNT} residual attribute-bearing paths (run from Terminal/Full Disk Access if provenance is protected)"
        fi
      ' mosh-deploy-finalize "$DEST"
    fi
  fi
  exit "$DEPLOY_RC"
fi

# --- report which providers are configured (names only, never values) -------------
if [ -f "$ENV_FILE" ]; then echo "env: ${ENV_FILE#$ROOT/}"; else echo "env: shell only (no $ENV_FILE)"; fi
have_any=0
if [ -n "${MOSH_BRAIN_PROXY_URL:-}" ]; then echo "  • brain proxy: configured"; have_any=1; fi
for p in DEEPSEEK OPENAI XAI; do
  k="${p}_API_KEY"
  if [ -n "${!k:-}" ]; then echo "  • $p: key present"; have_any=1; fi
done
if [ "$have_any" = 0 ]; then
  echo "  • no brain configuration found — configure the proxy for packaged builds"
  echo "    (Moshi edits fail visibly without mutating the project)"
fi

# --- deploy helpers ---------------------------------------------------------------
# Bundle the Python service INTO the app so a Finder/Dock double-click (whose cwd is
# not the repo) can still find + spawn it — GenerativeJobManager looks for
# Contents/Resources/service/server.py. The model venvs (SA3 MLX + Basic Pitch + the
# RAVE transform venv, 100s of MB–GBs, machine-local) stay OUTSIDE: the bundled run.sh
# defaults SA3_MLX_DIR to ~/AI/... and reads the machine-local .*.env pointers we copy
# in (so transcription + re-imagine + RAVE transform work from the Dock, not just here).
bundle_service() {                              # $1 = installed app
  local DEST="$1" SVC="$1/Contents/Resources/service"
  echo "bundling service → ${SVC#$ROOT/}"
  rm -rf "$SVC"; mkdir -p "$SVC/transcribe" "$SVC/sketch" "$SVC/transform" "$SVC/teardown/render"
  # Top-level modules imported (transitively) by the bundled dirs below. brain_client
  # is needed by lyrics/core.py + bestofn/runtime.py; coverage (→ stitch) by the
  # generative adapters. Missing any of these = ModuleNotFoundError → route 500 in the
  # packaged app even though the dev tree passes; guarded by
  # service/scripts/bundle_completeness_test.py.
  cp "$ROOT/service/server.py" "$ROOT/service/run.sh" \
     "$ROOT/service/quality_readout.py" "$ROOT/service/audio_io.py" \
     "$ROOT/service/brain_client.py" "$ROOT/service/coverage.py" "$ROOT/service/stitch.py" \
     "$ROOT/service/setup-sa3.sh" "$SVC/" 2>/dev/null || true
  # FMS service modules ride whole-dir (imported in-process by server.py / the adapters;
  # venvs live OUTSIDE the tree at ~/Library/Mosh/venvs since #218, and the machine-local
  # .env pointers inside these dirs are exactly what the deployed run.sh needs).
  # `compiler` = the prompt compiler (/compile_render, imported in-process by server.py);
  # its real-LLM path lazy-imports brain_client (bundled separately) and degrades to the
  # deterministic fake when that's absent, so the fake path works whole-dir on its own.
  for d in adapters colors recipes sa3 scripts training lyrics phonology skeleton whisper soulx bestofn compiler loras; do
    [ -d "$ROOT/service/$d" ] && cp -R "$ROOT/service/$d" "$SVC/$d"
  done
  cp "$ROOT/service/teardown/recipe.py" "$SVC/teardown/"
  cp "$ROOT/service/teardown/render/compile.py" "$SVC/teardown/render/"
  cp "$ROOT/service/transcribe/transcribe_cli.py" \
     "$ROOT/service/transcribe/setup-transcribe.sh" "$SVC/transcribe/"
  cp "$ROOT/service/sketch/beatbox_cli.py" \
     "$ROOT/service/sketch/make_fixtures.py" \
     "$ROOT/service/sketch/setup-sketch.sh" \
     "$ROOT/service/sketch/README.md" "$SVC/sketch/"
  [ -d "$ROOT/service/sketch/fixtures" ] && cp -R "$ROOT/service/sketch/fixtures" "$SVC/sketch/fixtures"
  # Route C transform (RAVE): the CLI + setup only — NEVER the .venv (torch, GBs).
  cp "$ROOT/service/transform/transform_cli.py" \
     "$ROOT/service/transform/setup-transform.sh" "$SVC/transform/" 2>/dev/null || true
  # Machine-local venv pointers (gitignored). Absent ones fall back to run.sh defaults.
  [ -f "$ROOT/service/.sa3.env" ] && cp "$ROOT/service/.sa3.env" "$SVC/.sa3.env"
  [ -f "$ROOT/service/.recipe.env" ] && cp "$ROOT/service/.recipe.env" "$SVC/.recipe.env"
  [ -f "$ROOT/service/transcribe/.transcribe.env" ] && cp "$ROOT/service/transcribe/.transcribe.env" "$SVC/transcribe/.transcribe.env"
  [ -f "$ROOT/service/sketch/.sketch.env" ] && cp "$ROOT/service/sketch/.sketch.env" "$SVC/sketch/.sketch.env"
  [ -f "$ROOT/service/transform/.transform.env" ] && cp "$ROOT/service/transform/.transform.env" "$SVC/transform/.transform.env"
  find "$SVC" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
  emit_notices "$DEST"
}

# FS-K4 — third-party acknowledgements, GENERATED from docs/DEPENDENCY_BOM.md §1 so the
# shipped NOTICES can never drift from the verified inventory. packaging_check then
# re-reads this file and fails the deploy if a shipping BOM row is unacknowledged or a
# mandatory "Powered by ..." attribution is missing.
emit_notices() {                                # $1 = installed app
  local DEST="$1" OUT="$1/Contents/Resources/NOTICES.txt"
  echo "emitting NOTICES → ${OUT#$ROOT/}"
  if ! python3 "$ROOT/service/scripts/packaging_check.py" --emit-notices >"$OUT"; then
    rm -f "$OUT"                                # never leave a truncated/partial notice file
    echo "FATAL: could not generate NOTICES.txt from docs/DEPENDENCY_BOM.md" >&2
    exit 1
  fi
}

# FS-K4 — the BLOCKING packaging/BOM compliance check (SPEC §5 K1).
# Refuses to ship a bundle that carries RAVE/anira artifacts (§1.11), is missing a NOTICE
# for any shipping BOM §1 row or a mandatory attribution, or ships third-party payload with
# no BOM row. Mirrors the existing fail-closed Info.plist net in install_app.
packaging_check() {                             # $1 = bundle, $2 = "warn-only" (optional)
  local DEST="$1" MODE_FLAG=""
  [ "${2:-}" = "warn-only" ] && MODE_FLAG="--warn-only"
  python3 "$ROOT/service/scripts/packaging_check.py" --bundle "$DEST" $MODE_FLAG || {
    echo "FATAL: packaging check refused this bundle — see the reasons above." >&2
    echo "       (SPEC §5 K1 / §1.11 · inventory: docs/DEPENDENCY_BOM.md)" >&2
    exit 1
  }
}

refuse_provider_brain_keys() {
  local v
  for v in OPENAI_API_KEY DEEPSEEK_API_KEY XAI_API_KEY GROK_API_KEY LOCAL_API_KEY; do
    if [ -n "${!v:-}" ]; then
      echo "refusing to bundle provider API keys; configure MOSH_BRAIN_PROXY_URL and MOSH_BRAIN_PROXY_APIKEY instead" >&2
      return 1
    fi
  done
}

validate_brain_proxy_value() {
  local name="$1" value="$2"
  # POSIX environment strings cannot contain NUL. Reject the remaining line
  # delimiters explicitly so one proxy value can never create another dotenv key.
  case "$value" in
    *$'\r'*|*$'\n'*)
      echo "invalid brain proxy configuration: $name must be a single line" >&2
      return 1
      ;;
  esac
}

brain_env_is_proxy_only() {
  local file="$1" line count=0 seen_url=0 seen_apikey=0
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *$'\r'*) return 1 ;;
      MOSH_BRAIN_PROXY_URL=?*)
        [ "$seen_url" -eq 0 ] || return 1
        seen_url=1
        ;;
      MOSH_BRAIN_PROXY_APIKEY=?*)
        [ "$seen_apikey" -eq 0 ] || return 1
        seen_apikey=1
        ;;
      *) return 1 ;;
    esac
    count=$((count + 1))
  done < "$file"
  [ "$count" -eq 2 ] && [ "$seen_url" -eq 1 ] && [ "$seen_apikey" -eq 1 ]
}

# Bundle only the proxy endpoint and its publishable credential so Finder/Dock launches
# can reach Moshi without putting an extractable provider secret in a distributable app.
bundle_brain_key() {                            # $1 = installed app
  local BF="$1/Contents/Resources/brain.env"
  local proxy_url="${MOSH_BRAIN_PROXY_URL:-}"
  local proxy_apikey="${MOSH_BRAIN_PROXY_APIKEY:-}"
  if ! refuse_provider_brain_keys; then
    rm -f "$BF"
    return 1
  fi
  validate_brain_proxy_value MOSH_BRAIN_PROXY_URL "$proxy_url" || {
    rm -f "$BF"
    return 1
  }
  validate_brain_proxy_value MOSH_BRAIN_PROXY_APIKEY "$proxy_apikey" || {
    rm -f "$BF"
    return 1
  }
  if [ -z "$proxy_url" ] || [ -z "$proxy_apikey" ]; then
    rm -f "$BF"
    echo "no complete brain proxy configuration — skipped brain.env"
    return
  fi
  (umask 077; printf 'MOSH_BRAIN_PROXY_URL=%s\nMOSH_BRAIN_PROXY_APIKEY=%s\n' \
    "$proxy_url" "$proxy_apikey" > "$BF")
  if ! brain_env_is_proxy_only "$BF"; then
    rm -f "$BF"
    echo "invalid brain proxy configuration: refusing non-proxy brain.env" >&2
    return 1
  fi
  chmod 600 "$BF" 2>/dev/null || true
  echo "bundled proxy configuration → Contents/Resources/brain.env"
}

install_app() {                                 # $1 = source app, $2 = dest
  echo "deploying $1 -> $2"
  rm -rf "$2"; cp -R "$1" "$2"
  # Fail-closed safety net: a bundle missing NSSpeechRecognitionUsageDescription
  # TCC-CRASHES the moment the always-on voice starts. The build now injects it via
  # an always-run target, but a stale/hand-built source bundle could still lack it —
  # and that is EXACTLY how a crashing /Applications/Mosh.app once shipped (the copy
  # path had no plist check). Re-inject + verify here, before signing, using the SAME
  # single-source script the build uses. (Done before sign_app so the seal stays valid.)
  if [ -f "$2/Contents/Info.plist" ]; then
    cmake -DPLIST="$2/Contents/Info.plist" -P "$ROOT/cmake/InjectInfoPlistKeys.cmake" \
      && echo "  Info.plist: speech/camera/bonjour usage keys present (TCC-safe)" \
      || { echo "  FATAL: Info.plist usage-key injection failed — refusing to ship a TCC-crashing bundle" >&2; return 1; }
  fi
}

# Seal a deployed bundle. Prefers the "Developer ID Application" identity when one is
# installed, and only falls back to ad-hoc when there is none (CI, a fresh machine).
#
# WHY THE IDENTITY MATTERS FOR MORE THAN GATEKEEPER: macOS TCC pins a privacy grant
# (Microphone, Speech Recognition, Camera, …) to the app's code-signing identity. An
# AD-HOC signature carries no certificate, so TCC has nothing durable to key on and
# falls back to the bundle's exact `cdhash` — which changes on EVERY rebuild. The old
# grant is then orphaned and macOS re-prompts on the next launch, forever. Signing with
# a real certificate makes the requirement cert-based
# (`identifier "studio.mosh.app" and … certificate leaf[subject.OU] = "ZYT77F9B27"`),
# which survives every subsequent rebuild — the same reason Ableton/Logic ask once.
#
# Deliberately NOT `--options runtime` / `--entitlements` here: a stable TCC identity is
# all this needs, and leaving Hardened Runtime off keeps the everyday deploy behaviourally
# identical to the ad-hoc build it replaces (no library-validation risk to third-party
# VST3/AU hosting). `release` still applies the full distribution config.

# Echo the SHA-1 of an installed "Developer ID Application" identity, or empty if none.
# (An "Apple Development"/"Apple Distribution" cert is NOT accepted by notarization for
# direct distribution — it must be a Developer ID Application cert.)
#
# KEEP THIS HERE even though scripts/release/sign-and-notarize.sh has its own richer
# `resolve_identity`: that script is the RELEASE path and the everyday `deploy` path
# never sources it. `sign_app` below calls this on every deploy, and run-mosh.sh runs
# under `set -euo pipefail`, so removing this function does not degrade gracefully —
# it aborts the deploy with "dev_id_identity: command not found" and silently reverts
# the app to an unsigned state, which is exactly the TCC re-prompt bug #452 fixed.
dev_id_identity() {
  security find-identity -v -p codesigning 2>/dev/null \
    | awk '/Developer ID Application/ { print $2; exit }'
}

sign_app() {
  local DEST="$1" LABEL="${2:-ad-hoc}" ID
  ID="$(dev_id_identity)"
  xattr -cr "$DEST" 2>/dev/null || true
  if [ -n "$ID" ]; then
    codesign --force --deep --sign "$ID" "$DEST"
    LABEL="${LABEL/ad-hoc/Developer ID}"
  else
    echo "  note: no Developer ID Application identity found — signing ad-hoc." >&2
    echo "        macOS will re-prompt for mic/speech access after every rebuild." >&2
    codesign --force --deep --sign - "$DEST"
  fi
  # macOS may attach protected provenance immediately after a copy/sign burst.
  # Give the metadata writer a moment, then strip again before final verification.
  sleep 1
  xattr -cr "$DEST" 2>/dev/null || true
  codesign --verify --deep --strict "$DEST" && echo "  signature: valid ($LABEL)"
}

finish_deployed_app() {
  local DEST="$1"
  refresh_icon_cache "$DEST"
}

# Make an anira-built app self-contained: copy libanira + the needed LibTorch dylibs
# into Contents/Frameworks, point an @executable_path rpath there, DROP the build-tree
# rpaths, and re-sign ad-hoc — so the installed app keeps working after the (throwaway)
# build tree is cleaned. The torch dylibs we actually link: libtorch (umbrella),
# libtorch_cpu (~180 MB), libc10; libtorch_python/shm/global_deps are NOT referenced.
selfcontain_anira() {                           # $1 = installed app
  local DEST="$1" BIN="$1/Contents/MacOS/Mosh" FW="$1/Contents/Frameworks"
  mkdir -p "$FW"
  local rp anira_dir="" torch_dir=""
  while IFS= read -r rp; do
    [ -e "$rp/libanira.2.dylib" ]    && anira_dir="$rp"
    [ -e "$rp/libtorch_cpu.dylib" ]  && torch_dir="$rp"
  done < <(otool -l "$BIN" | awk '/LC_RPATH/{f=1} f&&/ path /{print $2; f=0}')
  if [ -z "$anira_dir" ] || [ -z "$torch_dir" ]; then
    echo "selfcontain: could not find anira/libtorch in rpaths (anira='$anira_dir' torch='$torch_dir')" >&2
    return 1
  fi
  echo "self-containing dylibs → ${FW#$ROOT/}"
  cp -RP "$anira_dir"/libanira*.dylib "$FW/"                       # real file + symlinks
  local l; for l in libtorch.dylib libtorch_cpu.dylib libc10.dylib; do cp "$torch_dir/$l" "$FW/"; done
  install_name_tool -add_rpath @executable_path/../Frameworks "$BIN" 2>/dev/null || true
  install_name_tool -delete_rpath "$anira_dir" "$BIN" 2>/dev/null || true
  install_name_tool -delete_rpath "$torch_dir" "$BIN" 2>/dev/null || true
  sign_app "$DEST" "ad-hoc, self-contained"
  echo "self-contained: $(cd "$FW" && ls | tr '\n' ' ')"
}

# Build the gated anira (real-time RAVE) target into build-anira/. First configure
# pulls LibTorch (~hundreds of MB, long); after that it's an incremental rebuild.
build_anira() {
  local dir="$ROOT/build-anira"
  if [ ! -f "$dir/CMakeCache.txt" ]; then
    echo "configuring anira build (first run downloads LibTorch — long)…"
    # Cache OUTSIDE the source tree — iCloud evicts content under ~/Documents
    # (docs/2026-07-10-cpm-cache-icloud-eviction.md); matches the CMakeLists default.
    cmake -S "$ROOT" -B "$dir" -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DMOSH_ENABLE_ANIRA=ON -DCPM_SOURCE_CACHE="${MOSH_WORK_DIR:-$HOME/Library/Mosh/work}/cpm-cache" \
      ${FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE:+-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE="$FETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE"}
  fi
  echo "building Mosh (anira → $dir)…"
  cmake --build "$dir"
}

refresh_icon_cache() { touch "$1"; killall Finder 2>/dev/null || true; killall Dock 2>/dev/null || true; }

# --- Developer-ID signing + notarization (for shareable, double-click-to-open builds) ---
# The everyday `deploy` stays ad-hoc + local + fast. `release` produces a NOTARIZED,
# stapled DMG (+ zip) that any friend opens by double-clicking — no Gatekeeper wall, no
# right-click-Open, no `xattr`. Secrets never touch the repo or this script: the signing
# identity lives in the keychain (or MOSH_SIGN_IDENTITY) and notary creds live in a
# keychain profile (or MOSH_NOTARY_APPLE_ID/TEAM_ID/PASSWORD).
#
# The actual sign/notarize/staple/verify mechanics (incl. entitlements, the fail-closed
# credential preflight, and the Info.plist regression guard) live in ONE place —
# scripts/release/sign-and-notarize.sh — shared with .github/workflows/release.yml so
# the local and CI release paths can never drift apart. See that script's own header
# comment for the full env-var contract, and docs/release/SIGNING_RUNBOOK.md for the
# one-time owner setup. This `release` verb is unchanged in shape from before
# (build → stage → bundle → sign → notarize → dmg → sign/notarize the dmg → zip); only
# the signing/notarizing STEPS themselves were extracted out to be independently
# testable and CI-reusable.
RELEASE_SIGN="$ROOT/scripts/release/sign-and-notarize.sh"

# Build a drag-to-Applications DMG from an app bundle. Delegates to
# scripts/release/make-dmg.sh (shared with .github/workflows/release.yml) — one
# implementation, not two copies that can drift.
make_dmg() {                                     # $1 = app, $2 = output .dmg
  "$ROOT/scripts/release/make-dmg.sh" "$1" "$2" "Mosh"
}

case "$MODE" in
  smoke|gui|build)
    [ "$MODE" = build ] && { build_app; MODE="gui"; }
    APP="$(resolve_app)"; BIN="$APP/Contents/MacOS/Mosh"
    if [ -z "$APP" ] || [ ! -x "$BIN" ]; then
      echo "Mosh.app not built. Build it first:  ./run-mosh.sh build" >&2; exit 1
    fi
    case "$MODE" in
      smoke) exec "$BIN" --brain-smoke ;;
      gui)   echo "launching Mosh ($APP)…"; exec "$BIN" ;;
    esac
    ;;

  deploy)
    refuse_provider_brain_keys
    build_app macos-arm64-release macos-arm64-release-app
    APP="$(find "$ROOT/build-macos-arm64-release" -maxdepth 4 -name 'Mosh.app' -type d 2>/dev/null | sort | tail -n 1)"
    [ -n "$APP" ] || { echo "no built app to deploy" >&2; exit 1; }
    DEST="/Applications/Mosh.app"
    install_app "$APP" "$DEST"
    bundle_service "$DEST"
    bundle_brain_key "$DEST"
    packaging_check "$DEST"          # FS-K4 — fail-closed BEFORE sealing the bundle
    sign_app "$DEST" "ad-hoc"        # re-seal after service + brain-key edits (covers brain.env)
    finish_deployed_app "$DEST"
    echo "deployed one canonical /Applications/Mosh.app (default build; service bundled)."
    echo "If macOS still shows an old icon, log out and back in (icon cache)."
    ;;

  deploy-anira)
    refuse_provider_brain_keys
    build_anira
    APP=""
    while IFS= read -r p; do APP="$p"; break; done \
      < <(find "$ROOT/build-anira" -maxdepth 4 -name 'Mosh.app' -type d 2>/dev/null)
    [ -n "$APP" ] || { echo "anira app not found under build-anira/ (build failed?)" >&2; exit 1; }
    DEST="/Applications/Mosh.app"
    install_app "$APP" "$DEST"
    bundle_service "$DEST"
    bundle_brain_key "$DEST"
    selfcontain_anira "$DEST"
    # FS-K4 — this path deliberately DOES carry anira/LibTorch, so the check runs warn-only:
    # it is the private, non-distributable build (SPEC §1.11 / BOM §0 fact 2 — in-tree and
    # undistributed creates no obligation). Warn loudly so nobody notarizes or shares it.
    packaging_check "$DEST" warn-only
    echo "⚠️  NON-DISTRIBUTABLE BUILD (anira/RAVE present) — never notarize, release or share this bundle."
    finish_deployed_app "$DEST"
    echo "deployed anira /Applications/Mosh.app (real-time RAVE + service bundled; LibTorch self-contained)."
    echo "drop a real RAVE <target>.ts into ~/AI/rave-models — the '+ RAVE' rack button then hosts it live."
    ;;

  release)
    refuse_provider_brain_keys

    # --- preflight: fail fast, before spending 10+ min on a Release build, if signing
    # identity / notary credentials aren't ready. Exact instructions on failure — see
    # scripts/release/sign-and-notarize.sh's own preflight/resolve_* functions.
    "$RELEASE_SIGN" --preflight-only

    # --- build Release, stage, bundle service + brain proxy, sign, notarize, DMG ---
    build_app macos-arm64-release macos-arm64-release-app
    APP="$(resolve_app)"
    [ -n "$APP" ] || { echo "no built app to release" >&2; exit 1; }
    OUTDIR="${MOSH_RELEASE_DIR:-$HOME/Desktop/Mosh-share}"
    mkdir -p "$OUTDIR"
    STAGED="$OUTDIR/Mosh.app"
    install_app "$APP" "$STAGED"
    bundle_service "$STAGED"
    bundle_brain_key "$STAGED"            # the key is sealed INTO the notarized bundle (see note below)
    # FS-K4 — BEFORE signing on purpose: signing here also notarizes, which UPLOADS the
    # bundle to Apple. A compliance failure must stop the release while it is still local.
    packaging_check "$STAGED"
    echo "signing + notarizing + stapling the app…"
    "$RELEASE_SIGN" "$STAGED"
    DMG="$OUTDIR/Mosh.dmg"
    echo "building DMG…"
    make_dmg "$STAGED" "$DMG"
    echo "signing + notarizing + stapling the DMG…"
    "$RELEASE_SIGN" "$DMG"
    ZIP="$OUTDIR/Mosh.zip"; rm -f "$ZIP"; ditto -c -k --keepParent "$STAGED" "$ZIP"
    echo
    echo "✅ Notarized + stapled — friends can DOUBLE-CLICK to open (no right-click / xattr):"
    echo "   DMG (drag-to-Applications): $DMG"
    echo "   ZIP (AirDrop-friendly):     $ZIP"
    spctl -a -t exec -vv "$STAGED" 2>&1 | sed 's/^/   gatekeeper: /'
    echo "   brain.env contains only the proxy URL and publishable proxy credential."
    ;;

  *)     echo "usage: $0 [gui|smoke|build|deploy|deploy-anira|release]" >&2; exit 2 ;;
esac
