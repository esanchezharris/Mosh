# Catch2 tests + the MoshOps spine units (06 §4).
# A JUCE console app so tests can use juce::ValueTree / SHA256 (the RenderLayer
# round-trip + full-fingerprint cache key). The live command-surface harness
# (driving a real engine) is exercised through the running app at the gate; these
# units cover the pure, engine-free logic.

juce_add_console_app(MoshTests PRODUCT_NAME "MoshTests")

target_sources(MoshTests PRIVATE
    test_sanity.cpp
    test_renderlayer.cpp
    test_astd.cpp
    test_remote_companion.cpp
    test_multiplayer_logical_id.cpp
    test_multiplayer_lock_manager.cpp
    test_training.cpp
    ${CMAKE_SOURCE_DIR}/src/multiplayer/LockManager.cpp
    ${CMAKE_SOURCE_DIR}/src/remote/RemoteCompanionProtocol.cpp
    ${CMAKE_SOURCE_DIR}/src/remote/RemoteCompanionServer.cpp
    ${CMAKE_SOURCE_DIR}/src/training/TrainerRegistry.cpp)

target_include_directories(MoshTests PRIVATE ${CMAKE_SOURCE_DIR}/src)

target_compile_definitions(MoshTests PRIVATE
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_STANDALONE_APPLICATION=1
    MOSH_TESTING=1)

target_link_libraries(MoshTests PRIVATE
    Catch2::Catch2WithMain
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_cryptography
    juce::juce_recommended_config_flags)

add_test(NAME MoshTests COMMAND $<TARGET_FILE:MoshTests>)
# test_training.cpp shells out to service/training relative to the CWD, so ctest
# must run the suite from the repo root.
set_tests_properties(MoshTests PROPERTIES
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
