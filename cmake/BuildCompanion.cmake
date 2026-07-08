# ─────────────────────────────────────────────────────────────────────────────
# Build the phone companion controller (ui/src/companion, a Vite single-file page)
# and stage it into the bundle so RemoteCompanionServer serves it at /web. Mirrors
# cmake/BuildUI.cmake exactly, but stages to Resources/companion (a separate, tiny
# self-contained HTML) instead of Resources/ui. The C++ build does NOT depend on
# this — webCompanionHtml() falls back to its inline page when the file is absent.
# ─────────────────────────────────────────────────────────────────────────────

find_program(NPM_EXECUTABLE npm)

set(MOSH_UI_DIR         "${CMAKE_SOURCE_DIR}/ui")
set(MOSH_COMPANION_DIST "${MOSH_UI_DIR}/companion-dist")

if (NOT NPM_EXECUTABLE)
    message(WARNING "npm not found — companion page will not be built by CMake. "
                    "Build it manually: (cd ui && npm install && npm run build:companion)")
    return()
endif()

file(GLOB_RECURSE MOSH_COMPANION_SOURCES CONFIGURE_DEPENDS
     "${MOSH_UI_DIR}/src/companion/*.ts"
     "${MOSH_UI_DIR}/src/companion/*.css"
     "${MOSH_UI_DIR}/src/companion/*.html")

add_custom_command(
    OUTPUT  "${MOSH_COMPANION_DIST}/index.html"
    COMMAND ${NPM_EXECUTABLE} install --no-audit --no-fund
    COMMAND ${NPM_EXECUTABLE} run build:companion
    WORKING_DIRECTORY "${MOSH_UI_DIR}"
    DEPENDS "${MOSH_UI_DIR}/package.json"
            "${MOSH_UI_DIR}/vite.companion.config.ts"
            ${MOSH_COMPANION_SOURCES}
    COMMENT "Building Mosh phone companion (Vite single-file) → ui/companion-dist"
    VERBATIM)

add_custom_target(MoshCompanionUI DEPENDS "${MOSH_COMPANION_DIST}/index.html")
add_dependencies(Mosh MoshCompanionUI)

if (APPLE)
    set(MOSH_COMPANION_STAGE_DIR "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/companion")
else()
    set(MOSH_COMPANION_STAGE_DIR "$<TARGET_FILE_DIR:Mosh>/companion")
endif()

add_custom_command(TARGET Mosh POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${MOSH_COMPANION_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${MOSH_COMPANION_DIST}" "${MOSH_COMPANION_STAGE_DIR}"
    COMMENT "Staging companion page → ${MOSH_COMPANION_STAGE_DIR}"
    VERBATIM)

# UI-only iterations rebuild the page but don't relink Mosh; this ALL target restages
# the freshest companion build after the app exists (mirrors MoshStageUI).
add_custom_target(MoshStageCompanion ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${MOSH_COMPANION_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${MOSH_COMPANION_DIST}" "${MOSH_COMPANION_STAGE_DIR}"
    COMMENT "Restaging companion page into the app (UI-only-safe)"
    VERBATIM)
add_dependencies(MoshStageCompanion Mosh MoshCompanionUI)
