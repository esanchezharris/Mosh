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

if (_r_speech OR _r_bonjour OR _r_camera)
    message(FATAL_ERROR
        "InjectInfoPlistKeys: plutil failed on '${PLIST}' "
        "(speech=${_r_speech} bonjour=${_r_bonjour} camera=${_r_camera})")
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
