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

# Track the actual React sources so a UI change triggers a rebuild (not just
# package.json/vite.config.ts). CONFIGURE_DEPENDS re-globs at build time.
file(GLOB_RECURSE MOSH_UI_SOURCES CONFIGURE_DEPENDS
     "${MOSH_UI_DIR}/src/*.ts"
     "${MOSH_UI_DIR}/src/*.tsx"
     "${MOSH_UI_DIR}/src/*.css")

# Vite build → ui/dist (single-file: vite-plugin-singlefile inlines JS+CSS into
# one index.html — required so the JUCE WebView's resource-provider scheme runs
# the bundle; external module scripts silently don't execute there).
add_custom_command(
    OUTPUT  "${MOSH_UI_DIST}/index.html"
    COMMAND ${NPM_EXECUTABLE} install --no-audit --no-fund
    COMMAND ${NPM_EXECUTABLE} run build
    WORKING_DIRECTORY "${MOSH_UI_DIR}"
    DEPENDS "${MOSH_UI_DIR}/package.json"
            "${MOSH_UI_DIR}/vite.config.ts"
            "${MOSH_UI_DIR}/index.html"
            ${MOSH_UI_SOURCES}
    COMMENT "Building Mosh UI (Vite) → ui/dist"
    VERBATIM)

add_custom_target(MoshUI DEPENDS "${MOSH_UI_DIST}/index.html")

# Stage the built bundle where WebBridge can serve it. NOT a POST_BUILD hook:
# those only fire when the Mosh target relinks, so a UI-only change rebuilt
# ui/dist and then silently shipped a STALE bundle inside the .app (the
# S17-0 "fix didn't fix it" trap). A stamp-file rule re-stages whenever dist
# changes; `cmake --build <dir>` (default target) covers both app and UI.
add_dependencies(Mosh MoshUI)
set(MOSH_UI_STAGE_STAMP "${CMAKE_BINARY_DIR}/ui-stage.stamp")
if (APPLE)
    set(MOSH_UI_STAGE_DEST "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/ui")
else()
    set(MOSH_UI_STAGE_DEST "$<TARGET_FILE_DIR:Mosh>/ui")
endif()
add_custom_command(
    OUTPUT  "${MOSH_UI_STAGE_STAMP}"
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${MOSH_UI_STAGE_DEST}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${MOSH_UI_DIST}" "${MOSH_UI_STAGE_DEST}"
    COMMAND ${CMAKE_COMMAND} -E touch "${MOSH_UI_STAGE_STAMP}"
    DEPENDS "${MOSH_UI_DIST}/index.html" Mosh
    COMMENT "Staging UI bundle into the app (stamp: re-runs on any dist change)"
    VERBATIM)
add_custom_target(MoshUIStage ALL DEPENDS "${MOSH_UI_STAGE_STAMP}")
