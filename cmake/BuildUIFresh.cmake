# ─────────────────────────────────────────────────────────────────────────────
# BuildUIFresh.cmake (script mode) — the UI bundle's freshness check, done
# EXPLICITLY instead of via Ninja's OUTPUT/DEPENDS mtime heuristic.
#
# The trap this closes (verified 2026-08-07 on the freeze wave): the old design
# captured ui/src deps in a CONFIGURE_DEPENDS glob feeding add_custom_command
# (OUTPUT ui/dist/index.html). That rebuild fired unreliably — a plain
# `cmake --build` could leave BOTH ui/dist and the staged app-bundle copy stale
# after UI-only edits (the staged Resources/ui only refreshed when something
# re-copied it), and the packaged app shipped last wave's UI.
#
# Two modes (invoked from cmake/BuildUI.cmake):
#   MODE=build — re-glob ui/src at RUN time (no configure-time staleness, new
#                files included by construction); if any source or build input
#                is newer than ui/dist/index.html (or dist is missing), run
#                npm install + npm run build. Otherwise a no-op.
#   MODE=stage — if ui/dist/index.html is newer than the staged copy (or the
#                stage is missing), rm + copy_directory. Otherwise a no-op, so
#                clean trees keep the staged mtimes untouched (and the ad-hoc
#                signature refresh stays cheap).
#
# Args: MOSH_UI_DIR, MOSH_UI_DIST, MOSH_UI_STAGE_DIR (stage mode), NPM_EXECUTABLE,
#       MODE.
# ─────────────────────────────────────────────────────────────────────────────

if (NOT DEFINED MODE)
    message(FATAL_ERROR "BuildUIFresh.cmake needs -DMODE=build|stage")
endif()

# Newest mtime (epoch seconds) across a file list; empty list ⇒ "".
function (newest_mtime outVar)
    set(newest "")
    foreach (f IN LISTS ARGN)
        if (EXISTS "${f}")
            file(TIMESTAMP "${f}" mt "%s" UTC)
            if (newest STREQUAL "" OR mt GREATER newest)
                set(newest "${mt}")
            endif()
        endif()
    endforeach()
    set(${outVar} "${newest}" PARENT_SCOPE)
endfunction()

if (MODE STREQUAL "build")
    file(GLOB_RECURSE uiSources
         "${MOSH_UI_DIR}/src/*.ts"
         "${MOSH_UI_DIR}/src/*.tsx"
         "${MOSH_UI_DIR}/src/*.css")
    newest_mtime (srcMt ${uiSources}
                  "${MOSH_UI_DIR}/package.json"
                  "${MOSH_UI_DIR}/package-lock.json"
                  "${MOSH_UI_DIR}/vite.config.ts"
                  "${MOSH_UI_DIR}/index.html")
    set(distMt "")
    if (EXISTS "${MOSH_UI_DIST}/index.html")
        file(TIMESTAMP "${MOSH_UI_DIST}/index.html" distMt "%s" UTC)
    endif()
    if (distMt STREQUAL "" OR (NOT srcMt STREQUAL "" AND srcMt GREATER distMt))
        message(STATUS "UI sources newer than ui/dist (or dist missing) — building Mosh UI (Vite)")
        execute_process(COMMAND "${NPM_EXECUTABLE}" install --no-audit --no-fund
                        WORKING_DIRECTORY "${MOSH_UI_DIR}" RESULT_VARIABLE rc)
        if (NOT rc EQUAL 0)
            message(FATAL_ERROR "npm install failed (${rc})")
        endif()
        execute_process(COMMAND "${NPM_EXECUTABLE}" run build
                        WORKING_DIRECTORY "${MOSH_UI_DIR}" RESULT_VARIABLE rc)
        if (NOT rc EQUAL 0)
            message(FATAL_ERROR "npm run build failed (${rc})")
        endif()
        if (NOT EXISTS "${MOSH_UI_DIST}/index.html")
            message(FATAL_ERROR "Vite build finished but ${MOSH_UI_DIST}/index.html is missing")
        endif()
    else()
        message(STATUS "ui/dist is fresher than ui/src — UI bundle up to date")
    endif()
elseif (MODE STREQUAL "stage")
    set(distMt "")
    if (EXISTS "${MOSH_UI_DIST}/index.html")
        file(TIMESTAMP "${MOSH_UI_DIST}/index.html" distMt "%s" UTC)
    endif()
    set(stageMt "")
    if (EXISTS "${MOSH_UI_STAGE_DIR}/index.html")
        file(TIMESTAMP "${MOSH_UI_STAGE_DIR}/index.html" stageMt "%s" UTC)
    endif()
    if (distMt STREQUAL "")
        message(STATUS "ui/dist missing — nothing to stage (the WebView falls back to the dev server)")
    elseif (stageMt STREQUAL "" OR distMt GREATER stageMt)
        message(STATUS "Restaging UI bundle into the app (dist newer than the staged copy)")
        file(REMOVE_RECURSE "${MOSH_UI_STAGE_DIR}")
        file(COPY "${MOSH_UI_DIST}/" DESTINATION "${MOSH_UI_STAGE_DIR}")
    else()
        message(STATUS "Staged UI bundle already matches ui/dist — no restage")
    endif()
else()
    message(FATAL_ERROR "BuildUIFresh.cmake: unknown MODE '${MODE}'")
endif()
