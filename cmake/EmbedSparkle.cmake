# EmbedSparkle.cmake — copy Sparkle.framework into the app bundle's Frameworks dir.
#
# Invoked as a script:
#   cmake -DFRAMEWORK=<…/Sparkle.framework> -DBUNDLE=<…/Mosh.app> -P EmbedSparkle.cmake
# from BOTH a Mosh POST_BUILD command and an always-run ALL target (MoshEmbedSparkle),
# so a no-relink / UI-only / deploy build can never ship a bundle whose Frameworks dir
# is missing — that failure mode is not graceful, it is "Library not loaded:
# @rpath/Sparkle.framework/…" at launch, i.e. the app does not start at all.
#
# ditto, NOT `cmake -E copy_directory`: a macOS framework is a symlink farm
# (Sparkle → Versions/Current/Sparkle → Versions/B/Sparkle, plus Headers/Resources/
# Updater.app/XPCServices). copy_directory FOLLOWS symlinks, which both doubles the
# payload and — fatally — breaks the bundle layout codesign seals, so the copy would
# fail `codesign --verify --deep --strict`. ditto reproduces symlinks verbatim.

if (NOT FRAMEWORK)
    message(FATAL_ERROR "EmbedSparkle: -DFRAMEWORK=<path/Sparkle.framework> is required")
endif()
if (NOT BUNDLE)
    message(FATAL_ERROR "EmbedSparkle: -DBUNDLE=<path/Mosh.app> is required")
endif()
if (NOT EXISTS "${FRAMEWORK}")
    message(FATAL_ERROR "EmbedSparkle: framework not found at '${FRAMEWORK}'")
endif()
if (NOT EXISTS "${BUNDLE}")
    message(FATAL_ERROR "EmbedSparkle: app bundle not found at '${BUNDLE}'")
endif()

find_program(_ditto ditto)
if (NOT _ditto)
    message(FATAL_ERROR "EmbedSparkle: ditto is required")
endif()

get_filename_component(_fw_name "${FRAMEWORK}" NAME)
set(_dest_dir "${BUNDLE}/Contents/Frameworks")
set(_dest     "${_dest_dir}/${_fw_name}")

file(MAKE_DIRECTORY "${_dest_dir}")
# Replace rather than merge: a stale Versions/ left over from an older Sparkle pin
# would keep its own _CodeSignature and fail strict verification.
file(REMOVE_RECURSE "${_dest}")

execute_process(COMMAND "${_ditto}" "${FRAMEWORK}" "${_dest}"
                RESULT_VARIABLE _r OUTPUT_VARIABLE _o ERROR_VARIABLE _e)
if (_r)
    message(FATAL_ERROR "EmbedSparkle: ditto failed copying '${FRAMEWORK}' → '${_dest}'\n${_o}${_e}")
endif()

# Fail-closed: prove the versioned binary the app's @rpath resolves to actually landed
# AS A SYMLINK FARM. A successful ditto that produced a flattened tree would still let
# a non-launching bundle ship.
if (NOT EXISTS "${_dest}/Versions/B/Sparkle")
    message(FATAL_ERROR "EmbedSparkle: '${_dest}/Versions/B/Sparkle' missing after copy")
endif()
if (NOT IS_SYMLINK "${_dest}/Sparkle")
    message(FATAL_ERROR
        "EmbedSparkle: '${_dest}/Sparkle' is not a symlink after copy — the framework layout "
        "was flattened, which breaks codesign --deep --strict and the runtime load path.")
endif()
