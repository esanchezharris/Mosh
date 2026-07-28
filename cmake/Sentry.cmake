# ─────────────────────────────────────────────────────────────────────────────
# FS-K3 — Sentry Native SDK (crashpad backend, out-of-process handler).
#
# GATED OFF BY DEFAULT. Nothing here runs, fetches, or downloads unless the build
# is configured with -DMOSH_ENABLE_SENTRY=ON. That is the whole point: the
# canonical build recipe
#   cmake --preset macos-arm64-release \
#     -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache \
#     -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src
# is byte-for-byte unaffected by this lane, so every --selftest / Catch2 / vitest
# baseline is preserved by construction rather than by re-measurement.
#
# WHY THIS FILE AND NOT cmake/Dependencies.cmake: Dependencies.cmake is a
# hard-REJECT file in the auto-loop rulebook (scripts/auto-loop/classify.sh:39 —
# "cmake/Dependencies.cmake | cmake/CPM*.cmake | cmake/*patch*"), which would make
# this diff needs-human rather than an owner PR. The OPTION + INTERFACE-target
# shape below is copied from the MOSH_ENABLE_ANIRA block that lives there
# (Dependencies.cmake:51-88) — the existing precedent for a heavy, fetch-gated
# third-party native dependency in this build.
#
# WHY THE RELEASE ASSET AND NOT A GIT TAG: sentry-native keeps crashpad in a git
# submodule, so a GIT_TAG fetch of the bare repo yields a tree with an EMPTY
# external/crashpad and the crashpad backend cannot configure. The published
# `sentry-native.zip` release asset vendors crashpad + breakpad + third-party, so
# it builds with no submodule recursion. Pinned by URL + sha256 (not by tag), so
# the bytes are verified, not merely named.
#
# PIN VERIFIED 2026-07-27 by downloading the asset and hashing it:
#   version   0.15.4   (published 2026-07-21)
#   size      8,977,596 bytes
#   sha256    c0bf6fafd4b6a33a1701f61a9b7659d08f0541fa363b7d584008d232acc2067d
#   contents  external/crashpad/ present; LICENSE = MIT (matches DEPENDENCY_BOM.md §1)
# 0.16.0 existed at pin time but had been published that same day; 0.15.4 is the
# latest patch of a matured minor. Re-pinning = bump BOTH the URL and the hash,
# and update the DEPENDENCY_BOM.md row.
# ─────────────────────────────────────────────────────────────────────────────

option(MOSH_ENABLE_SENTRY "Fetch + link the Sentry Native SDK (crashpad backend) for crash reporting" OFF)

set(MOSH_SENTRY_VERSION "0.15.4")
set(MOSH_SENTRY_URL
    "https://github.com/getsentry/sentry-native/releases/download/${MOSH_SENTRY_VERSION}/sentry-native.zip")
set(MOSH_SENTRY_SHA256
    "c0bf6fafd4b6a33a1701f61a9b7659d08f0541fa363b7d584008d232acc2067d")

if (MOSH_ENABLE_SENTRY)
    # crashpad = out-of-process handler, which is what spec §5 K3 asks for: a
    # separate process survives the parent's death and can still write + upload the
    # minidump for a crash that takes the app down mid-signal.
    set(SENTRY_BACKEND           "crashpad" CACHE STRING "" FORCE)

    # STATIC. A shared libsentry.dylib would need its own codesign pass in the
    # release path AND would add an LC_RPATH entry pointing at wherever it was built
    # — the classic way a build machine's absolute path gets baked into a shipped
    # bundle. Static linking removes both problems; only crashpad_handler (a real
    # executable, staged below) remains as a separate file.
    set(SENTRY_BUILD_SHARED_LIBS OFF        CACHE BOOL   "" FORCE)

    set(SENTRY_BUILD_TESTS       OFF        CACHE BOOL   "" FORCE)
    set(SENTRY_BUILD_EXAMPLES    OFF        CACHE BOOL   "" FORCE)
    set(SENTRY_BUILD_BENCHMARKS  OFF        CACHE BOOL   "" FORCE)

    CPMAddPackage(
        NAME           sentry
        VERSION        ${MOSH_SENTRY_VERSION}
        URL            ${MOSH_SENTRY_URL}
        URL_HASH       SHA256=${MOSH_SENTRY_SHA256}
    )

    add_library(mosh_sentry INTERFACE)
    target_link_libraries(mosh_sentry INTERFACE sentry::sentry)
    target_compile_definitions(mosh_sentry INTERFACE MOSH_HAVE_SENTRY=1)

    message(STATUS "Mosh: Sentry ENABLED — sentry-native ${MOSH_SENTRY_VERSION}, backend=crashpad")
endif()

# Stage crashpad's out-of-process handler executable INTO the app bundle, next to
# the main binary, so SentryReporter::resolveHandlerPath() can find it relative to
# the RUNNING bundle at runtime. Deliberately not baked in as an absolute configure-
# time path: that would break the moment the .app is copied to /Applications or
# handed to a playtester, and would leak this machine's directory layout into the
# shipped binary.
#
# No-op unless MOSH_ENABLE_SENTRY — so calling this unconditionally from
# CMakeLists.txt keeps the default build's target definition unchanged.
function(mosh_sentry_stage_handler target)
    if (NOT MOSH_ENABLE_SENTRY)
        return()
    endif()

    if (NOT TARGET crashpad_handler)
        message(FATAL_ERROR
            "MOSH_ENABLE_SENTRY=ON but the crashpad_handler target is missing. "
            "The crashpad backend did not configure — check that the fetched "
            "sentry-native archive contains external/crashpad (the release asset "
            "does; a bare GIT_TAG checkout does not).")
    endif()

    if (APPLE)
        set(_dest "$<TARGET_BUNDLE_CONTENT_DIR:${target}>/MacOS")
    else()
        set(_dest "$<TARGET_FILE_DIR:${target}>")
    endif()

    add_custom_command(TARGET ${target} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${_dest}"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "$<TARGET_FILE:crashpad_handler>" "${_dest}/crashpad_handler"
        COMMENT "Staging crashpad_handler (out-of-process crash handler) into the bundle"
        VERBATIM)
endfunction()

# Emit a .dSYM bundle so crashes can actually be SYMBOLICATED.
#
# WHY THIS IS NEEDED AT ALL: the macos-arm64-release preset is Ninja +
# CMAKE_BUILD_TYPE=Release, i.e. -O3 with NO -g. A Release binary therefore carries
# no debug info, no .dSYM is produced, and scripts/release/upload-dsyms.sh correctly
# finds nothing to upload. Without this, "an induced crash appears in Sentry,
# symbolicated" (spec §5 K3) could never be satisfied — the upload script would be
# hollow. Discovered by actually running the script rather than assuming.
#
# WHY IT IS GATED: adding -g changes the compiled output, which would break the
# byte-identical-default-build property this whole lane relies on for baseline
# preservation. So debug info is emitted ONLY in a -DMOSH_ENABLE_SENTRY=ON build —
# exactly the build that has somewhere to send symbols. -g affects the DWARF emitted
# alongside, not the optimisation level: -O3 still applies, so the Sentry-ON binary
# is the same optimised code, just described.
function(mosh_sentry_emit_dsym target)
    if (NOT MOSH_ENABLE_SENTRY OR NOT APPLE)
        return()
    endif()

    target_compile_options(${target} PRIVATE -g)

    # Land it NEXT TO the .app (not inside it — a dSYM must never ship in the
    # bundle: it is large and it hands anyone a full symbol map). This is the
    # location upload-dsyms.sh searches.
    add_custom_command(TARGET ${target} POST_BUILD
        COMMAND dsymutil "$<TARGET_FILE:${target}>"
                -o "$<TARGET_BUNDLE_DIR:${target}>.dSYM"
        COMMENT "Generating ${target}.app.dSYM for Sentry symbolication"
        VERBATIM)
endfunction()
