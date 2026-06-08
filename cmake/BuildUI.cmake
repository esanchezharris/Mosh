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

# Vite build → ui/dist. Re-runs when sources change (tracked via a stamp).
add_custom_command(
    OUTPUT  "${MOSH_UI_DIST}/index.html"
    COMMAND ${NPM_EXECUTABLE} install --no-audit --no-fund
    COMMAND ${NPM_EXECUTABLE} run build
    WORKING_DIRECTORY "${MOSH_UI_DIR}"
    DEPENDS "${MOSH_UI_DIR}/package.json"
            "${MOSH_UI_DIR}/vite.config.ts"
    COMMENT "Building Mosh UI (Vite) → ui/dist"
    VERBATIM)

add_custom_target(MoshUI DEPENDS "${MOSH_UI_DIST}/index.html")

# Stage the built bundle into Mosh.app/Contents/Resources/ui after the app links.
add_dependencies(Mosh MoshUI)
add_custom_command(TARGET Mosh POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -rf
            "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/ui"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${MOSH_UI_DIST}"
            "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/ui"
    COMMENT "Staging UI bundle into Mosh.app/Contents/Resources/ui"
    VERBATIM)
