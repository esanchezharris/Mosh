# ─────────────────────────────────────────────────────────────────────────────
# Freshness assertion for the staged Moshi phone pad (Resources/companion/pad.html).
#
# Why this exists: `cmake --build` exits 0 when the Vite step inside it fails. The
# app still links, the bundle still gets staged, and `/pad` quietly serves either
# the previous build or the deliberately-inert fallback page — which looks exactly
# like "the phone cannot reach the Mac" from the live room, with nothing in any log
# to say otherwise. A stale pad is therefore not a cosmetic problem: it is a phone
# that silently controls nothing, discovered while someone is standing there singing.
#
# WHICH FILE CARRIES WHICH CLAIM — this is the part that is easy to get wrong.
# `cmake -E copy` does NOT preserve the source mtime: the staged copy is stamped
# "now" on every build, so a timestamp check against the STAGED file can never fail
# and would be a test that cannot fail dressed as a guard. The staleness evidence
# lives in the DIST file (ui/phonepad-dist/index.html), which is exactly what a
# silently-failed Vite run leaves untouched. So:
#
#   PAD  (staged)  — exists, is not truncated, carries the pad's own marker, and is
#                    byte-for-byte the DIST file (the copy really is this build's pad)
#   DIST (built)   — is not older than any pad source (Vite actually ran on the edit)
#
# Usage (from a POST_BUILD / custom target COMMAND):
#   cmake -DPAD=<staged pad.html> -DDIST=<ui/phonepad-dist/index.html>
#         -DMARKER=<string> -DMIN_BYTES=<n> -DSOURCES=<a|b|c>
#         -P cmake/AssertPadStaged.cmake
# SOURCES is '|'-separated, not ';'-separated: a CMake list variable expands into
# separate COMMAND arguments, which would silently truncate the list to its head.
# ─────────────────────────────────────────────────────────────────────────────

if (NOT DEFINED PAD)
    message(FATAL_ERROR "AssertPadStaged: -DPAD=<path> is required")
endif()

set(_rebuild "  Try: (cd ui && npm run build:phonepad) and read its output.")

# 1. The staged file exists at all.
if (NOT EXISTS "${PAD}")
    message(FATAL_ERROR
        "Moshi phone pad NOT staged: ${PAD} does not exist.\n"
        "  The pad build or the staging copy failed. Note that `cmake --build` can exit 0\n"
        "  when the Vite step fails, so a green build is not evidence here.\n"
        "${_rebuild}")
endif()

# 2. It is not empty or half-written. A partial single-file bundle still parses as
#    HTML and still serves — as a dead page with no working buttons.
file(SIZE "${PAD}" _pad_bytes)
if (NOT DEFINED MIN_BYTES)
    set(MIN_BYTES 1024)
endif()
if (_pad_bytes LESS MIN_BYTES)
    message(FATAL_ERROR
        "Moshi phone pad staged but TRUNCATED: ${PAD} is ${_pad_bytes} bytes "
        "(expected at least ${MIN_BYTES}).\n${_rebuild}")
endif()

# 3. It is the pad and not something else copied to this name.
if (DEFINED MARKER AND NOT MARKER STREQUAL "")
    file(READ "${PAD}" _pad_text)
    string(FIND "${_pad_text}" "${MARKER}" _marker_at)
    if (_marker_at EQUAL -1)
        message(FATAL_ERROR
            "Moshi phone pad staged but UNRECOGNISED: ${PAD} does not contain \"${MARKER}\".\n"
            "  Either something other than the pad was copied to this name, or the pad's\n"
            "  own shell (ui/src/phonepad/index.html) changed and this marker is stale.")
    endif()
endif()

if (DEFINED DIST AND NOT DIST STREQUAL "")
    if (NOT EXISTS "${DIST}")
        message(FATAL_ERROR
            "Moshi phone pad DIST missing: ${DIST} does not exist, yet ${PAD} is staged.\n"
            "  The staged file is therefore a leftover from an earlier build.\n${_rebuild}")
    endif()

    # 4. The staged copy IS this build's pad. Catches a copy that silently did not
    #    happen (leftover from a previous build) and a copy that was interrupted.
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -E compare_files "${PAD}" "${DIST}"
        RESULT_VARIABLE _differs OUTPUT_QUIET ERROR_QUIET)
    if (NOT _differs EQUAL 0)
        message(FATAL_ERROR
            "Moshi phone pad staged file does NOT match the build output:\n"
            "    staged: ${PAD}\n"
            "    built:  ${DIST}\n"
            "  The staging copy did not land. /pad would serve an older pad than the one\n"
            "  this build produced.")
    endif()

    # 5. The freshness claim itself, made against the DIST file — the one a silently
    #    failed Vite run leaves untouched. `IS_NEWER_THAN` is true for EQUAL timestamps
    #    too, so this reads as "not older than", which is what a source and an output
    #    written in the same second of a fresh build legitimately look like.
    if (DEFINED SOURCES AND NOT SOURCES STREQUAL "")
        string(REPLACE "|" ";" _sources "${SOURCES}")
        foreach (_source IN LISTS _sources)
            if (_source STREQUAL "")
                continue()
            endif()
            if (NOT EXISTS "${_source}")
                continue()   # captured by a configure-time glob; a deleted file is not staleness
            endif()
            if (NOT "${DIST}" IS_NEWER_THAN "${_source}")
                message(FATAL_ERROR
                    "Moshi phone pad is STALE: ${DIST} is older than\n"
                    "    ${_source}\n"
                    "  The built pad does not contain that source change. This is the failure\n"
                    "  mode `cmake --build`'s exit 0 hides — the Vite step died, the old dist\n"
                    "  was copied into the bundle anyway, and /pad serves the previous page.\n"
                    "${_rebuild}")
            endif()
        endforeach()
    endif()
endif()

message(STATUS "Moshi phone pad staged and fresh: ${PAD} (${_pad_bytes} bytes)")
