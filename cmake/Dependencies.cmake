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
    # Idempotent: skip when already applied (reverse-check succeeds), else apply. Runs in
    # the tracktion source dir (a git clone) on a fresh fetch.
    PATCH_COMMAND       bash -c "git apply -R --check '${MOSH_TRACKTION_PATCH}' 2>/dev/null && echo 'tracktion createNewItemID patch already applied' || git apply '${MOSH_TRACKTION_PATCH}'")
FetchContent_MakeAvailable(tracktion_engine)

# ── Catch2 (tests) ──────────────────────────────────────────────────────────
if (MOSH_BUILD_TESTS)
    CPMAddPackage("gh:catchorg/Catch2@3.7.1")
endif()

# ── Tier-A neural backends ──────────────────────────────────────────────────
# Split by weight: RTNeural is light (Eigen/XSIMD, header-heavy) and carries the
# SHIPPING models (NAM/Proteus run inline, RT-safe — 04 §2.3). anira pulls a heavy
# runtime (LibTorch/ONNX) and only the GATED RAVE/DDSP path needs it, so it sits
# behind a second opt-in to keep the default neural build tractable.
option(MOSH_ENABLE_ANIRA "Also fetch anira + LibTorch/ONNX (RAVE/DDSP, heavy)" OFF)

if (MOSH_ENABLE_RTNEURAL)
    # RTNeural — small-model inference (NAM/Proteus, inline RT-safe).
    CPMAddPackage(
        NAME              RTNeural
        GITHUB_REPOSITORY jatinchowdhury18/RTNeural
        GIT_TAG           1fb1f075a5d66e85bfc8f488c3f3626840cb3a1d
        OPTIONS           "RTNEURAL_EIGEN ON")

    add_library(mosh_neural_backends INTERFACE)
    target_link_libraries(mosh_neural_backends INTERFACE RTNeural)

    if (MOSH_ENABLE_ANIRA)
        CPMAddPackage(
            NAME              anira
            GITHUB_REPOSITORY anira-project/anira
            GIT_TAG           main)
        target_link_libraries(mosh_neural_backends INTERFACE anira)
        target_compile_definitions(mosh_neural_backends INTERFACE MOSH_HAVE_ANIRA=1)
    endif()
endif()
