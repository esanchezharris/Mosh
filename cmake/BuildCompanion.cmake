# ─────────────────────────────────────────────────────────────────────────────
# Build the phone companion controller (ui/src/companion, a Vite single-file page)
# and the Moshi phone recording pad (ui/src/phonepad, a separate Vite single-file
# page) and stage them into the bundle so RemoteCompanionServer serves them at
# /web and /pad (as pad.html) respectively. Mirrors cmake/BuildUI.cmake exactly,
# but stages to Resources/companion (small self-contained HTML files) instead of
# Resources/ui. The C++ build does NOT depend on this — webCompanionHtml() falls
# back to its inline page when the file is absent.
# ─────────────────────────────────────────────────────────────────────────────

find_program(NPM_EXECUTABLE npm)

set(MOSH_UI_DIR         "${CMAKE_SOURCE_DIR}/ui")
set(MOSH_COMPANION_DIST "${MOSH_UI_DIR}/companion-dist")
set(MOSH_PHONEPAD_DIST  "${MOSH_UI_DIR}/phonepad-dist")

if (NOT NPM_EXECUTABLE)
    message(WARNING "npm not found — companion page will not be built by CMake. "
                    "Build it manually: (cd ui && npm install && npm run build:companion && npm run build:phonepad)")
    return()
endif()

file(GLOB_RECURSE MOSH_COMPANION_SOURCES CONFIGURE_DEPENDS
     "${MOSH_UI_DIR}/src/companion/*.ts"
     "${MOSH_UI_DIR}/src/companion/*.css"
     "${MOSH_UI_DIR}/src/companion/*.html")

file(GLOB_RECURSE MOSH_PHONEPAD_SOURCES CONFIGURE_DEPENDS
     "${MOSH_UI_DIR}/src/phonepad/src/*.ts"
     "${MOSH_UI_DIR}/src/phonepad/src/*.css"
     "${MOSH_UI_DIR}/src/phonepad/index.html")

add_custom_command(
    OUTPUT  "${MOSH_COMPANION_DIST}/index.html"
            "${MOSH_PHONEPAD_DIST}/index.html"
    COMMAND ${NPM_EXECUTABLE} install --no-audit --no-fund
    COMMAND ${NPM_EXECUTABLE} run build:companion
    COMMAND ${NPM_EXECUTABLE} run build:phonepad
    WORKING_DIRECTORY "${MOSH_UI_DIR}"
    DEPENDS "${MOSH_UI_DIR}/package.json"
            "${MOSH_UI_DIR}/vite.companion.config.ts"
            "${MOSH_UI_DIR}/vite.phonepad.config.ts"
            "${MOSH_UI_DIR}/src/phonepad/tsconfig.json"
            ${MOSH_COMPANION_SOURCES}
            ${MOSH_PHONEPAD_SOURCES}
    COMMENT "Building Mosh phone companion + phone pad (Vite single-file) → ui/companion-dist, ui/phonepad-dist"
    VERBATIM)

add_custom_target(MoshCompanionUI DEPENDS "${MOSH_COMPANION_DIST}/index.html" "${MOSH_PHONEPAD_DIST}/index.html")
add_dependencies(Mosh MoshCompanionUI)

if (APPLE)
    set(MOSH_COMPANION_STAGE_DIR "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/companion")
else()
    set(MOSH_COMPANION_STAGE_DIR "$<TARGET_FILE_DIR:Mosh>/companion")
endif()

# The freshness assertion both staging blocks end with. `cmake --build` exits 0 when the
# Vite step inside it fails (see cmake/AssertPadStaged.cmake), so the ONLY thing standing
# between a failed pad build and a phone that silently controls nothing is this check.
#
# BOTH paths are passed deliberately. `cmake -E copy` stamps the destination with the
# current time, so the STAGED file always looks fresh and a timestamp check against it
# could never fail; the staleness evidence is in the DIST file, which a silently-failed
# Vite run leaves untouched. The script checks shape and identity on the staged copy and
# age on the dist — see its header.
#
# The source list is joined with '|' because a ';'-separated CMake list would expand into
# separate COMMAND arguments and the script would only ever see the first one. index.html
# is the pad's shell (it carries the MOSHI · LOCAL marker asserted below) and is NOT in
# MOSH_PHONEPAD_SOURCES' src/ globs, so it is appended explicitly.
set(MOSH_PAD_FRESHNESS_INPUTS ${MOSH_PHONEPAD_SOURCES} "${MOSH_UI_DIR}/src/phonepad/index.html")
string(REPLACE ";" "|" MOSH_PAD_FRESHNESS_INPUTS_JOINED "${MOSH_PAD_FRESHNESS_INPUTS}")

set(MOSH_ASSERT_PAD_STAGED
    ${CMAKE_COMMAND}
    "-DPAD=${MOSH_COMPANION_STAGE_DIR}/pad.html"
    "-DDIST=${MOSH_PHONEPAD_DIST}/index.html"
    "-DMARKER=MOSHI · LOCAL"
    "-DMIN_BYTES=4096"
    "-DSOURCES=${MOSH_PAD_FRESHNESS_INPUTS_JOINED}"
    -P "${CMAKE_SOURCE_DIR}/cmake/AssertPadStaged.cmake")

add_custom_command(TARGET Mosh POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${MOSH_COMPANION_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${MOSH_COMPANION_DIST}" "${MOSH_COMPANION_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy "${MOSH_PHONEPAD_DIST}/index.html" "${MOSH_COMPANION_STAGE_DIR}/pad.html"
    COMMAND ${MOSH_ASSERT_PAD_STAGED}
    COMMENT "Staging companion page (→ /web) + phone pad (→ /pad) into ${MOSH_COMPANION_STAGE_DIR}"
    VERBATIM)

# UI-only iterations rebuild the page but don't relink Mosh; this ALL target restages
# the freshest companion build after the app exists (mirrors MoshStageUI).
add_custom_target(MoshStageCompanion ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${MOSH_COMPANION_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${MOSH_COMPANION_DIST}" "${MOSH_COMPANION_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy "${MOSH_PHONEPAD_DIST}/index.html" "${MOSH_COMPANION_STAGE_DIR}/pad.html"
    COMMAND ${MOSH_ASSERT_PAD_STAGED}
    COMMENT "Restaging companion page (→ /web) + phone pad (→ /pad) into the app (UI-only-safe)"
    VERBATIM)
add_dependencies(MoshStageCompanion Mosh MoshCompanionUI)
