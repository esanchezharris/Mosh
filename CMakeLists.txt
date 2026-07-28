cmake_minimum_required(VERSION 3.24)

# ─────────────────────────────────────────────────────────────────────────────
# Mosh - native hybrid DAW (standalone JUCE 8 app, NOT a plugin).
# macOS / Apple Silicon remains canonical (MLX generative backend); Windows +
# NVIDIA/CUDA is an additive portability layer (every platform fork is guarded so
# the macOS path is behaviour-equivalent). Linux (x86_64) is an EXPLORATORY spike:
# the headless MoshTests target + the cross-platform Python service build; the full
# GUI app (WebKitGTK webview + ALSA audio + JUCE Linux VST3 hosting) is CI-tracked
# but not yet a supported target. See docs/2026-07-07-linux-build-spike.md.
# ─────────────────────────────────────────────────────────────────────────────
# ── macOS target selection — MUST stay ABOVE project() ────────────────────────
# project() itself creates an EMPTY CMAKE_OSX_DEPLOYMENT_TARGET cache entry as part
# of Darwin platform detection. A `set(... CACHE STRING "")` AFTER that line is a
# silent no-op (CACHE without FORCE never overwrites an existing entry), so the 11.0
# below sat dead from the day it was written: builds inherited the host SDK default
# and shipped `minos 26.0` — an app that refuses to launch on anything older than
# macOS 26, while docs/TESTER_QUICKSTART.md promised "macOS 11 (Big Sur) or newer"
# and NativeSpeech/WebView guarded macOS 12 APIs behind @available for a floor that
# never existed. Above project() the cache entry does not exist yet, so these defaults
# apply AND an explicit -D / preset value still wins. Verify after any edit here:
#   otool -l <Mosh.app>/Contents/MacOS/Mosh | grep -A3 LC_BUILD_VERSION   # minos 11.0
#
# arm64 is the only target: scope is deliberately Apple Silicon only. (#462 proposed a
# Universal 2 switch and was CLOSED on scope 2026-08-04 — MLX is Apple-Silicon-only, so an
# x86_64 slice would ship an app with no SA3 generative tier.)
if (CMAKE_HOST_APPLE)
    set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "default target arch; presets may override")
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "minimum supported macOS")

    # SELF-HEAL for build dirs configured before the fix above. Being above project() only
    # helps a FRESH cache: an existing build-*/CMakeCache.txt already holds the empty entry
    # project() wrote back then, and CACHE-without-FORCE never overwrites one — so every
    # long-lived build dir (dev machines, the auto-loop) would silently keep producing
    # minos-26 binaries until someone thought to wipe it. Deleting build dirs by hand is
    # whack-a-mole; heal it here instead.
    #
    # Only an EMPTY value is healed, so an explicit -DCMAKE_OSX_DEPLOYMENT_TARGET=... or a
    # preset cacheVariable (both applied before this file is processed, hence non-empty)
    # still wins.
    if (NOT CMAKE_OSX_DEPLOYMENT_TARGET)
        set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "minimum supported macOS" FORCE)
        message(STATUS "Mosh: healed an empty CMAKE_OSX_DEPLOYMENT_TARGET in a pre-existing cache → 11.0")
    endif()
endif()

# FS-K2 — the shipped version, overridable (-DMOSH_VERSION=0.1.2) because auto-update is
# only testable ACROSS two of them: the gate is "install 0.1.x, publish 0.1.y, update,
# relaunch on 0.1.y", and Sparkle decides what is newer by comparing exactly this value
# (CFBundleVersion / CFBundleShortVersionString, both fed from here by JUCE). Editing this
# line for every test build would put a version bump in the diff of unrelated work.
set(MOSH_VERSION "0.1.1" CACHE STRING "Bundle version (CFBundleShortVersionString + CFBundleVersion)")
project(Mosh VERSION ${MOSH_VERSION} LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Keep a single CPM/FetchContent cache so re-configures don't re-download.
#
# Developer Macs: the cache MUST default OUTSIDE the source tree. ~/Documents is
# iCloud-synced, and iCloud EVICTS file content ("dataless" files that stat at full
# size but read 0 bytes) — a rotted in-tree .cpm-cache/_fc/tracktion_engine-src broke
# every fresh configure with 'Unknown CMake command "juce_add_modules"'. Diagnosis:
# docs/2026-07-10-cpm-cache-icloud-eviction.md. Explicit -D overrides always win over
# these CACHE defaults (auto-loop's gate.sh passes -DCPM_SOURCE_CACHE /
# -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE from ~/.mosh-auto-loop/auto-loop.env).
if(APPLE AND NOT "$ENV{CI}")
    # Same non-iCloud root as scripts/auto-loop/seed-cache.sh and run-mosh.sh.
    if(DEFINED ENV{MOSH_WORK_DIR})
        set(_mosh_work "$ENV{MOSH_WORK_DIR}")
    else()
        set(_mosh_work "$ENV{HOME}/Library/Mosh/work")
    endif()
    set(CPM_SOURCE_CACHE "${_mosh_work}/cpm-cache" CACHE PATH "CPM dep cache")
    # The SOURCE cache is shareable across checkouts; FETCHCONTENT_BASE_DIR is NOT
    # (juceaide cross-dir CMakeCache error — see seed-cache.sh), so _fc keeps the
    # in-tree default's per-checkout granularity via a source-dir key.
    get_filename_component(_mosh_src_name "${CMAKE_SOURCE_DIR}" NAME)
    string(SHA1 _mosh_src_key "${CMAKE_SOURCE_DIR}")
    string(SUBSTRING "${_mosh_src_key}" 0 12 _mosh_src_key)
    set(FETCHCONTENT_BASE_DIR "${_mosh_work}/fc/${_mosh_src_name}-${_mosh_src_key}" CACHE PATH "")
    unset(_mosh_work)
    unset(_mosh_src_name)
    unset(_mosh_src_key)
else()
    # GitHub runners set CI=true and cache the in-tree path (.github/workflows/
    # {ci,linux-ci}.yml); Windows/Linux have no iCloud — all keep the in-source default.
    set(CPM_SOURCE_CACHE "${CMAKE_SOURCE_DIR}/.cpm-cache" CACHE PATH "CPM dep cache")
    set(FETCHCONTENT_BASE_DIR "${CMAKE_SOURCE_DIR}/.cpm-cache/_fc" CACHE PATH "")
endif()
message(STATUS "Mosh deps: CPM_SOURCE_CACHE=${CPM_SOURCE_CACHE}")
message(STATUS "Mosh deps: FETCHCONTENT_BASE_DIR=${FETCHCONTENT_BASE_DIR}")

option(MOSH_BUILD_APP "Build the standalone JUCE app" ON)
option(MOSH_BUILD_UI "Build the React/Vite UI bundle as part of CMake" ON)
option(MOSH_BUILD_TESTS "Build the Catch2 + command-surface test target" ON)
option(MOSH_BUILD_PLUGIN_FIXTURES "Build deterministic in-repo VST3 fixtures for plugin-host smoke tests" OFF)
# Linux audio backend: ALSA is JUCE's Linux default and is always on. JACK is opt-in
# (needs libjack-dev); it is additive — the ALSA path is unchanged when this is OFF.
option(MOSH_ENABLE_JACK "Also enable the JACK audio backend on Linux (needs libjack-dev)" OFF)

# ── Sanitizers (diagnostic builds only) ──────────────────────────────────────────
# MOSH_SANITIZE = address | thread | undefined | "" (default, OFF).
#
# Why this exists: `--selftest` intermittently SIGSEGVs (rc=139) with the faulting
# frame in juce::ThreadPool::runNextJob and a PAC-garbage pointer — the signature of
# a freed ThreadPoolJob. That is a use-after-free / data race, and the ONLY cheap way
# to name the object and both stacks is a sanitizer build. Before this, the repo had
# no sanitizer path at all (MOSH_RT_GUARD is a Debug-only alloc tripwire on the audio
# thread, a different tool for a different job).
#
# NOT wired into any preset that ships or gates: this is opt-in, it changes codegen
# and is far too slow for the merge gate. Use it to diagnose, then pin the fix with a
# normal test.
#
# address+undefined compose; thread must be built alone (ASan and TSan are mutually
# exclusive in clang).
set(MOSH_SANITIZE "" CACHE STRING "Sanitizer for diagnostic builds: address|thread|undefined (empty = off)")
if(MOSH_SANITIZE)
  if(MSVC)
    message(FATAL_ERROR "MOSH_SANITIZE is clang/gcc-only; not supported under MSVC")
  endif()
  set(_mosh_san_flags -fsanitize=${MOSH_SANITIZE} -fno-omit-frame-pointer -g)
  # Keep symbol names readable in the report and stop the optimiser folding the
  # frames we need to read.
  add_compile_options(${_mosh_san_flags} -fno-optimize-sibling-calls)
  add_link_options(${_mosh_san_flags})
  message(STATUS "Mosh: SANITIZER BUILD (-fsanitize=${MOSH_SANITIZE}) — diagnostic only, never a gate build")
endif()

include(cmake/CPM.cmake)
include(cmake/Dependencies.cmake)
# FS-K3 — Sentry crash reporting. Defines the MOSH_ENABLE_SENTRY option (OFF) and,
# only when it is ON, fetches the pinned sentry-native + crashpad. A separate file
# from Dependencies.cmake on purpose — see the header comment there.
include(cmake/Sentry.cmake)

# Platform capability flags. AU plug-in hosting is a macOS-only format; on Windows
# the JUCE WebView is backed by WebView2 (Edge Chromium) rather than the legacy
# control, so the React UI renders identically to the macOS WKWebView. On Linux the
# WebView is backed by WebKitGTK (JUCE's Linux JUCE_WEB_BROWSER path) — no WebView2,
# no AU. VST3 hosting (JUCE_PLUGINHOST_VST3, set unconditionally below) is portable.
if (APPLE)
    set(MOSH_PLUGINHOST_AU 1)
    set(MOSH_USE_WIN_WEBVIEW2 0)
elseif (WIN32)
    set(MOSH_PLUGINHOST_AU 0)
    set(MOSH_USE_WIN_WEBVIEW2 1)
elseif (UNIX AND NOT APPLE)
    # Linux: WebView = WebKitGTK, audio = ALSA (+ optional JACK), no AU/WebView2.
    set(MOSH_PLUGINHOST_AU 0)
    set(MOSH_USE_WIN_WEBVIEW2 0)
else()
    set(MOSH_PLUGINHOST_AU 0)
    set(MOSH_USE_WIN_WEBVIEW2 0)
endif()

# ── The app target ───────────────────────────────────────────────────────────
if (MOSH_BUILD_APP)
    set(MOSH_APP_EXTRA_ARGS "")
    if (APPLE)
        list(APPEND MOSH_APP_EXTRA_ARGS
            LOCAL_NETWORK_PERMISSION_ENABLED TRUE
            LOCAL_NETWORK_PERMISSION_TEXT "Mosh uses the local network to pair with the iPhone companion while you are near this Mac."
            # Microphone: recording + native voice (NSMicrophoneUsageDescription).
            MICROPHONE_PERMISSION_ENABLED TRUE
            MICROPHONE_PERMISSION_TEXT "Mosh uses the microphone to record audio and to let you talk to Moshi, your in-app collaborator."
            # NSSpeechRecognitionUsageDescription rides in the merged plist (no JUCE flag).
            PLIST_TO_MERGE "${CMAKE_SOURCE_DIR}/cmake/MoshRemoteInfo.plist")
    endif()

    juce_add_gui_app(Mosh
        PRODUCT_NAME "Mosh"
        BUNDLE_ID    "studio.mosh.app"
        COMPANY_NAME "Mosh"
        # The Moshi face. JUCE converts this PNG to the bundle's AppIcon.icns at
        # build time — it is the single source of truth for the app icon.
        ICON_BIG     "${CMAKE_SOURCE_DIR}/resources/icon/MoshIcon.png"
        # WebView2 (Edge Chromium) backs the WebView on Windows. JUCE ignores this
        # on non-Windows, so it is safe to pass unconditionally.
        NEEDS_WEBVIEW2 TRUE
        ${MOSH_APP_EXTRA_ARGS})

# Source modules (00 §5). Added incrementally per build stage.
    target_sources(Mosh PRIVATE
        src/Main.cpp
        src/app/MainWindow.cpp
        src/app/MenuController.cpp
        src/app/WebViewShell.cpp
        src/app/SelfTest.cpp
        src/webview/WebBridge.cpp
        # AL-012 — UI resource-provider path-traversal guard (see WebBridge.cpp's
        # serveUiResource); split out so it's testable without juce_gui_extra.
        src/webview/UiResourcePathGuard.cpp
        src/files/DirectoryListing.cpp
        # Moshi's brain (server-side LLM proxy) + native voice (macOS Speech) — the
        # packaged-app equivalents of the Vite dev brain proxy + browser Web Speech.
        src/brain/BrainProxy.cpp
        # RT-safety tripwire (debug-only; compiles to nothing in Release — see MOSH_RT_GUARD)
        src/audio/RealtimeAudioGuard.cpp
        # CAP-EXP-001 — TPDF dither on the export's final requantisation (offline only;
        # the pure quantiser in TpdfDither.h is header-only so MoshTests can unit it).
        src/audio/DitheringAudioFormat.cpp
        # Opt-in, privacy-respecting crash reporting + telemetry (self-contained
        # module; see docs/telemetry/PRIVACY.md). Installed from ONE line at the
        # top of Main.cpp's initialise().
        src/telemetry/Breadcrumbs.cpp
        src/telemetry/CrashReportFormatter.cpp
        src/telemetry/TelemetryConfig.cpp
        src/telemetry/Telemetry.cpp
        src/telemetry/CrashHandler.cpp
        # FS-K3 — Sentry (crashpad) reporter. Compiled unconditionally; MOSH_HAVE_SENTRY
        # gates its BODY, not its existence (the RaveEngine.cpp arrangement), so the
        # default build compiles the no-op branch and the pure PII scrubber inside it
        # stays unit-testable in MoshTests with no SDK linked.
        src/telemetry/SentryReporter.cpp
        # Stage 1 — Engine + MoshOps spine + state feed (01, 02)
        src/engine/MoshEngine.cpp
        src/moshops/MoshOps.cpp
        src/moshops/MoshOps.Lyrics.cpp
        src/moshops/MoshOps.Notes.cpp
        src/moshops/MoshOps.Live.cpp
        src/moshops/MoshOps.Record.cpp
        src/moshops/MoshOps.Clips.cpp
        src/moshops/MoshOps.Tracks.cpp
        src/moshops/MoshOps.TempoProject.cpp
        src/moshops/MoshOps.Plugins.cpp
        src/moshops/MoshOps.Mixer.cpp
        src/moshops/MoshOps.Generative.cpp
        src/moshops/MoshOps.Multiplayer.cpp
        src/moshops/MoshOps.ProjectIo.cpp
        # MP-001 — 2-player multiplayer (track-lock + commit-on-move)
        src/multiplayer/TrackCommit.cpp
        src/multiplayer/MultiplayerClient.cpp
        src/multiplayer/LockManager.cpp
        src/multiplayer/OutboundQueue.cpp
        src/multiplayer/TransferQueue.cpp
        src/multiplayer/MultiplayerSession.cpp
        # Stage 3 — VST3 hosting (04 PART 1)
        src/plugins/hosting/PluginHost.cpp
        # Moshi reactivity — master-output spectral tap (pure measure)
        src/plugins/spectral/MasterSpectralTapPlugin.cpp
        # CAP-AUT-006 — the per-track mute gate (hidden mixer element, one automatable param)
        src/plugins/mixer/TrackMutePlugin.cpp
        # Mosh-native FX suite — in-app Tracktion built-ins.
        src/plugins/moshfx/MoshAutoTuneDsp.cpp
        src/plugins/moshfx/MoshAutoTunePlugin.cpp
        src/plugins/moshfx/MoshOTTDsp.cpp
        src/plugins/moshfx/MoshOTTPlugin.cpp
        src/plugins/moshfx/MoshXFeedbackDsp.cpp
        src/plugins/moshfx/MoshXFeedbackPlugin.cpp
        # Route C.2 — real-time RAVE insert (gated; compiles to nothing without anira).
        # Torch lives ONLY in RaveEngine.cpp to isolate the LibTorch↔JUCE headers.
        src/plugins/transform/RaveEngine.cpp
        src/plugins/transform/RaveInsertPlugin.cpp
        # Stage 5 — Tier-B generative layer (05)
        src/generative/GenerativeJobManager.cpp
        # Stage 7 — rights-cleared type-beat LoRA training
        src/training/TrainerRegistry.cpp
        src/training/TrainingJobManager.cpp
        # iPhone companion remote control + phone-take ingest
        src/remote/RemoteCompanionProtocol.cpp
        src/remote/RemoteCompanionServer.cpp)

    target_include_directories(Mosh PRIVATE src)

    target_compile_definitions(Mosh PRIVATE
        JUCE_WEB_BROWSER=1
        # On Windows, render the WebView via WebView2 (Edge Chromium); 0 elsewhere.
        JUCE_USE_WIN_WEBVIEW2=${MOSH_USE_WIN_WEBVIEW2}
        JUCE_USE_CURL=0
        # VST3/AU hosting (04 PART 1) — compiles JUCE's hosting format classes.
        JUCE_PLUGINHOST_VST3=1
        JUCE_PLUGINHOST_AU=${MOSH_PLUGINHOST_AU}
        JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Mosh,JUCE_PRODUCT_NAME>"
        JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Mosh,JUCE_VERSION>"
        JUCE_MODAL_LOOPS_PERMITTED=1
        # Audio warp (auto-tempo time-stretch): enable the engine's VENDORED
        # SoundTouch (modules/tracktion_engine/3rd_party/soundtouch — no new external
        # dependency). Makes TimeStretcher::defaultMode = soundtouchBetter so warped
        # clips genuinely time-stretch instead of Mode::disabled varispeed.
        TRACKTION_ENABLE_TIMESTRETCH_SOUNDTOUCH=1
        # Mosh build identity / stage flags
        MOSH_VERSION_STRING="${PROJECT_VERSION}"
        # RT-safety tripwire — Debug ONLY. Release leaves MOSH_RT_GUARD undefined so the
        # guard header collapses to inline no-ops and RealtimeAudioGuard.cpp compiles to
        # nothing (no global operator new override) → Release binary byte-unaffected.
        $<$<CONFIG:Debug>:MOSH_RT_GUARD=1>)

    # ── Linux audio backend (juce_audio_devices) ─────────────────────────────
    # ALSA is JUCE's Linux default and is present on every distro; JACK is opt-in
    # via MOSH_ENABLE_JACK (needs libjack-dev). No effect on macOS/Windows.
    if (UNIX AND NOT APPLE)
        target_compile_definitions(Mosh PRIVATE
            JUCE_ALSA=1
            JUCE_JACK=$<BOOL:${MOSH_ENABLE_JACK}>)
    endif()

    target_link_libraries(Mosh PRIVATE
        tracktion::tracktion_engine
        juce::juce_gui_extra
        juce::juce_audio_utils
        juce::juce_cryptography
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

    # FS-K3 — Sentry crash reporting (gated; default build OFF). Both calls are
    # no-ops without MOSH_ENABLE_SENTRY, so the default target definition is
    # unchanged.
    if (MOSH_ENABLE_SENTRY AND TARGET mosh_sentry)
        target_link_libraries(Mosh PRIVATE mosh_sentry)
    endif()
    mosh_sentry_stage_handler(Mosh)
    mosh_sentry_emit_dsym(Mosh)

    # Route C.2 — real-time RAVE insert via anira + LibTorch (gated; default build OFF).
    if (MOSH_ENABLE_ANIRA AND TARGET mosh_neural_backends)
        target_link_libraries(Mosh PRIVATE mosh_neural_backends)
        if (MSVC)
            # anira/anira.h pulls the full torch header surface into RaveEngine.cpp —
            # a >65k-COFF-sections TU on MSVC without /bigobj. /GL- opts this TU out
            # of whole-program codegen: LTCG over the torch headers OOMs link.exe
            # (LNK1257) and took the whole box down once; the rest of the app keeps
            # LTO. Mixing a /GL- TU into an /LTCG link is supported.
            set_source_files_properties(src/plugins/transform/RaveEngine.cpp
                PROPERTIES COMPILE_OPTIONS "/bigobj;/GL-")
        endif()
        if (WIN32)
            # Stage the LibTorch runtime DLLs next to Mosh.exe (the Windows analogue
            # of run-mosh.sh selfcontain_anira; run-mosh.ps1 -Package's wildcard
            # *.dll copy then ships them). anira builds STATIC as our subdirectory
            # (BUILD_SHARED_LIBS unset) but links LibTorch dynamically, so the exe
            # needs torch.dll & co at load — 0xC0000135 without them. Glob the
            # fetched libtorch directly: anira's ANIRA_SHARED_LIBS_WIN PARENT_SCOPE
            # export does not reliably reach this scope.
            file(GLOB MOSH_ANIRA_RUNTIME_DLLS
                 "${anira_SOURCE_DIR}/modules/libtorch-*/lib/*.dll")
            if (MOSH_ANIRA_RUNTIME_DLLS)
                # $<TARGET_FILE:anira> = the built anira.dll (it defaults to a
                # SHARED lib even as a subdirectory), living under the CPM _deps
                # build dir where no glob at configure time can see it.
                add_custom_command(TARGET Mosh POST_BUILD
                    COMMAND ${CMAKE_COMMAND} -E copy_if_different
                            $<TARGET_FILE:anira>
                            ${MOSH_ANIRA_RUNTIME_DLLS} "$<TARGET_FILE_DIR:Mosh>"
                    COMMENT "Staging anira + LibTorch runtime DLLs next to Mosh.exe"
                    VERBATIM)
            else()
                message(WARNING "MOSH_ENABLE_ANIRA: no LibTorch DLLs found under "
                    "${anira_SOURCE_DIR}/modules — Mosh.exe will fail to load (0xC0000135).")
            endif()
        endif()
    endif()

    # ── Native voice: macOS Speech (SFSpeechRecognizer + AVAudioEngine) ───────
    # Obj-C++ with ARC; the browser Web Speech API covers the Vite dev path.
    if (APPLE)
        target_sources(Mosh PRIVATE src/voice/NativeSpeech.mm)
        set_source_files_properties(src/voice/NativeSpeech.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
        target_link_libraries(Mosh PRIVATE "-framework Speech" "-framework AVFoundation")

        # FS-K2 — Sparkle 2 auto-update. Obj-C++ with ARC, same pattern as the two
        # .mm TUs above. Compiles unconditionally on Apple; the Sparkle calls inside
        # are behind MOSH_HAVE_SPARKLE, which cmake/Sparkle.cmake defines only when the
        # framework is actually fetched and embedded (-DMOSH_ENABLE_SPARKLE=OFF builds
        # the same TU as a no-op, so the call sites never need their own guards).
        target_sources(Mosh PRIVATE src/app/SparkleUpdater.mm)
        set_source_files_properties(src/app/SparkleUpdater.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
        include(cmake/Sparkle.cmake)

        # Suppress AppKit's window-restoration / "reopen after crash" modal on headless
        # CLI launches (see src/app/MacStateRestoration.h). Obj-C++ with ARC.
        target_sources(Mosh PRIVATE src/app/MacStateRestoration.mm)
        set_source_files_properties(src/app/MacStateRestoration.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")

        # Native WKWebView media-capture permission delegate (collaborator video
        # getUserMedia) — Obj-C++ with ARC; mirrors the NativeSpeech.mm pattern.
        target_sources(Mosh PRIVATE src/webview/WebViewCameraPermission.mm)
        set_source_files_properties(src/webview/WebViewCameraPermission.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
        target_link_libraries(Mosh PRIVATE "-framework WebKit")

        # JUCE's PLIST_TO_MERGE is honoured ONLY by the Xcode generator; under the
        # Makefiles/Ninja generator this repo uses, those merged keys are silently
        # dropped from the bundle Info.plist. Re-inject the ones we depend on:
        #   • NSSpeechRecognitionUsageDescription — MANDATORY, or SFSpeechRecognizer
        #     authorization TCC-CRASHES the app the moment the always-on voice starts
        #     (src/voice/NativeSpeech.mm). This has been misread as a plugin-host crash.
        #   • NSBonjourServices — or macOS 14+ won't advertise the iPhone-companion
        #     mDNS service (keep the type in sync with cmake/MoshRemoteInfo.plist).
        #   • NSCameraUsageDescription — collaborator video tiles (getUserMedia).
        # (Built-in flags MICROPHONE_PERMISSION_* / LOCAL_NETWORK_PERMISSION_* DO
        #  survive — they go through a different path than PLIST_TO_MERGE.)
        #
        # The keys live in ONE place (cmake/InjectInfoPlistKeys.cmake). We run it TWICE
        # for the SAME reason MoshStageUI exists (cmake/BuildUI.cmake): a POST_BUILD on
        # the Mosh target ONLY fires when Mosh relinks, so up-to-date / UI-only / deploy
        # builds would ship an UNPATCHED bundle (this is exactly how a TCC-crashing
        # /Applications/Mosh.app shipped). MoshFixInfoPlist (ALL, always-run) is the
        # injection-only backstop; MoshRefreshBundleMetadata below performs the final
        # inject + ad-hoc sign after resource staging.
        #
        # The Sparkle keys (SUFeedURL / SUPublicEDKey) ride the SAME path for the SAME
        # reason — a naively-merged SUPublicEDKey would be dropped by the generator and
        # the shipped app would refuse every update as unsigned.
        set(MOSH_INJECT_PLIST_SCRIPT "${CMAKE_SOURCE_DIR}/cmake/InjectInfoPlistKeys.cmake")
        set(MOSH_INJECT_PLIST_ARGS
            "-DMOSH_SPARKLE_FEED_URL=${MOSH_SPARKLE_FEED_URL}"
            "-DMOSH_SPARKLE_PUBLIC_KEY=${MOSH_SPARKLE_PUBLIC_KEY}")

        # PRJ-NAME — the .mosh document icon, derived from the SAME PNG as the app icon.
        # Staged BEFORE every inject (both the POST_BUILD below and MoshFixInfoPlist),
        # because the inject script now fail-closes on a missing Resources/MoshDoc.icns:
        # the plist would otherwise claim a document icon the bundle does not carry, and
        # Finder would silently fall back to a blank page. Mirrors the two-target shape
        # above for the identical reason — a POST_BUILD alone misses no-relink builds.
        set(MOSH_DOC_ICON_SCRIPT "${CMAKE_SOURCE_DIR}/cmake/BuildDocumentIcon.cmake")
        set(MOSH_DOC_ICON_ARGS
            -DSOURCE_PNG=${CMAKE_SOURCE_DIR}/resources/icon/MoshIcon.png
            -DOUT_ICNS=$<TARGET_BUNDLE_DIR:Mosh>/Contents/Resources/MoshDoc.icns)
        add_custom_command(TARGET Mosh POST_BUILD
            COMMAND ${CMAKE_COMMAND} ${MOSH_DOC_ICON_ARGS} -P "${MOSH_DOC_ICON_SCRIPT}"
            COMMENT "Building the .mosh document icon (Resources/MoshDoc.icns)"
            VERBATIM)
        add_custom_target(MoshStageDocIcon ALL
            COMMAND ${CMAKE_COMMAND} ${MOSH_DOC_ICON_ARGS} -P "${MOSH_DOC_ICON_SCRIPT}"
            COMMENT "Building the .mosh document icon (no-relink/deploy-safe backstop)"
            VERBATIM)
        add_dependencies(MoshStageDocIcon Mosh)

        add_custom_command(TARGET Mosh POST_BUILD
            COMMAND ${CMAKE_COMMAND}
                    -DPLIST=$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist
                    ${MOSH_INJECT_PLIST_ARGS}
                    -P "${MOSH_INJECT_PLIST_SCRIPT}"
            COMMENT "Re-injecting Info.plist keys PLIST_TO_MERGE drops (speech + Bonjour + camera + Sparkle + doc types)"
            VERBATIM)
        add_custom_target(MoshFixInfoPlist ALL
            COMMAND ${CMAKE_COMMAND}
                    -DPLIST=$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist
                    ${MOSH_INJECT_PLIST_ARGS}
                    -P "${MOSH_INJECT_PLIST_SCRIPT}"
            COMMENT "Re-injecting Info.plist keys into the app (no-relink/deploy-safe backstop)"
            VERBATIM)
        add_dependencies(MoshFixInfoPlist Mosh MoshStageDocIcon)

        # DRM-001 — stage the bundled drum kits into the app Resources so the native
        # sampler (MoshOps::drumKitDir) can load them at runtime. run-mosh.sh `deploy`
        # copies the whole .app, so the kit rides along to /Applications too.
        add_custom_command(TARGET Mosh POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                    "${CMAKE_SOURCE_DIR}/resources/drumkits"
                    "$<TARGET_BUNDLE_DIR:Mosh>/Contents/Resources/drumkits"
            COMMENT "Staging drum kits into Mosh.app/Contents/Resources/drumkits"
            VERBATIM)
    endif()

    # ── Non-Apple (Windows): native voice is stubbed (no SFSpeechRecognizer), and
    #    runtime resources are staged next to the .exe instead of into a bundle.
    #    NativeSpeech.mm is Objective-C++ (Apple-only); the stub TU satisfies the
    #    NativeSpeech.h surface WebBridge links against. ──────────────────────────
    if (NOT APPLE)
        target_sources(Mosh PRIVATE src/voice/NativeSpeech_stub.cpp)
        # Sparkle is macOS-only; the stub keeps Main.cpp/MenuController platform-free.
        target_sources(Mosh PRIVATE src/app/SparkleUpdater_stub.cpp)
        add_custom_command(TARGET Mosh POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                    "${CMAKE_SOURCE_DIR}/resources/drumkits"
                    "$<TARGET_FILE_DIR:Mosh>/drumkits"
            COMMENT "Staging drum kits next to the Mosh executable"
            VERBATIM)

        # Windows: stage the MSVC runtime redistributable DLLs (vcruntime140*, msvcp140)
        # next to Mosh.exe so a zipped self-contained build (run-mosh.ps1 -Package copies
        # the exe-adjacent DLLs) runs on a machine without the VC++ redistributable
        # installed. SKIP the module's own install() rule — we only want the resolved list.
        # macOS/Linux are unaffected (WIN32/MSVC false → this block is not emitted). CUDA
        # DLLs are NOT staged here: they live in the Python CUDA venv (torch wheels).
        if (WIN32 AND MSVC)
            set(CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS_SKIP TRUE)
            include(InstallRequiredSystemLibraries)
            if (CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
                add_custom_command(TARGET Mosh POST_BUILD
                    COMMAND ${CMAKE_COMMAND} -E copy_if_different
                            ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS}
                            "$<TARGET_FILE_DIR:Mosh>"
                    COMMENT "Staging MSVC runtime DLLs next to the Mosh executable"
                    VERBATIM)
            endif()
        endif()
    endif()

    # ── UI bundle (Vite) ─────────────────────────────────────────────────────
    if (MOSH_BUILD_UI)
        include(cmake/BuildUI.cmake)
        # Phone companion controller page (served by RemoteCompanionServer at /web).
        include(cmake/BuildCompanion.cmake)
    endif()

    if (APPLE)
        add_custom_target(MoshRefreshBundleMetadata ALL
            COMMAND ${CMAKE_COMMAND}
                    -DBUNDLE=$<TARGET_BUNDLE_DIR:Mosh>
                    -DPLIST=$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist
                    ${MOSH_INJECT_PLIST_ARGS}
                    -P "${CMAKE_SOURCE_DIR}/cmake/RefreshMacBundleMetadata.cmake"
            COMMENT "Refreshing macOS bundle Info.plist and ad-hoc signature"
            VERBATIM)
        add_dependencies(MoshRefreshBundleMetadata Mosh MoshFixInfoPlist MoshStageDocIcon)
        # The ad-hoc `codesign --deep` inside RefreshMacBundleMetadata seals whatever is
        # in the bundle, so Sparkle.framework must already be embedded when it runs —
        # otherwise the dev bundle's signature does not cover the framework and the app
        # fails codesign --verify --deep --strict the moment the framework lands.
        if (TARGET MoshEmbedSparkle)
            add_dependencies(MoshRefreshBundleMetadata MoshEmbedSparkle)
        endif()
        if (TARGET MoshStageUI)
            add_dependencies(MoshRefreshBundleMetadata MoshStageUI)
        endif()
        if (TARGET MoshStageCompanion)
            add_dependencies(MoshRefreshBundleMetadata MoshStageCompanion)
        endif()
    endif()
endif()

# ── Tests ────────────────────────────────────────────────────────────────────
if (MOSH_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

if (MOSH_BUILD_PLUGIN_FIXTURES)
    set(MOSH_PLUGIN_FIXTURE_VST3_COPY_DIR "${CMAKE_BINARY_DIR}/PluginFixtures/VST3" CACHE PATH "Build-tree VST3 fixture copy dir")
    add_subdirectory(src/plugin_fixtures)
endif()
