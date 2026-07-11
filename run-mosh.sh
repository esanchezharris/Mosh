#!/usr/bin/env bash
# run-mosh.sh — launch the built Mosh.app with brain keys + native voice, for a live
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
#            MOSH_RELEASE_DIR (release output dir, default ~/Desktop/Mosh-share).
#
# One-time setup for `release` (secrets stay in your keychain, never in the repo):
#   1. Create the cert: Xcode ▸ Settings ▸ Accounts ▸ <Apple ID> ▸ Manage Certificates…
#      ▸ + ▸ "Developer ID Application".  (An "Apple Development" cert can NOT notarize
#      for direct distribution — this is a separate certificate you must create.)
#   2. Store notary creds once (make an app-specific password at appleid.apple.com):
#        xcrun notarytool store-credentials "mosh-notary" \
#          --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-pw>
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
for p in DEEPSEEK OPENAI XAI; do
  k="${p}_API_KEY"
  if [ -n "${!k:-}" ]; then echo "  • $p: key present"; have_any=1; fi
done
if [ "$have_any" = 0 ]; then
  echo "  • no brain key found — paste one into ui/.env.local (voice still works;"
  echo "    the brain falls back to the offline mock without a key)"
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
  for d in adapters colors recipes sa3 scripts training lyrics phonology skeleton whisper soulx bestofn compiler; do
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
}

# Bundle the Moshi brain key(s) INTO the app so a Finder/Dock double-click (which inherits
# NO shell env, so run-mosh.sh's exports are absent) still has a working brain — BrainProxy
# reads Contents/Resources/brain.env as a fallback when the env var is missing. Keys come
# from ui/.env.local (already loaded above); brain.env is gitignored and lives ONLY in the
# bundle, never in git. (Security: anyone with the .app can read the key — don't share it.)
bundle_brain_key() {                            # $1 = installed app
  local DEST="$1" BF="$1/Contents/Resources/brain.env" v
  : > "$BF"
  for v in MOSHI_BRAIN_PROVIDER \
           OPENAI_BASE_URL OPENAI_MODEL OPENAI_API_KEY \
           DEEPSEEK_BASE_URL DEEPSEEK_MODEL DEEPSEEK_API_KEY \
           XAI_BASE_URL XAI_MODEL XAI_API_KEY; do
    [ -n "${!v:-}" ] && printf '%s=%s\n' "$v" "${!v}" >> "$BF"
  done
  chmod 600 "$BF" 2>/dev/null || true
  if [ -s "$BF" ]; then
    echo "bundled brain key → Contents/Resources/brain.env ($(grep -c '_API_KEY=' "$BF") provider key(s); Moshi has a brain on any launch)"
  else
    rm -f "$BF"
    echo "no brain key in env — skipped brain.env (paste one into ui/.env.local to bundle it)"
  fi
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

sign_app() {
  local DEST="$1" LABEL="${2:-ad-hoc}"
  xattr -cr "$DEST" 2>/dev/null || true
  codesign --force --deep --sign - "$DEST"
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
# identity lives in the keychain and notary creds live in a keychain profile.
ENTITLEMENTS="$ROOT/cmake/Mosh.entitlements"
NOTARY_PROFILE="${MOSH_NOTARY_PROFILE:-mosh-notary}"

# Echo the SHA-1 of an installed "Developer ID Application" identity, or empty if none.
# (An "Apple Development"/"Apple Distribution" cert is NOT accepted by notarization for
# direct distribution — it must be a Developer ID Application cert.)
dev_id_identity() {
  security find-identity -v -p codesigning 2>/dev/null \
    | awk '/Developer ID Application/ { print $2; exit }'
}

# Sign a bundle for distribution: Hardened Runtime (--options runtime) + secure timestamp,
# signed INSIDE-OUT (nested Mach-O first, the app bundle last with entitlements). Apple
# discourages --deep for distribution, so nested code is signed explicitly. In the default
# build there is no nested Mach-O (JUCE links statically); the anira build bundles LibTorch
# + libanira dylibs, which the find loop covers.
sign_app_developer_id() {                       # $1 = app, $2 = identity sha
  local DEST="$1" ID="$2" f
  xattr -cr "$DEST" 2>/dev/null || true
  while IFS= read -r f; do
    codesign --force --options runtime --timestamp --sign "$ID" "$f"
  done < <(find "$DEST/Contents" -type f \( -name '*.dylib' -o -name '*.so' \) 2>/dev/null)
  while IFS= read -r f; do
    codesign --force --options runtime --timestamp --sign "$ID" "$f"
  done < <(find "$DEST/Contents" -type d -name '*.framework' 2>/dev/null)
  # nested Mach-O *executables* (helper tools / scanners), if any. The default build has
  # none (only Contents/MacOS/Mosh, sealed with the bundle below); this future-proofs the
  # function against any helper a later build drops in — an unsigned nested Mach-O would
  # fail notarization since we (correctly) avoid --deep for distribution.
  while IFS= read -r f; do
    [ "$f" = "$DEST/Contents/MacOS/Mosh" ] && continue
    file "$f" 2>/dev/null | grep -q 'Mach-O' && \
      codesign --force --options runtime --timestamp --sign "$ID" "$f"
  done < <(find "$DEST/Contents/MacOS" "$DEST/Contents/Helpers" -type f 2>/dev/null)
  codesign --force --options runtime --timestamp \
           --entitlements "$ENTITLEMENTS" --sign "$ID" "$DEST"
  sleep 1; xattr -cr "$DEST" 2>/dev/null || true
  codesign --verify --deep --strict "$DEST"
  echo "  signature: valid (Developer ID, Hardened Runtime + entitlements)"
}

# Upload to Apple's notary service, wait for the verdict, then staple the ticket so the
# app validates OFFLINE on the friend's Mac. `--wait` blocks 1–5 min and exits nonzero
# on rejection (→ set -e aborts); inspect a failure with
#   xcrun notarytool log <submission-id> --keychain-profile "$NOTARY_PROFILE"
notarize_bundle() {                             # $1 = .app or .dmg
  local TARGET="$1" TMP="" SUBMIT="$1" rc=0
  if [[ "$TARGET" == *.app ]]; then
    TMP="$(mktemp -d)"                              # the .app must be zipped to submit
    SUBMIT="$TMP/$(basename "$TARGET" .app).zip"
    ditto -c -k --keepParent "$TARGET" "$SUBMIT"
  fi
  echo "  submitting to Apple notary (profile: $NOTARY_PROFILE) — 1–5 min…"
  # Don't let set -e abort before cleanup: the zip embeds brain.env (the key), so it must
  # never be left in /tmp on a rejection. Clean up on BOTH paths, then propagate failure.
  xcrun notarytool submit "$SUBMIT" --keychain-profile "$NOTARY_PROFILE" --wait || rc=$?
  [ -n "$TMP" ] && rm -rf "$TMP"
  [ "$rc" -eq 0 ] || return "$rc"
  echo "  stapling ticket…"
  xcrun stapler staple "$TARGET"
  xcrun stapler validate "$TARGET"
}

# Build a drag-to-Applications DMG from an app bundle.
make_dmg() {                                     # $1 = app, $2 = output .dmg
  local APP="$1" DMG="$2" STAGE rc=0
  STAGE="$(mktemp -d)"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"       # the classic drag target
  rm -f "$DMG"
  # Stage holds a full .app copy (incl. brain.env); clean it even if hdiutil fails.
  hdiutil create -volname "Mosh" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null || rc=$?
  rm -rf "$STAGE"
  return "$rc"
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
    build_app macos-arm64-release macos-arm64-release-app
    APP="$(resolve_app)"
    [ -n "$APP" ] || { echo "no built app to deploy" >&2; exit 1; }
    DEST="/Applications/Mosh.app"
    install_app "$APP" "$DEST"
    bundle_service "$DEST"
    bundle_brain_key "$DEST"
    sign_app "$DEST" "ad-hoc"        # re-seal after service + brain-key edits (covers brain.env)
    finish_deployed_app "$DEST"
    echo "deployed one canonical /Applications/Mosh.app (default build; service bundled)."
    echo "If macOS still shows an old icon, log out and back in (icon cache)."
    ;;

  deploy-anira)
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
    finish_deployed_app "$DEST"
    echo "deployed anira /Applications/Mosh.app (real-time RAVE + service bundled; LibTorch self-contained)."
    echo "drop a real RAVE <target>.ts into ~/AI/rave-models — the '+ RAVE' rack button then hosts it live."
    ;;

  release)
    # --- preflight: the two one-time prerequisites (fail with exact instructions) ---
    ID="$(dev_id_identity)"
    if [ -z "$ID" ]; then
      echo "✗ No 'Developer ID Application' certificate in your keychain." >&2
      echo "  Create it once: Xcode ▸ Settings ▸ Accounts ▸ <Apple ID> ▸ Manage Certificates…" >&2
      echo "                  ▸ + ▸ 'Developer ID Application'." >&2
      echo "  (An 'Apple Development' cert can't notarize for direct distribution.)" >&2
      exit 1
    fi
    echo "signing identity: $(security find-identity -v -p codesigning | awk -v id="$ID" '$0 ~ id {sub(/^[ ]*[0-9]+\) [0-9A-F]+ /,""); print; exit}')"
    if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
      echo "✗ Notary credentials profile '$NOTARY_PROFILE' not found (or invalid)." >&2
      echo "  Set it up once (make an app-specific password at appleid.apple.com first):" >&2
      echo "    xcrun notarytool store-credentials \"$NOTARY_PROFILE\" \\" >&2
      echo "      --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-pw>" >&2
      exit 1
    fi

    # --- build Release, stage, bundle service + brain key, sign, notarize, DMG ---
    build_app macos-arm64-release macos-arm64-release-app
    APP="$(resolve_app)"
    [ -n "$APP" ] || { echo "no built app to release" >&2; exit 1; }
    OUTDIR="${MOSH_RELEASE_DIR:-$HOME/Desktop/Mosh-share}"
    mkdir -p "$OUTDIR"
    STAGED="$OUTDIR/Mosh.app"
    install_app "$APP" "$STAGED"
    bundle_service "$STAGED"
    bundle_brain_key "$STAGED"            # the key is sealed INTO the notarized bundle (see note below)
    echo "signing for distribution…"
    sign_app_developer_id "$STAGED" "$ID"
    echo "notarizing app…"
    notarize_bundle "$STAGED"
    DMG="$OUTDIR/Mosh.dmg"
    echo "building DMG…"
    make_dmg "$STAGED" "$DMG"
    codesign --force --timestamp --sign "$ID" "$DMG"
    echo "notarizing DMG…"
    notarize_bundle "$DMG"
    ZIP="$OUTDIR/Mosh.zip"; rm -f "$ZIP"; ditto -c -k --keepParent "$STAGED" "$ZIP"
    echo
    echo "✅ Notarized + stapled — friends can DOUBLE-CLICK to open (no right-click / xattr):"
    echo "   DMG (drag-to-Applications): $DMG"
    echo "   ZIP (AirDrop-friendly):     $ZIP"
    spctl -a -t exec -vv "$STAGED" 2>&1 | sed 's/^/   gatekeeper: /'
    echo "   NOTE: brain.env (your OpenAI key) is sealed inside the notarized bundle, so it"
    echo "         was uploaded to Apple's notary service and is extractable by anyone you give"
    echo "         the app to. Keep an OpenAI spend limit set and don't post it publicly."
    ;;

  *)     echo "usage: $0 [gui|smoke|build|deploy|deploy-anira|release]" >&2; exit 2 ;;
esac
