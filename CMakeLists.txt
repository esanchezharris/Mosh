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

# Stage gating: heavy neural inference backends (anira/RTNeural/chowdsp) are
# pinned below but only fetched/linked when this is ON (Stage 4+). Keeps the
# Stage 0–3 skeleton build fast. The pins are recorded either way.
option(MOSH_ENABLE_NEURAL "Fetch+link Tier-A neural deps (anira/RTNeural/chowdsp)" OFF)
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
    src/webview/WebBridge.cpp)

target_include_directories(Mosh PRIVATE src)

target_compile_definitions(Mosh PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Mosh,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Mosh,JUCE_VERSION>"
    JUCE_MODAL_LOOPS_PERMITTED=1
    # Mosh build identity / stage flags
    MOSH_VERSION_STRING="${PROJECT_VERSION}"
    $<$<BOOL:${MOSH_ENABLE_NEURAL}>:MOSH_ENABLE_NEURAL=1>)

target_link_libraries(Mosh PRIVATE
    tracktion::tracktion_engine
    juce::juce_gui_extra
    juce::juce_audio_utils
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)

if (MOSH_ENABLE_NEURAL)
    target_link_libraries(Mosh PRIVATE mosh_neural_backends)
    target_sources(Mosh PRIVATE
        src/plugins/neural/NeuralInsertPlugin.cpp
        src/plugins/neural/Astd.cpp)
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
