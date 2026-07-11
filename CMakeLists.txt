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
project(Mosh VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if (APPLE)
    set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "v0 is arm64-only")
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
endif()

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

include(cmake/CPM.cmake)
include(cmake/Dependencies.cmake)

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
        # Moshi's brain (server-side LLM proxy) + native voice (macOS Speech) — the
        # packaged-app equivalents of the Vite dev brain proxy + browser Web Speech.
        src/brain/BrainProxy.cpp
        # RT-safety tripwire (debug-only; compiles to nothing in Release — see MOSH_RT_GUARD)
        src/audio/RealtimeAudioGuard.cpp
        # Stage 1 — Engine + MoshOps spine + state feed (01, 02)
        src/engine/MoshEngine.cpp
        src/moshops/MoshOps.cpp
        # MP-001 — 2-player multiplayer (track-lock + commit-on-move)
        src/multiplayer/TrackCommit.cpp
        src/multiplayer/MultiplayerClient.cpp
        src/multiplayer/LockManager.cpp
        src/multiplayer/OutboundQueue.cpp
        src/multiplayer/MultiplayerSession.cpp
        # Stage 3 — VST3 hosting (04 PART 1)
        src/plugins/hosting/PluginHost.cpp
        # Moshi reactivity — master-output spectral tap (pure measure)
        src/plugins/spectral/MasterSpectralTapPlugin.cpp
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

    # Route C.2 — real-time RAVE insert via anira + LibTorch (gated; default build OFF).
    if (MOSH_ENABLE_ANIRA AND TARGET mosh_neural_backends)
        target_link_libraries(Mosh PRIVATE mosh_neural_backends)
    endif()

    # ── Native voice: macOS Speech (SFSpeechRecognizer + AVAudioEngine) ───────
    # Obj-C++ with ARC; the browser Web Speech API covers the Vite dev path.
    if (APPLE)
        target_sources(Mosh PRIVATE src/voice/NativeSpeech.mm)
        set_source_files_properties(src/voice/NativeSpeech.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
        target_link_libraries(Mosh PRIVATE "-framework Speech" "-framework AVFoundation")

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
        set(MOSH_INJECT_PLIST_SCRIPT "${CMAKE_SOURCE_DIR}/cmake/InjectInfoPlistKeys.cmake")
        add_custom_command(TARGET Mosh POST_BUILD
            COMMAND ${CMAKE_COMMAND}
                    -DPLIST=$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist
                    -P "${MOSH_INJECT_PLIST_SCRIPT}"
            COMMENT "Re-injecting Info.plist keys PLIST_TO_MERGE drops (speech + Bonjour + camera)"
            VERBATIM)
        add_custom_target(MoshFixInfoPlist ALL
            COMMAND ${CMAKE_COMMAND}
                    -DPLIST=$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist
                    -P "${MOSH_INJECT_PLIST_SCRIPT}"
            COMMENT "Re-injecting Info.plist keys into the app (no-relink/deploy-safe backstop)"
            VERBATIM)
        add_dependencies(MoshFixInfoPlist Mosh)

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
                    -P "${CMAKE_SOURCE_DIR}/cmake/RefreshMacBundleMetadata.cmake"
            COMMENT "Refreshing macOS bundle Info.plist and ad-hoc signature"
            VERBATIM)
        add_dependencies(MoshRefreshBundleMetadata Mosh MoshFixInfoPlist)
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
