# ─────────────────────────────────────────────────────────────────────────────
# Dependency acquisition & pinning (06 §2). All deps pinned to a commit/tag.
#
# Load-bearing pins (Stages 0–3):
#   tracktion_engine  2877b621f2fbee564d0696a616b86bf8ba8c8ab0
#   JUCE 8            7c89e11f6b7316c369f3d3f22227c60e816e738b  (tracktion's modules/juce submodule)
#
# Neural pins (Stage 4, fetched only when MOSH_ENABLE_NEURAL=ON):
#   anira / RTNeural / chowdsp_utils  — see below.
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

FetchContent_Declare(tracktion_engine
    GIT_REPOSITORY      https://github.com/Tracktion/tracktion_engine.git
    GIT_TAG             2877b621f2fbee564d0696a616b86bf8ba8c8ab0
    GIT_SHALLOW         FALSE
    GIT_SUBMODULES_RECURSE TRUE
    GIT_PROGRESS        TRUE)
FetchContent_MakeAvailable(tracktion_engine)

# ── Catch2 (tests) ──────────────────────────────────────────────────────────
if (MOSH_BUILD_TESTS)
    CPMAddPackage("gh:catchorg/Catch2@3.7.1")
endif()

# ── Tier-A neural backends (Stage 4; fetched only when enabled) ─────────────
if (MOSH_ENABLE_NEURAL)
    # RTNeural — small-model inference (NAM/Proteus).
    CPMAddPackage(
        NAME         RTNeural
        GITHUB_REPOSITORY jatinchowdhury18/RTNeural
        GIT_TAG      main)        # TODO Stage 4: pin to a commit once measured

    # chowdsp_utils — DSP blocks + plugin state/param helpers.
    CPMAddPackage(
        NAME         chowdsp_utils
        GITHUB_REPOSITORY Chowdhury-DSP/chowdsp_utils
        GIT_TAG      main)        # TODO Stage 4: pin to a commit

    # anira — RT-safe neural inference host (chooses backend per model).
    CPMAddPackage(
        NAME         anira
        GITHUB_REPOSITORY anira-project/anira
        GIT_TAG      main)        # TODO Stage 4: pin to a commit

    # Aggregate link target for the app (filled in at Stage 4).
    add_library(mosh_neural_backends INTERFACE)
    target_link_libraries(mosh_neural_backends INTERFACE
        anira RTNeural)
endif()
