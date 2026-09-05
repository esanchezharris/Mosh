# Catch2 tests + the MoshOps spine units (06 §4).
# A JUCE console app so tests can use juce::ValueTree / SHA256 (the RenderLayer
# round-trip + full-fingerprint cache key). The live command-surface harness
# (driving a real engine) is exercised through the running app at the gate; these
# units cover the pure, engine-free logic.

juce_add_console_app(MoshTests PRODUCT_NAME "MoshTests")

target_sources(MoshTests PRIVATE
    test_sanity.cpp
    test_session_paths.cpp
    test_audio_device_startup.cpp
    test_webview_camera_permission.cpp
    # Measured round-trip latency calibration (ported from Moshpit M005/M006):
    # detector, session lifecycle, and record maths. Engine-free; needs
    # juce_audio_devices only for the AudioIODeviceCallback interface.
    test_latency_calibration.cpp
    test_drum_pattern.cpp
    test_automation_mode.cpp
    test_automation_curve_write.cpp
    test_clip_loop_phase.cpp
    test_render_source_window.cpp
    test_export_range.cpp
    test_export_dither.cpp
    test_plugin_editor_param_gesture.cpp
    test_plugin_scan_progress.cpp
    test_moshfx_dsp.cpp
    test_renderlayer.cpp
    test_migrations.cpp
    test_project_name.cpp
    test_safe_mode.cpp
    test_count_in.cpp
    test_sections.cpp
    test_clip_groups.cpp
    test_track_groups.cpp
    test_lyrics.cpp
    test_agent_memory.cpp
    test_agent_txn.cpp
    # Skill Foundry Task 4 — the native safe loader for certified skill packages.
    # Engine-free (juce_core + juce_data_structures + juce_cryptography only), same
    # posture as AgentMemoryStore.h/test_agent_memory.cpp above.
    test_certified_skill_loader.cpp
    ${CMAKE_SOURCE_DIR}/src/agent/CertifiedSkillLoader.cpp
    test_annotations.cpp
    test_remote_companion.cpp
    test_recording_landing.cpp
    # CAP-001 — recording residue after an unclean exit (engine-free decisions).
    test_recording_residue.cpp
    # Skill Foundry Slice B, Task 1 — stable, persisted take identity. Engine-free
    # (juce_core + juce_data_structures only), same posture as RecordingLanding.h/
    # test_recording_landing.cpp above.
    test_take_identity.cpp
    test_multiplayer_logical_id.cpp
    test_multiplayer_audio_ref.cpp
    test_multiplayer_lock_manager.cpp
    test_multiplayer_outbox.cpp
    test_multiplayer_transfer_queue.cpp
    test_training.cpp
    test_webbridge_resource_guard.cpp
    test_webview_cursor.cpp
    test_directory_listing.cpp
    test_import_copy.cpp
    test_sample_folder_store.cpp
    test_rt_guard.cpp
    test_generative_jobmanager.cpp
    test_reimagine_core.cpp
    test_rave_engine.cpp
    test_stem_export.cpp
    test_telemetry.cpp
    # FS-K3 — Sentry crash reporting. SentryReporter.cpp is compiled
    # unconditionally (MOSH_HAVE_SENTRY gates its BODY, not its existence — the
    # RaveEngine.cpp arrangement noted below); MoshTests never defines
    # MOSH_HAVE_SENTRY, so these cases pin the pure scrubber + the consent gate
    # against the no-SDK branch, with no DSN, no network and no crashpad handler.
    test_sentry_scrub.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/SentryReporter.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/Breadcrumbs.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/CrashReportFormatter.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/TelemetryConfig.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/Telemetry.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/CrashHandler.cpp
    test_brain_proxy.cpp
    test_owner_runtime.cpp
    ${CMAKE_SOURCE_DIR}/src/brain/BrainProxy.cpp
    ${CMAKE_SOURCE_DIR}/src/brain/OwnerRuntime.cpp
    ${CMAKE_SOURCE_DIR}/src/generative/GenerativeJobManager.cpp
    ${CMAKE_SOURCE_DIR}/src/reimagine/ReImagineCore.cpp
    ${CMAKE_SOURCE_DIR}/src/reimagine/ReImagineService.cpp
    ${CMAKE_SOURCE_DIR}/src/audio/RealtimeAudioGuard.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/LockManager.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/AudioRefValidation.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/OutboundQueue.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/TransferQueue.cpp
    ${CMAKE_SOURCE_DIR}/src/remote/RemoteCompanionProtocol.cpp
    ${CMAKE_SOURCE_DIR}/src/remote/RemoteCompanionServer.cpp
    ${CMAKE_SOURCE_DIR}/src/training/TrainerRegistry.cpp
    ${CMAKE_SOURCE_DIR}/src/webview/UiResourcePathGuard.cpp
    ${CMAKE_SOURCE_DIR}/src/files/DirectoryListing.cpp
    ${CMAKE_SOURCE_DIR}/src/files/ImportCopy.cpp
    ${CMAKE_SOURCE_DIR}/src/files/SampleFolderStore.cpp
    # RaveEngine.cpp is unconditionally compiled (MOSH_HAVE_ANIRA gates its body,
    # not its existence — see cmake/Dependencies.cmake); MoshTests never defines
    # MOSH_HAVE_ANIRA, so this always builds the graceful no-op stub branch. That
    # is exactly what test_rave_engine.cpp exercises (AL-022's additive
    # lastError() surface, compile-safe in the default anira-off build).
    ${CMAKE_SOURCE_DIR}/src/plugins/transform/RaveEngine.cpp
    ${CMAKE_SOURCE_DIR}/src/plugins/moshfx/MoshAutoTuneDsp.cpp
    ${CMAKE_SOURCE_DIR}/src/plugins/moshfx/MoshOTTDsp.cpp
    ${CMAKE_SOURCE_DIR}/src/plugins/moshfx/MoshXFeedbackDsp.cpp)

target_include_directories(MoshTests PRIVATE ${CMAKE_SOURCE_DIR}/src)

target_compile_definitions(MoshTests PRIVATE
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_STANDALONE_APPLICATION=1
    MOSH_TESTING=1
    # RT-safety tripwire active in the test target so test_rt_guard.cpp can exercise it.
    MOSH_RT_GUARD=1
    # Skill Foundry Task 4 — same build-identity macros as the Mosh app target (set by
    # the root CMakeLists.txt's "Native build identity" block, ABOVE this
    # add_subdirectory(tests) call, so MOSH_GIT_COMMIT/MOSH_GIT_STATE/
    # MOSH_BUILD_ARCHITECTURE are already defined variables here). MoshTests never
    # defines MOSH_VERSION_STRING (no PROJECT_VERSION need there today), so
    # CertifiedSkillLoader.cpp's buildIdentityVar() degrades appVersion to "unknown" in
    # this target — by design (see that function's own comment), not a gap.
    MOSH_GIT_COMMIT_STRING="${MOSH_GIT_COMMIT}"
    MOSH_GIT_STATE_STRING="${MOSH_GIT_STATE}"
    MOSH_BUILD_ARCHITECTURE_STRING="${MOSH_BUILD_ARCHITECTURE}"
    MOSH_BUILD_CONFIGURATION_STRING="$<CONFIG>")

target_link_libraries(MoshTests PRIVATE
    Catch2::Catch2WithMain
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_cryptography
    # CAP-001 — test_recording_residue.cpp proves a repaired crash-torn WAV reads back
    # through a real reader, which needs the WAV codec; still engine-free.
    juce::juce_audio_formats
    juce::juce_audio_devices
    juce::juce_recommended_config_flags)

add_test(NAME MoshTests COMMAND $<TARGET_FILE:MoshTests>)
add_test(NAME HarnessSessionShell
         COMMAND bash ${CMAKE_SOURCE_DIR}/scripts/lib/harness-session-test.sh)
add_test(NAME HarnessSessionPython
         COMMAND python3 ${CMAKE_SOURCE_DIR}/scripts/verify-hardware/harness_session_test.py)
if (APPLE)
    add_test(NAME PrivacyManifest
             COMMAND bash ${CMAKE_SOURCE_DIR}/tests/privacy-manifest-test.sh)
    add_test(NAME MoshMidiCursorGateTypecheck
             COMMAND /usr/bin/xcrun swiftc -typecheck
                     ${CMAKE_SOURCE_DIR}/scripts/macos-midi-cursor-gate.swift)
    add_test(NAME MoshMidiSelectionGateTypecheck
             COMMAND /usr/bin/xcrun swiftc -typecheck
                     ${CMAKE_SOURCE_DIR}/scripts/macos-midi-selection-gate.swift)
endif()
if (TARGET Mosh)
    add_test(NAME AudioRecoverySmoke
             COMMAND bash ${CMAKE_SOURCE_DIR}/tests/audio-recovery-isolation-test.sh
                          $<TARGET_FILE:Mosh>)
    add_test(NAME SessionAllocationFailure
             COMMAND bash ${CMAKE_SOURCE_DIR}/tests/session-allocation-failure-test.sh
                          $<TARGET_FILE:Mosh>)
    set_tests_properties(AudioRecoverySmoke PROPERTIES
        TIMEOUT 15)
    set_tests_properties(SessionAllocationFailure PROPERTIES
        TIMEOUT 15)
endif()
# test_training.cpp shells out to service/training relative to the CWD, so ctest
# must run the suite from the repo root.
set_tests_properties(MoshTests PROPERTIES
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
