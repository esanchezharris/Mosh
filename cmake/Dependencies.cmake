# ─────────────────────────────────────────────────────────────────────────────
# Dependency acquisition & pinning (06 §2). All deps pinned to a commit/tag.
#
# Load-bearing pins (Stages 0–3):
#   tracktion_engine  2877b621f2fbee564d0696a616b86bf8ba8c8ab0
#   JUCE 8            7c89e11f6b7316c369f3d3f22227c60e816e738b  (tracktion's modules/juce submodule)
#
# NOTE: tracktion's JUCE submodule URL is SSH (git@github.com:…). A global
# `git config --global url."https://github.com/".insteadOf "git@github.com:"`
# makes the recursive submodule fetch work without SSH keys.
# ─────────────────────────────────────────────────────────────────────────────

include(FetchContent)

# ── JUCE + Tracktion Engine ─────────────────────────────────────────────────
# Tracktion brings its own pinned JUCE 8 as modules/juce (recursive submodule),
# guaranteeing a matched JUCE/Tracktion pair. Disable its example targets.
set(TE_ADD_EXAMPLES OFF CACHE BOOL "" FORCE)

# MOSH PATCH (engine fix): Edit::createNewItemID() must scan ALL EditItem caches, not
# just track + clip — otherwise an ID held only by a live plugin (automatableEditItemCache,
# e.g. one reconstructed on reload or outliving its removal via the undo stack) can be
# reused, tripping the EditItemCache::addItem jassert and silently overwriting the
# itemID->item map in release builds. See patches/. NB: re-pinning tracktion (GIT_TAG)
# requires re-rolling this patch against the new revision.
set(MOSH_TRACKTION_PATCH
    "${CMAKE_CURRENT_LIST_DIR}/../patches/0001-tracktion-createNewItemID-scan-all-caches.patch")
FetchContent_Declare(tracktion_engine
    GIT_REPOSITORY      https://github.com/Tracktion/tracktion_engine.git
    GIT_TAG             2877b621f2fbee564d0696a616b86bf8ba8c8ab0
    GIT_SHALLOW         FALSE
    GIT_SUBMODULES_RECURSE TRUE
    GIT_PROGRESS        TRUE
    # Idempotent + cross-platform: a `cmake -P` helper applies the patch with native
    # git (reverse-check to skip when already applied, else apply). Runs in the
    # tracktion source dir on a fresh fetch. Replaces a `bash -c "git apply ..."`,
    # which broke on Windows where bash resolves to WSL and cannot open a C:/ path.
    PATCH_COMMAND       ${CMAKE_COMMAND} -DPATCH=${MOSH_TRACKTION_PATCH} -P ${CMAKE_CURRENT_LIST_DIR}/apply-tracktion-patch.cmake)
FetchContent_MakeAvailable(tracktion_engine)

# ── Catch2 (tests) ──────────────────────────────────────────────────────────
if (MOSH_BUILD_TESTS)
    CPMAddPackage("gh:catchorg/Catch2@3.7.1")
endif()

# ── Real-time neural backend (Route C.2 — RAVE via anira + LibTorch) ──────────
# HEAVY + GATED: fetched ONLY when MOSH_ENABLE_ANIRA=ON. anira downloads its LibTorch
# backend (~hundreds of MB) at configure time from the anira-project/backends release.
# The DEFAULT build never touches this — the option is OFF, so configure is unchanged.
option(MOSH_ENABLE_ANIRA "Fetch anira + LibTorch for the real-time RAVE insert (heavy)" OFF)

if (MOSH_ENABLE_ANIRA)
    # LibTorch only (skip the other inference backends to keep the download tractable).
    set(ANIRA_WITH_LIBTORCH    ON  CACHE BOOL "" FORCE)
    set(ANIRA_WITH_ONNXRUNTIME OFF CACHE BOOL "" FORCE)
    set(ANIRA_WITH_TFLITE      OFF CACHE BOOL "" FORCE)
    set(ANIRA_WITH_LITERT      OFF CACHE BOOL "" FORCE)
    set(ANIRA_WITH_BENCHMARK   OFF CACHE BOOL "" FORCE)
    set(ANIRA_WITH_EXAMPLES    OFF CACHE BOOL "" FORCE)
    set(ANIRA_WITH_TESTS       OFF CACHE BOOL "" FORCE)
    CPMAddPackage(
        NAME              anira
        GITHUB_REPOSITORY anira-project/anira
        GIT_TAG           v2.1.0)

    add_library(mosh_neural_backends INTERFACE)
    target_link_libraries(mosh_neural_backends INTERFACE anira::anira)
    target_compile_definitions(mosh_neural_backends INTERFACE MOSH_HAVE_ANIRA=1)
endif()

