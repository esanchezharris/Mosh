# ──────────────────────────────────────────────────────────────────────────────
# Mosh — native hybrid DAW.  Standalone JUCE 8 app (NOT a plugin) hosting a
# React/Vite UI in a JUCE 8 WebView, on Tracktion Engine, with a typed command
# spine (MoshOps).  See 00_MOSH_MASTER_SPEC.md / 06_BUILD_TOOLING_AND_RUN_PLAN.md.
#
# Tooling pattern adapted from Pamplejuce (CMake/CPM/Catch2 hygiene) but the
# target is an APP, and engine integration follows Tracktion's own CMake.
#
# Primary target: macOS arm64. Cross-platform kept clean (Windows dev proxy).
# ──────────────────────────────────────────────────────────────────────────────
cmake_minimum_required(VERSION 3.24)

# Universal binary default on Apple; harmless elsewhere. Set before project().
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "Build architectures for macOS" FORCE)
endif()

project(Mosh VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(PROJECT_IS_TOP_LEVEL)
  set_property(GLOBAL PROPERTY USE_FOLDERS YES)
endif()

# ── Options ───────────────────────────────────────────────────────────────────
# MOSH_BUILD_SPINE  : the Tracktion-free, pure-logic spine lib (always cheap).
# MOSH_BUILD_TESTS  : Catch2 unit tests over the spine (cheap; runs on any OS).
# MOSH_BUILD_APP    : the full JUCE+Tracktion standalone app (heavy; macOS-primary).
#
# On a CI box or a non-Mac dev machine you can verify the spine without the
# heavy/macOS-primary app:   cmake -B build -DMOSH_BUILD_APP=OFF
option(MOSH_BUILD_APP   "Build the standalone JUCE+Tracktion app" ON)
option(MOSH_BUILD_TESTS "Build Catch2 unit tests"                 ON)
option(MOSH_BUILD_UI    "Build & stage the Vite frontend bundle"  ${MOSH_BUILD_APP})

# Pinned dependency versions (resolved via `git ls-remote` 2026-06-08).
# All pins live here so an audit is a single read.  See 06 §2.
set(MOSH_JUCE_TAG       "8.0.8"   CACHE STRING "JUCE pin")                # juce-framework/JUCE
set(MOSH_TRACKTION_TAG  "v3.2.0"  CACHE STRING "tracktion_engine pin")   # Tracktion/tracktion_engine
set(MOSH_ANIRA_TAG      "v2.0.3"  CACHE STRING "anira pin")              # anira-project/anira
set(MOSH_RTNEURAL_TAG   "1fb1f075a5d66e85bfc8f488c3f3626840cb3a1d" CACHE STRING "RTNeural pin") # jatinchowdhury18/RTNeural@main
set(MOSH_CHOWDSP_TAG    "e97b826ef3de0b0fd92b15cb2e286076f678d8b9" CACHE STRING "chowdsp_utils pin") # Chowdhury-DSP/chowdsp_utils@master
set(MOSH_CATCH2_TAG     "v3.9.1"  CACHE STRING "Catch2 pin")             # catchorg/Catch2

include(cmake/CPM.cmake)

# Cache CPM downloads outside the build tree by default (faster reconfigures).
if(NOT DEFINED CPM_SOURCE_CACHE AND NOT DEFINED ENV{CPM_SOURCE_CACHE})
  set(CPM_SOURCE_CACHE "${CMAKE_SOURCE_DIR}/.cpm-cache" CACHE PATH "CPM download cache")
endif()

# ── JUCE (always — the spine uses juce_core / juce_data_structures) ────────────
# JUCE is lightweight to consume when only the data modules are linked; the heavy
# graphics/audio modules are only pulled by the app target.
CPMAddPackage(
  NAME JUCE
  GITHUB_REPOSITORY juce-framework/JUCE
  GIT_TAG ${MOSH_JUCE_TAG}
  GIT_SHALLOW TRUE
)

# ── The pure-logic spine (Tracktion-free, unit-testable anywhere) ──────────────
# RenderLayer schema, full-fingerprint cache key, ASTD mapping, MoshResult
# envelope, snapshot/event serialization, command validation.  No audio, no
# Tracktion — only JUCE's ValueTree/var.  This is the load-bearing contract (02).
add_subdirectory(src/spine)

# ── Tests (cheap; OS-agnostic) ────────────────────────────────────────────────
if(MOSH_BUILD_TESTS)
  CPMAddPackage(
    NAME Catch2
    GITHUB_REPOSITORY catchorg/Catch2
    GIT_TAG ${MOSH_CATCH2_TAG}
    GIT_SHALLOW TRUE
  )
  enable_testing()
  add_subdirectory(tests)
endif()

# ── The full app (heavy; macOS-primary) ───────────────────────────────────────
if(MOSH_BUILD_APP)
  # Tracktion Engine. Add JUCE FIRST (done above) so its juce:: targets exist, then
  # add ONLY tracktion's modules dir (DOWNLOAD_ONLY) — NOT the repo root, which would
  # pull tracktion's own `develop` JUCE. This guarantees exactly one JUCE (8.0.8).
  # (Resolved against the pinned clone — see docs/TRACKTION_API_NOTES.md §7.)
  CPMAddPackage(
    NAME tracktion_engine
    GITHUB_REPOSITORY Tracktion/tracktion_engine
    GIT_TAG ${MOSH_TRACKTION_TAG}
    GIT_SHALLOW TRUE
    DOWNLOAD_ONLY YES
  )
  if(tracktion_engine_ADDED)
    add_subdirectory(${tracktion_engine_SOURCE_DIR}/modules ${CMAKE_BINARY_DIR}/tracktion_modules)
  else()
    message(FATAL_ERROR "Mosh: tracktion_engine source not available")
  endif()

  add_subdirectory(src/engine)
  add_subdirectory(src/app)
endif()

# Friendly configure-time summary.
message(STATUS "")
message(STATUS "Mosh configure summary:")
message(STATUS "  spine .......... ON (always)")
message(STATUS "  tests .......... ${MOSH_BUILD_TESTS}")
message(STATUS "  app ............ ${MOSH_BUILD_APP}   (JUCE ${MOSH_JUCE_TAG} + Tracktion ${MOSH_TRACKTION_TAG})")
message(STATUS "  ui bundle ...... ${MOSH_BUILD_UI}")
message(STATUS "")
