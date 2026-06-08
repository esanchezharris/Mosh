cmake_minimum_required(VERSION 3.24)

# ─────────────────────────────────────────────────────────────────────────────
# Mosh — native hybrid DAW (standalone JUCE 8 app, NOT a plugin).
# macOS / Apple Silicon (arm64) only for v0. See 00_MOSH_MASTER_SPEC.md.
# ─────────────────────────────────────────────────────────────────────────────
project(Mosh VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "v0 is arm64-only")
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Keep a single CPM/FetchContent cache so re-configures don't re-download.
set(CPM_SOURCE_CACHE "${CMAKE_SOURCE_DIR}/.cpm-cache" CACHE PATH "CPM dep cache")
set(FETCHCONTENT_BASE_DIR "${CMAKE_SOURCE_DIR}/.cpm-cache/_fc" CACHE PATH "")

# The Tier-A neural insert (Stage 4) is self-contained (a real RT-safe MLP) and
# ALWAYS built. The heavy external inference backends used to load standard model
# captures (RTNeural for NAM/Proteus, anira+LibTorch for RAVE/DDSP) are pinned in
# cmake/Dependencies.cmake and fetched only behind their own opt-in flags.
option(MOSH_ENABLE_RTNEURAL "Fetch RTNeural (load real NAM/Proteus captures)" OFF)
option(MOSH_BUILD_UI "Build the React/Vite UI bundle as part of CMake" ON)
option(MOSH_BUILD_TESTS "Build the Catch2 + command-surface test target" ON)

include(cmake/CPM.cmake)
include(cmake/Dependencies.cmake)

# ── The app target ───────────────────────────────────────────────────────────
juce_add_gui_app(Mosh
    PRODUCT_NAME "Mosh"
    BUNDLE_ID    "studio.mosh.app"
    COMPANY_NAME "Mosh")

# Source modules (00 §5). Added incrementally per build stage.
target_sources(Mosh PRIVATE
    src/Main.cpp
    src/app/MainWindow.cpp
    src/app/WebViewShell.cpp
    src/app/SelfTest.cpp
    src/webview/WebBridge.cpp
    # Stage 1 — Engine + MoshOps spine + state feed (01, 02)
    src/engine/MoshEngine.cpp
    src/moshops/MoshOps.cpp
    # Stage 3 — VST3 hosting (04 PART 1)
    src/plugins/hosting/PluginHost.cpp
    # Stage 4 — Tier-A real-time neural insert (04 PART 2)
    src/plugins/neural/NeuralInsertPlugin.cpp)

target_include_directories(Mosh PRIVATE src)

target_compile_definitions(Mosh PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    # VST3/AU hosting (04 PART 1) — compiles JUCE's hosting format classes.
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=1
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Mosh,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Mosh,JUCE_VERSION>"
    JUCE_MODAL_LOOPS_PERMITTED=1
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

# ── UI bundle (Vite) ─────────────────────────────────────────────────────────
if (MOSH_BUILD_UI)
    include(cmake/BuildUI.cmake)
endif()

# ── Tests ────────────────────────────────────────────────────────────────────
if (MOSH_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()
