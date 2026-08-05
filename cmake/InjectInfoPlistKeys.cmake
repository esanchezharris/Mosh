# InjectInfoPlistKeys.cmake — the single source of truth for the bundle Info.plist
# usage-description keys that JUCE's PLIST_TO_MERGE silently drops under the
# Ninja/Makefiles generator (it is honoured only by the Xcode generator).
#
# Invoked as a script:  cmake -DPLIST=<bundle>/Contents/Info.plist -P InjectInfoPlistKeys.cmake
# from BOTH a Mosh POST_BUILD command (the relink case) AND an always-run ALL target
# (MoshFixInfoPlist — the no-relink / UI-only / deploy case), so the keys can NEVER be
# silently dropped from a shipped bundle. plutil -replace creates-if-absent and is
# idempotent, so running it on every build is cheap and safe.
#
# WHY THIS MATTERS: a missing NSSpeechRecognitionUsageDescription does not degrade —
# macOS TCC HARD-CRASHES (SIGABRT) the moment the always-on voice calls
# SFSpeechRecognizer (src/voice/NativeSpeech.mm). That crash has been misread as a
# plugin-host crash because whatever plugin was loading at the time shows up in the
# crash report; it fires with no plugin loaded at all. Keep this list in sync with
# cmake/MoshRemoteInfo.plist (the Xcode-generator path).

if (NOT PLIST)
    message(FATAL_ERROR "InjectInfoPlistKeys: -DPLIST=<path> is required")
endif()
if (NOT EXISTS "${PLIST}")
    message(FATAL_ERROR "InjectInfoPlistKeys: Info.plist not found at '${PLIST}'")
endif()

# key ; plutil-args... (each entry is one plutil -replace invocation)
set(_speech_text  "Mosh transcribes your voice so you can talk to Moshi, your in-app collaborator, instead of typing.")
set(_camera_text  "Mosh shares your camera with the collaborators in your session, so you can see each other while you produce.")

execute_process(
    COMMAND /usr/bin/plutil -replace NSSpeechRecognitionUsageDescription -string "${_speech_text}" "${PLIST}"
    RESULT_VARIABLE _r_speech)
execute_process(
    COMMAND /usr/bin/plutil -replace NSBonjourServices -json "[\"_moshcompanion._tcp\"]" "${PLIST}"
    RESULT_VARIABLE _r_bonjour)
execute_process(
    COMMAND /usr/bin/plutil -replace NSCameraUsageDescription -string "${_camera_text}" "${PLIST}"
    RESULT_VARIABLE _r_camera)

# PRJ-NAME — .mosh as a Mosh-OWNED document type. Two keys, both required:
#   CFBundleDocumentTypes    — "this app edits these files" (drives double-click + the
#                              per-file Finder icon via CFBundleTypeIconFile).
#   UTExportedTypeDeclarations — declares the UTI itself. Without it macOS has no type to
#                              bind the extension to, and the document entry's icon is
#                              inconsistently applied.
# MoshDoc(.icns) is staged into Contents/Resources by cmake/BuildDocumentIcon.cmake; the
# EXISTS check at the bottom of this file is what keeps the two from drifting apart.
set(_doc_types
    "[{\"CFBundleTypeName\":\"Mosh Project\",\"CFBundleTypeRole\":\"Editor\",\"LSHandlerRank\":\"Owner\",\"CFBundleTypeExtensions\":[\"mosh\"],\"LSItemContentTypes\":[\"studio.mosh.project\"],\"CFBundleTypeIconFile\":\"MoshDoc\"}]")
set(_uti_exports
    "[{\"UTTypeIdentifier\":\"studio.mosh.project\",\"UTTypeDescription\":\"Mosh Project\",\"UTTypeConformsTo\":[\"public.data\"],\"UTTypeIconFile\":\"MoshDoc\",\"UTTypeTagSpecification\":{\"public.filename-extension\":[\"mosh\"]}}]")

execute_process(
    COMMAND /usr/bin/plutil -replace CFBundleDocumentTypes -json "${_doc_types}" "${PLIST}"
    RESULT_VARIABLE _r_doctypes)
execute_process(
    COMMAND /usr/bin/plutil -replace UTExportedTypeDeclarations -json "${_uti_exports}" "${PLIST}"
    RESULT_VARIABLE _r_uti)

if (_r_speech OR _r_bonjour OR _r_camera OR _r_doctypes OR _r_uti)
    message(FATAL_ERROR
        "InjectInfoPlistKeys: plutil failed on '${PLIST}' "
        "(speech=${_r_speech} bonjour=${_r_bonjour} camera=${_r_camera} "
        "doctypes=${_r_doctypes} uti=${_r_uti})")
endif()

# Fail-closed: prove the mandatory key actually landed (a silent plutil no-op would
# otherwise let a TCC-crashing bundle ship).
execute_process(
    COMMAND /usr/bin/plutil -extract NSSpeechRecognitionUsageDescription raw "${PLIST}"
    RESULT_VARIABLE _r_verify OUTPUT_QUIET ERROR_QUIET)
if (_r_verify)
    message(FATAL_ERROR
        "InjectInfoPlistKeys: NSSpeechRecognitionUsageDescription missing AFTER inject in '${PLIST}' "
        "— the bundle would TCC-crash on voice. Aborting build.")
endif()

# PRJ-NAME — same fail-closed posture for the document type. Both halves are checked
# because either one missing degrades SILENTLY: no doc types ⇒ double-clicking a .mosh
# does nothing and the file shows a blank-page icon; no UTI export ⇒ the extension binds
# to nothing. A silent generic icon is precisely the bug this change exists to fix, so it
# must never be something a build can ship.
foreach(_key CFBundleDocumentTypes UTExportedTypeDeclarations)
    execute_process(COMMAND /usr/bin/plutil -extract ${_key} raw "${PLIST}"
                    RESULT_VARIABLE _r_doc_verify OUTPUT_QUIET ERROR_QUIET)
    if (_r_doc_verify)
        message(FATAL_ERROR
            "InjectInfoPlistKeys: ${_key} missing AFTER inject in '${PLIST}' "
            "— .mosh files would show a generic icon and not open on double-click.")
    endif()
endforeach()

# ...and the icon the two keys point at has to actually be in the bundle. The plist can be
# perfect while Resources/MoshDoc.icns is absent, and the visible symptom is identical.
get_filename_component(_plist_dir "${PLIST}" DIRECTORY)
if (NOT EXISTS "${_plist_dir}/Resources/MoshDoc.icns")
    message(FATAL_ERROR
        "InjectInfoPlistKeys: '${_plist_dir}/Resources/MoshDoc.icns' is missing — the plist "
        "claims a document icon the bundle does not carry, so Finder would fall back to a "
        "generic blank page. Check cmake/BuildDocumentIcon.cmake ran.")
endif()
