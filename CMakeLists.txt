cmake_minimum_required(VERSION 3.24)

# ─────────────────────────────────────────────────────────────────────────────
# Mosh - native hybrid DAW (standalone JUCE 8 app, NOT a plugin).
# macOS / Apple Silicon remains canonical; Windows support is a portability layer.
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
    set(MOSH_APP_EXTRA_ARGS NEEDS_WEBVIEW2 TRUE)
    if (APPLE)
        list(APPEND MOSH_APP_EXTRA_ARGS
            LOCAL_NETWORK_PERMISSION_ENABLED TRUE
            LOCAL_NETWORK_PERMISSION_TEXT "Mosh uses the local network to pair with the iPhone companion while you are near this Mac."
            PLIST_TO_MERGE "${CMAKE_SOURCE_DIR}/cmake/MoshRemoteInfo.plist")
    endif()

    juce_add_gui_app(Mosh
        PRODUCT_NAME "Mosh"
        BUNDLE_ID    "studio.mosh.app"
        COMPANY_NAME "Mosh"
        ${MOSH_APP_EXTRA_ARGS})

# Source modules (00 §5). Added incrementally per build stage.
    target_sources(Mosh PRIVATE
        src/Main.cpp
        src/app/MainWindow.cpp
        src/app/WebViewShell.cpp
        src/app/SelfTest.cpp
        src/webview/WebBridge.cpp
        # Stage 1 — Engine + MoshOps spine + state feed (01, 02)
        src/engine/MoshEngine.cpp
        src/engine_contract/MoshEngineBackend.cpp
        src/engine_contract/TracktionEngineBackend.cpp
        src/engine_contract/MaolanProcessBackend.cpp
        src/moshops/MoshOps.cpp
        # Stage 3 — VST3 hosting (04 PART 1)
        src/plugins/hosting/PluginHost.cpp
        # Stage 4 — Tier-A real-time neural insert (04 PART 2)
        src/plugins/neural/NeuralInsertPlugin.cpp
        # Stage 5 — Tier-B generative layer (05)
        src/generative/GenerativeJobManager.cpp
        # iPhone companion remote control + phone-take ingest
        src/remote/RemoteCompanionProtocol.cpp
        src/remote/RemoteCompanionServer.cpp)

    target_include_directories(Mosh PRIVATE src)

    target_compile_definitions(Mosh PRIVATE
        JUCE_WEB_BROWSER=1
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
