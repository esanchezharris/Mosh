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
    test_drum_pattern.cpp
    test_automation_mode.cpp
    test_automation_curve_write.cpp
    test_export_range.cpp
    test_plugin_scan_progress.cpp
    test_moshfx_dsp.cpp
    test_renderlayer.cpp
    test_migrations.cpp
    test_count_in.cpp
    test_sections.cpp
    test_lyrics.cpp
    test_agent_memory.cpp
    test_agent_txn.cpp
    test_annotations.cpp
    test_remote_companion.cpp
    test_multiplayer_logical_id.cpp
    test_multiplayer_lock_manager.cpp
    test_multiplayer_outbox.cpp
    test_multiplayer_transfer_queue.cpp
    test_training.cpp
    test_webbridge_resource_guard.cpp
    test_rt_guard.cpp
    test_generative_jobmanager.cpp
    test_rave_engine.cpp
    test_stem_export.cpp
    test_telemetry.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/Breadcrumbs.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/CrashReportFormatter.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/TelemetryConfig.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/Telemetry.cpp
    ${CMAKE_SOURCE_DIR}/src/telemetry/CrashHandler.cpp
    test_brain_proxy.cpp
    ${CMAKE_SOURCE_DIR}/src/brain/BrainProxy.cpp
    ${CMAKE_SOURCE_DIR}/src/generative/GenerativeJobManager.cpp
    ${CMAKE_SOURCE_DIR}/src/audio/RealtimeAudioGuard.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/LockManager.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/OutboundQueue.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/TransferQueue.cpp
    ${CMAKE_SOURCE_DIR}/src/remote/RemoteCompanionProtocol.cpp
    ${CMAKE_SOURCE_DIR}/src/remote/RemoteCompanionServer.cpp
    ${CMAKE_SOURCE_DIR}/src/training/TrainerRegistry.cpp
    ${CMAKE_SOURCE_DIR}/src/webview/UiResourcePathGuard.cpp
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
    MOSH_RT_GUARD=1)

target_link_libraries(MoshTests PRIVATE
    Catch2::Catch2WithMain
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_cryptography
    juce::juce_recommended_config_flags)

add_test(NAME MoshTests COMMAND $<TARGET_FILE:MoshTests>)
add_test(NAME AudioRecoverySmoke COMMAND $<TARGET_FILE:Mosh> --audio-recovery-smoke)
# test_training.cpp shells out to service/training relative to the CWD, so ctest
# must run the suite from the repo root.
set_tests_properties(MoshTests PROPERTIES
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
set_tests_properties(AudioRecoverySmoke PROPERTIES
    ENVIRONMENT "MOSH_AUDIO_OPEN_STALL_MS=60000;MOSH_AUDIO_OPEN_TIMEOUT_MS=250;MOSH_SELFTEST_SESSION=ctest-audio-recovery-smoke"
    TIMEOUT 10)
