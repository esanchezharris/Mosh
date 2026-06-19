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

# Stage the built bundle where WebBridge can serve it after the app links.
add_dependencies(Mosh MoshUI)
# macOS-only project (CMakeLists.txt FATAL_ERRORs on non-Apple before this runs),
# so the bundle is always Mosh.app/Contents/Resources/ui.
add_custom_command(TARGET Mosh POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -rf
            "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/ui"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${MOSH_UI_DIST}"
            "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/ui"
    COMMENT "Staging UI bundle into Mosh.app/Contents/Resources/ui"
    VERBATIM)

# The POST_BUILD staging above only runs when the Mosh target itself relinks.
# UI-only iterations (no C++ change) rebuild the bundle via MoshUI but never
# relink Mosh, so the app would ship a STALE bundle. This ALL target always
# restages the freshest dist after the app exists (it depends on Mosh + MoshUI),
# closing that gap. Build it (or the default `all`) to guarantee a fresh bundle.
set(MOSH_UI_STAGE_DIR "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/ui")
add_custom_target(MoshStageUI ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${MOSH_UI_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${MOSH_UI_DIST}" "${MOSH_UI_STAGE_DIR}"
    COMMENT "Restaging UI bundle into the app (UI-only-safe)"
    VERBATIM)
add_dependencies(MoshStageUI Mosh MoshUI)
