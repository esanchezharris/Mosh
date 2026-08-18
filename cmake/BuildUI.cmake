# ─────────────────────────────────────────────────────────────────────────────
# Build the React/Vite UI and stage its output into the app bundle Resources so
# the JUCE WebView can serve it (06 §1). The C++ build does NOT depend on this
# (the WebView falls back to the Vite dev server if the bundle is absent), but a
# release build embeds the bundle. Swappability (Stage 2 gate): rebuilding this
# bundle requires zero backend change.
# ─────────────────────────────────────────────────────────────────────────────

find_program(NPM_EXECUTABLE npm)

set(MOSH_UI_DIR   "${CMAKE_SOURCE_DIR}/ui")
set(MOSH_UI_DIST  "${MOSH_UI_DIR}/dist")

if (NOT NPM_EXECUTABLE)
    message(WARNING "npm not found — UI bundle will not be built by CMake. "
                    "Build it manually: (cd ui && npm install && npm run build)")
    return()
endif()

# Freshness is checked EXPLICITLY by cmake/BuildUIFresh.cmake (run-time glob +
# mtime compare inside the script), NOT by Ninja's OUTPUT/DEPENDS heuristic —
# that heuristic fired unreliably for UI-only edits (configure-time glob
# staleness + output-mtime comparison) and a plain full build could ship a STALE
# staged bundle (verified 2026-08-07, the freeze wave's UI never reached the
# app). Custom targets are always "dirty", so the check itself runs on every
# build; the script no-ops in milliseconds when everything is fresh.
add_custom_target(MoshUI
    COMMAND ${CMAKE_COMMAND}
            -DMODE=build
            "-DMOSH_UI_DIR=${MOSH_UI_DIR}"
            "-DMOSH_UI_DIST=${MOSH_UI_DIST}"
            "-DNPM_EXECUTABLE=${NPM_EXECUTABLE}"
            -P "${CMAKE_CURRENT_LIST_DIR}/BuildUIFresh.cmake"
    COMMENT "Checking UI bundle freshness (Vite build if ui/src is newer)"
    VERBATIM)

# Stage the built bundle where WebBridge can serve it after the app links.
add_dependencies(Mosh MoshUI)

# Where WebBridge (src/webview/WebBridge.cpp) looks for the bundle:
#   • macOS   → Mosh.app/Contents/Resources/ui   (app bundle)
#   • Windows → <exe dir>/ui                      (flat .exe layout; exeDir/ui fallback)
if (APPLE)
    set(MOSH_UI_STAGE_DIR "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/ui")
else()
    set(MOSH_UI_STAGE_DIR "$<TARGET_FILE_DIR:Mosh>/ui")
endif()

add_custom_command(TARGET Mosh POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${MOSH_UI_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${MOSH_UI_DIST}" "${MOSH_UI_STAGE_DIR}"
    COMMENT "Staging UI bundle → ${MOSH_UI_STAGE_DIR}"
    VERBATIM)

# The POST_BUILD staging above only runs when the Mosh target itself relinks.
# This ALL target is the backstop for every other build: it restages whenever
# ui/dist is newer than the staged copy (or the stage is missing) and no-ops on
# clean trees, so a plain full build ALWAYS lands the freshest dist in the app
# while an up-to-date tree keeps the staged mtimes (and the ad-hoc signature
# refresh downstream stays cheap). Runs after Mosh + MoshUI.
add_custom_target(MoshStageUI ALL
    COMMAND ${CMAKE_COMMAND}
            -DMODE=stage
            "-DMOSH_UI_DIST=${MOSH_UI_DIST}"
            "-DMOSH_UI_STAGE_DIR=${MOSH_UI_STAGE_DIR}"
            -P "${CMAKE_CURRENT_LIST_DIR}/BuildUIFresh.cmake"
    COMMENT "Checking staged UI bundle (restage if dist is newer)"
    VERBATIM)
add_dependencies(MoshStageUI Mosh MoshUI)

# ── Skill Foundry identity/collision gate (Slice A, Task 5) ────────────────────
# `resources/skills/native/index.json` and `resources/skills/declarative/index.json` are
# NEVER created in the source tree and NEVER committed (Slice A ships zero bundled skills of
# either origin — `git ls-files resources/skills/native/ resources/skills/declarative/` must
# return empty). Both indexes below are generated as schema-valid EMPTY envelopes into the
# BUILD tree only, at configure time — nothing here ever writes under CMAKE_SOURCE_DIR.
set(MOSH_SKILL_FOUNDRY_STAGE_DIR "${CMAKE_BINARY_DIR}/skill-foundry")
set(MOSH_SKILL_NATIVE_INDEX      "${MOSH_SKILL_FOUNDRY_STAGE_DIR}/resources/skills/native/index.json")
set(MOSH_SKILL_DECLARATIVE_INDEX "${MOSH_SKILL_FOUNDRY_STAGE_DIR}/resources/skills/declarative/index.json")
set(MOSH_SKILL_OWNER_ACTIVE_INDEX "${MOSH_SKILL_FOUNDRY_STAGE_DIR}/release-owner-active.json")

file(MAKE_DIRECTORY "${MOSH_SKILL_FOUNDRY_STAGE_DIR}/resources/skills/native")
file(MAKE_DIRECTORY "${MOSH_SKILL_FOUNDRY_STAGE_DIR}/resources/skills/declarative")
file(WRITE "${MOSH_SKILL_NATIVE_INDEX}"      "{\"schemaVersion\":1,\"skills\":[]}\n")
file(WRITE "${MOSH_SKILL_DECLARATIVE_INDEX}" "{\"schemaVersion\":1,\"skills\":[]}\n")

# MOSH_RELEASE_OWNER_ACTIVE_INDEX is a test-only override (e.g.
# tests/fixtures/skill-foundry/release-owner-active.json) — the gate itself NEVER reads the
# real owner root ($MOSH_AGENT_DIR); the production default is the schema-valid empty map.
if (MOSH_RELEASE_OWNER_ACTIVE_INDEX)
    file(COPY_FILE "${MOSH_RELEASE_OWNER_ACTIVE_INDEX}" "${MOSH_SKILL_OWNER_ACTIVE_INDEX}")
else()
    file(WRITE "${MOSH_SKILL_OWNER_ACTIVE_INDEX}" "{\"schemaVersion\":1,\"generation\":0,\"skills\":{}}\n")
endif()

# ALWAYS-run (no OUTPUT — reruns every build) so a mid-tree edit is always re-checked, not
# just at configure time. Runs BEFORE Mosh builds (add_dependencies below); the collision
# check itself is cheap (empty indexes in Slice A) so this never meaningfully slows a build.
add_custom_target(MoshSkillIdentityGate
    COMMAND ${NPM_EXECUTABLE} run verify:skill-identities --prefix "${MOSH_UI_DIR}" --
            --configuration $<CONFIG>
            --app-version "${PROJECT_VERSION}"
            --target Mosh
            --architecture arm64
            --native-index "${MOSH_SKILL_NATIVE_INDEX}"
            --declarative-index "${MOSH_SKILL_DECLARATIVE_INDEX}"
            --owner-active-index "${MOSH_SKILL_OWNER_ACTIVE_INDEX}"
    COMMENT "Verifying skill identity/collision universe (native + declarative + owner)"
    VERBATIM)
add_dependencies(Mosh MoshSkillIdentityGate)
