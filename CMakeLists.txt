cmake_minimum_required(VERSION 3.24)

# ─────────────────────────────────────────────────────────────────────────────
# Mosh - native hybrid DAW (standalone JUCE 8 app, NOT a plugin).
# macOS / Apple Silicon remains canonical (MLX generative backend); Windows +
# NVIDIA/CUDA is an additive portability layer (every platform fork is guarded so
# the macOS path is behaviour-equivalent). No Linux build path is exercised yet.
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
set(CPM_SOURCE_CACHE "${CMAKE_SOURCE_DIR}/.cpm-cache" CACHE PATH "CPM dep cache")
set(FETCHCONTENT_BASE_DIR "${CMAKE_SOURCE_DIR}/.cpm-cache/_fc" CACHE PATH "")

# The Tier-A neural insert (Stage 4) is self-contained (a real RT-safe MLP) and
# ALWAYS built. The heavy external inference backends used to load standard model
# captures (RTNeural for NAM/Proteus, anira+LibTorch for RAVE/DDSP) are pinned in
# cmake/Dependencies.cmake and fetched only behind their own opt-in flags.
option(MOSH_ENABLE_RTNEURAL "Fetch RTNeural (load real NAM/Proteus captures)" OFF)
option(MOSH_BUILD_APP "Build the standalone JUCE app" ON)
option(MOSH_BUILD_UI "Build the React/Vite UI bundle as part of CMake" ON)
option(MOSH_BUILD_TESTS "Build the Catch2 + command-surface test target" ON)
option(MOSH_BUILD_PLUGIN_FIXTURES "Build deterministic in-repo VST3 fixtures for plugin-host smoke tests" OFF)

include(cmake/CPM.cmake)
include(cmake/Dependencies.cmake)

# Platform capability flags. AU plug-in hosting is a macOS-only format; on Windows
# the JUCE WebView is backed by WebView2 (Edge Chromium) rather than the legacy
# control, so the React UI renders identically to the macOS WKWebView.
if (APPLE)
    set(MOSH_PLUGINHOST_AU 1)
    set(MOSH_USE_WIN_WEBVIEW2 0)
elseif (WIN32)
    set(MOSH_PLUGINHOST_AU 0)
    set(MOSH_USE_WIN_WEBVIEW2 1)
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
        # Moshi's brain (server-side LLM proxy) + native voice (macOS Speech) — the
        # packaged-app equivalents of the Vite dev brain proxy + browser Web Speech.
        src/brain/BrainProxy.cpp
        # Stage 1 — Engine + MoshOps spine + state feed (01, 02)
        src/engine/MoshEngine.cpp
        src/moshops/MoshOps.cpp
        # MP-001 — 2-player multiplayer (track-lock + commit-on-move)
        src/multiplayer/TrackCommit.cpp
        src/multiplayer/MultiplayerClient.cpp
        src/multiplayer/LockManager.cpp
        src/multiplayer/MultiplayerSession.cpp
        # Stage 3 — VST3 hosting (04 PART 1)
        src/plugins/hosting/PluginHost.cpp
        # Stage 4 — Tier-A real-time neural insert (04 PART 2)
        src/plugins/neural/NeuralInsertPlugin.cpp
        # Moshi reactivity — master-output spectral tap (pure measure)
        src/plugins/spectral/MasterSpectralTapPlugin.cpp
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
        MOSH_VERSION_STRING="${PROJECT_VERSION}")

    target_link_libraries(Mosh PRIVATE
        tracktion::tracktion_engine
        juce::juce_gui_extra
        juce::juce_audio_utils
        juce::juce_cryptography
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

    if (MOSH_ENABLE_RTNEURAL AND TARGET mosh_neural_backends)
        target_link_libraries(Mosh PRIVATE mosh_neural_backends)
    endif()

    # ── Native voice: macOS Speech (SFSpeechRecognizer + AVAudioEngine) ───────
    # Obj-C++ with ARC; the browser Web Speech API covers the Vite dev path.
    if (APPLE)
        target_sources(Mosh PRIVATE src/voice/NativeSpeech.mm)
        set_source_files_properties(src/voice/NativeSpeech.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
        target_link_libraries(Mosh PRIVATE "-framework Speech" "-framework AVFoundation")

        # JUCE's PLIST_TO_MERGE is honoured ONLY by the Xcode generator; under the
        # Makefiles/Ninja generator this repo uses, those merged keys are silently
        # dropped from the bundle Info.plist. Re-inject the ones we depend on after
        # build — `plutil -replace` creates-if-absent and is idempotent on relink:
        #   • NSSpeechRecognitionUsageDescription — mandatory, or SFSpeechRecognizer
        #     authorization TCC-crashes the app (native voice).
        #   • NSBonjourServices — or macOS 14+ won't advertise the iPhone-companion
        #     mDNS service (keep the type in sync with cmake/MoshRemoteInfo.plist).
        # (Built-in flags MICROPHONE_PERMISSION_* / LOCAL_NETWORK_PERMISSION_* DO
        #  survive — they go through a different path than PLIST_TO_MERGE.)
        add_custom_command(TARGET Mosh POST_BUILD
            COMMAND /usr/bin/plutil -replace NSSpeechRecognitionUsageDescription
                    -string "Mosh transcribes your voice so you can talk to Moshi, your in-app collaborator, instead of typing."
                    "$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist"
            COMMAND /usr/bin/plutil -replace NSBonjourServices -json "[\"_moshcompanion._tcp\"]"
                    "$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist"
            # Camera: collaborator video tiles (getUserMedia in the WebView surfaces the
            # macOS permission dialog on first use). Camera is off by default in the UI.
            COMMAND /usr/bin/plutil -replace NSCameraUsageDescription
                    -string "Mosh shares your camera with the collaborators in your session, so you can see each other while you produce."
                    "$<TARGET_BUNDLE_DIR:Mosh>/Contents/Info.plist"
            COMMENT "Re-injecting Info.plist keys PLIST_TO_MERGE drops (speech + Bonjour + camera)"
            VERBATIM)

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
    endif()

    # ── UI bundle (Vite) ─────────────────────────────────────────────────────
    if (MOSH_BUILD_UI)
        include(cmake/BuildUI.cmake)
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
