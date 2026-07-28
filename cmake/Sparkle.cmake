# Sparkle.cmake — the Sparkle 2 auto-updater (macOS only, FS-K2).
#
# INCLUDED AFTER the Mosh target exists (it attaches link/compile options and
# post-build steps to it). Apple-only: Sparkle is a macOS framework, and the Windows
# port has no auto-update story yet (docs/WINDOWS_PARITY.md).
#
# WHY THE BINARY RELEASE, NOT A SOURCE BUILD: the Sparkle project ships a prebuilt,
# notarization-ready Sparkle.framework in every release tarball. Building it from
# source would add an Xcode-generator dependency and minutes to every fresh configure
# for a framework we do not modify. The tarball is pinned by URL *and* sha256, so it
# is exactly as reproducible as a git tag.
#
# THE FRAMEWORK SHIPS AD-HOC SIGNED (`codesign -dv` → "TeamIdentifier=not set").
# It MUST be re-signed with our Developer ID for a distributed build, inside-out:
# Versions/B/XPCServices/*.xpc, Versions/B/Updater.app, Versions/B/Autoupdate, then
# the framework itself. Sparkle enforces this at runtime — its installer refuses to
# launch a helper whose team ID does not match the host app's unless the app is
# ad-hoc signed. scripts/release/sign-and-notarize.sh does that; a dev build's
# ad-hoc `codesign --deep` (cmake/RefreshMacBundleMetadata.cmake) satisfies the
# ad-hoc branch of the same check.

option(MOSH_ENABLE_SPARKLE "Bundle the Sparkle 2 auto-updater (macOS only)" ON)

# The appcast feed. EMPTY BY DEFAULT AND THAT IS THE POINT: with no feed configured
# the app embeds Sparkle but never starts an updater, and the "Check for Updates…"
# menu item is present-but-disabled rather than silently doing nothing. Publishing a
# feed means publishing signed builds at a public URL, which is a distribution
# decision the owner makes — see docs/first-stranger-program/lanes/fs-k2.md.
set(MOSH_SPARKLE_FEED_URL "" CACHE STRING
    "Sparkle appcast URL baked into Info.plist as SUFeedURL (empty = no updater)")

# The EdDSA (ed25519) public key Sparkle checks every downloaded update against.
# PUBLIC by construction — it is safe in the repo and in the shipped Info.plist, and it
# is meant to be here: it is what pins updates to THIS project's key. The matching
# PRIVATE key exists only in the owner's login Keychain, put there by Sparkle's
# `generate_keys` on 2026-07-27; it is not in the tree, not in CI, and not recoverable
# if that Keychain is lost — see docs/release/SIGNING_RUNBOOK.md § Auto-update.
#
# A fork or a fresh machine inherits this default and CANNOT sign updates with it —
# that is the correct outcome, not a bug. Run generate_keys and override.
set(MOSH_SPARKLE_PUBLIC_KEY "95F1BbVbpmGsAzS9Cr3Brzwl6/gAncabM6NhnZM1b1g=" CACHE STRING
    "Sparkle EdDSA public key baked into Info.plist as SUPublicEDKey")

if (NOT APPLE OR NOT MOSH_ENABLE_SPARKLE)
    # MoshEmbedSparkle must EXIST either way: it is named in CMakePresets.json's macOS
    # app target lists, and a build preset that names a target the configure did not
    # create fails outright ("unknown target"). Without this stub,
    # -DMOSH_ENABLE_SPARKLE=OFF would break the normal build command rather than
    # quietly building without an updater — an escape hatch that breaks the build is
    # not an escape hatch.
    if (APPLE AND TARGET Mosh)
        add_custom_target(MoshEmbedSparkle ALL
            COMMAND ${CMAKE_COMMAND} -E true
            COMMENT "Sparkle disabled (-DMOSH_ENABLE_SPARKLE=OFF) — no framework to embed")
    endif()
    return()
endif()

# The version + hash come from scripts/release/sparkle-pin.env, which the release
# script also sources. ONE pin, two consumers — see that file for why they must not
# drift (an appcast signed by generate_appcast from release A and verified by a
# framework from release B fails only on a user's machine).
set(_sparkle_pin "${CMAKE_CURRENT_LIST_DIR}/../scripts/release/sparkle-pin.env")
if (NOT EXISTS "${_sparkle_pin}")
    message(FATAL_ERROR "Sparkle.cmake: pin file missing at '${_sparkle_pin}'")
endif()
file(STRINGS "${_sparkle_pin}" _sparkle_pin_lines REGEX "^MOSH_SPARKLE_(VERSION|SHA256)=")
foreach(_line IN LISTS _sparkle_pin_lines)
    if (_line MATCHES "^MOSH_SPARKLE_VERSION=(.+)$")
        set(MOSH_SPARKLE_VERSION "${CMAKE_MATCH_1}")
    elseif (_line MATCHES "^MOSH_SPARKLE_SHA256=(.+)$")
        set(MOSH_SPARKLE_SHA256 "${CMAKE_MATCH_1}")
    endif()
endforeach()
if (NOT MOSH_SPARKLE_VERSION OR NOT MOSH_SPARKLE_SHA256)
    message(FATAL_ERROR
        "Sparkle.cmake: could not read MOSH_SPARKLE_VERSION / MOSH_SPARKLE_SHA256 from "
        "'${_sparkle_pin}'. Fail closed rather than silently fetching an unpinned Sparkle.")
endif()

include(FetchContent)
FetchContent_Declare(sparkle
    URL      "https://github.com/sparkle-project/Sparkle/releases/download/${MOSH_SPARKLE_VERSION}/Sparkle-${MOSH_SPARKLE_VERSION}.tar.xz"
    URL_HASH "SHA256=${MOSH_SPARKLE_SHA256}"
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
# The tarball carries no CMakeLists.txt, so MakeAvailable populates it and stops —
# no add_subdirectory, no targets of Sparkle's own. We just want the framework.
FetchContent_MakeAvailable(sparkle)

set(MOSH_SPARKLE_FRAMEWORK "${sparkle_SOURCE_DIR}/Sparkle.framework")
if (NOT EXISTS "${MOSH_SPARKLE_FRAMEWORK}/Versions/B/Sparkle")
    message(FATAL_ERROR
        "Sparkle.cmake: Sparkle.framework not found at '${MOSH_SPARKLE_FRAMEWORK}' after "
        "fetching ${MOSH_SPARKLE_VERSION}. The release layout may have changed — check the "
        "tarball before re-pinning.")
endif()

# Linked BY NAME (-framework Sparkle + -F), deliberately NOT by full path. Passing the
# .framework path to target_link_libraries makes CMake helpfully add that directory to
# the binary's LC_RPATH — which bakes THIS MACHINE's dep-cache path into a shipped app.
# Verified: it produced a second rpath entry pointing at
# ~/Library/Mosh/work/fc/<worktree-hash>/sparkle-src, dangling on every other machine.
# A raw -framework flag is passed through untouched, so the only rpath is ours below.
target_link_libraries(Mosh PRIVATE "-framework Sparkle")
# -F for BOTH compile and link: the compile side resolves `#import <Sparkle/Sparkle.h>`,
# the link side resolves the framework by name.
target_compile_options(Mosh PRIVATE "-F${sparkle_SOURCE_DIR}")
target_link_options(Mosh PRIVATE "-F${sparkle_SOURCE_DIR}")
target_compile_definitions(Mosh PRIVATE MOSH_HAVE_SPARKLE=1)

# Sparkle's install name is @rpath/Sparkle.framework/Versions/B/Sparkle, so the app
# needs an rpath pointing at its own Frameworks dir or it dies at launch with
# "Library not loaded". JUCE does not add one.
set_property(TARGET Mosh APPEND PROPERTY BUILD_RPATH   "@executable_path/../Frameworks")
set_property(TARGET Mosh APPEND PROPERTY INSTALL_RPATH "@executable_path/../Frameworks")

# Embed the framework. Run TWICE for the same reason MoshFixInfoPlist exists: a
# POST_BUILD on Mosh fires ONLY when Mosh relinks, so an up-to-date / UI-only /
# deploy build would ship a bundle with no Frameworks dir and crash at launch.
set(MOSH_EMBED_SPARKLE_SCRIPT "${CMAKE_CURRENT_LIST_DIR}/EmbedSparkle.cmake")
add_custom_command(TARGET Mosh POST_BUILD
    COMMAND ${CMAKE_COMMAND}
            -DFRAMEWORK=${MOSH_SPARKLE_FRAMEWORK}
            -DBUNDLE=$<TARGET_BUNDLE_DIR:Mosh>
            -P "${MOSH_EMBED_SPARKLE_SCRIPT}"
    COMMENT "Embedding Sparkle.framework into Mosh.app/Contents/Frameworks"
    VERBATIM)
add_custom_target(MoshEmbedSparkle ALL
    COMMAND ${CMAKE_COMMAND}
            -DFRAMEWORK=${MOSH_SPARKLE_FRAMEWORK}
            -DBUNDLE=$<TARGET_BUNDLE_DIR:Mosh>
            -P "${MOSH_EMBED_SPARKLE_SCRIPT}"
    COMMENT "Embedding Sparkle.framework (no-relink/deploy-safe backstop)"
    VERBATIM)
add_dependencies(MoshEmbedSparkle Mosh)

message(STATUS "Mosh: Sparkle ${MOSH_SPARKLE_VERSION} embedded")
if (MOSH_SPARKLE_FEED_URL)
    message(STATUS "Mosh: Sparkle feed = ${MOSH_SPARKLE_FEED_URL}")
else()
    message(STATUS "Mosh: Sparkle feed = <none> (updater inert; set -DMOSH_SPARKLE_FEED_URL=…)")
endif()
