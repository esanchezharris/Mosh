# BuildDocumentIcon.cmake — PRJ-NAME: the Finder icon for a .mosh project file.
#
# Invoked as a script:
#   cmake -DSOURCE_PNG=<icon.png> -DOUT_ICNS=<bundle>/Contents/Resources/MoshDoc.icns
#         -P BuildDocumentIcon.cmake
#
# WHY A SEPARATE .icns AT ALL: the app icon that JUCE generates from ICON_BIG lands as
# AppIcon.icns and is claimed by CFBundleIconFile. A document type needs its OWN icon
# file by name (CFBundleTypeIconFile / UTTypeIconFile); pointing those at AppIcon works
# only by accident of both living in Resources, and breaks the moment JUCE renames it.
# So we derive a second, explicitly-named copy from the SAME source PNG — the Moshi face
# is deliberately the whole icon (no page-with-inset treatment), which is the agreed look.
#
# Idempotent and cheap: skipped entirely when the .icns is already newer than the PNG.
# Fail-closed on every step — a silently-missing icon file yields a generic blank-page
# document in Finder, which is EXACTLY the failure this whole change exists to fix, and
# it would look like a plist bug rather than a missing resource.

if (NOT SOURCE_PNG)
    message(FATAL_ERROR "BuildDocumentIcon: -DSOURCE_PNG=<path> is required")
endif()
if (NOT OUT_ICNS)
    message(FATAL_ERROR "BuildDocumentIcon: -DOUT_ICNS=<path> is required")
endif()
if (NOT EXISTS "${SOURCE_PNG}")
    message(FATAL_ERROR "BuildDocumentIcon: source PNG not found at '${SOURCE_PNG}'")
endif()

if (EXISTS "${OUT_ICNS}" AND "${OUT_ICNS}" IS_NEWER_THAN "${SOURCE_PNG}")
    return()
endif()

find_program(_sips sips)
find_program(_iconutil iconutil)
if (NOT _sips OR NOT _iconutil)
    message(FATAL_ERROR
        "BuildDocumentIcon: sips and iconutil are required (sips='${_sips}' iconutil='${_iconutil}')")
endif()

get_filename_component(_out_dir "${OUT_ICNS}" DIRECTORY)
file(MAKE_DIRECTORY "${_out_dir}")

# A scratch iconset next to the output, removed on the way out. Named per-output so two
# concurrent configure/build trees can never race on the same path.
get_filename_component(_stem "${OUT_ICNS}" NAME_WE)
set(_iconset "${_out_dir}/${_stem}.iconset")
file(REMOVE_RECURSE "${_iconset}")
file(MAKE_DIRECTORY "${_iconset}")

# The sizes Finder actually asks for. iconutil rejects an iconset missing the ones it
# wants, so this list is the contract, not a preference.
set(_sizes 16 32 128 256 512)
foreach(_s IN LISTS _sizes)
    math(EXPR _s2 "${_s} * 2")
    execute_process(
        COMMAND "${_sips}" -z ${_s} ${_s} "${SOURCE_PNG}" --out "${_iconset}/icon_${_s}x${_s}.png"
        RESULT_VARIABLE _r1 OUTPUT_QUIET ERROR_QUIET)
    execute_process(
        COMMAND "${_sips}" -z ${_s2} ${_s2} "${SOURCE_PNG}" --out "${_iconset}/icon_${_s}x${_s}@2x.png"
        RESULT_VARIABLE _r2 OUTPUT_QUIET ERROR_QUIET)
    if (_r1 OR _r2)
        file(REMOVE_RECURSE "${_iconset}")
        message(FATAL_ERROR "BuildDocumentIcon: sips failed at ${_s}px (${_r1}/${_r2})")
    endif()
endforeach()

execute_process(COMMAND "${_iconutil}" -c icns "${_iconset}" -o "${OUT_ICNS}"
                RESULT_VARIABLE _r_icns
                OUTPUT_VARIABLE _icns_out ERROR_VARIABLE _icns_err)
file(REMOVE_RECURSE "${_iconset}")

if (_r_icns OR NOT EXISTS "${OUT_ICNS}")
    message(FATAL_ERROR
        "BuildDocumentIcon: iconutil failed to produce '${OUT_ICNS}'\n${_icns_out}${_icns_err}")
endif()
