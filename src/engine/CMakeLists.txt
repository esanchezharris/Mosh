# ── mosh_engine — the Tracktion-bound engine layer (Stage 1) ───────────────────
# Wraps the Engine/Edit lifecycle, walks the Edit into the snapshot schema, and
# registers the Tracktion-bound MoshOps command handlers. Links the spine (for the
# command/event/result types) + Tracktion + the JUCE audio modules.

add_library(mosh_engine STATIC
    MoshEngine.cpp
    EngineSnapshot.cpp
    EngineHandlers.cpp
    GenerativeEngine.cpp
    MoshEngine.h
    EngineSnapshot.h
    EngineHandlers.h
    GenerativeEngine.h
)

target_include_directories(mosh_engine PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(mosh_engine PUBLIC cxx_std_20)

target_link_libraries(mosh_engine
    PUBLIC
        mosh_spine
        tracktion::tracktion_engine
        tracktion::tracktion_core
        tracktion::tracktion_graph
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_audio_processors
        juce::juce_audio_utils
    PRIVATE
        $<TARGET_NAME_IF_EXISTS:juce::juce_recommended_config_flags>
)

set_target_properties(mosh_engine PROPERTIES FOLDER "mosh")

# ── Stage 1 integration smoke test (Tracktion-linked; app builds only) ─────────
# The real command path over Tracktion (no WebView). Separate from mosh_tests so the
# spine suite stays OS-agnostic / Tracktion-free.
if(MOSH_BUILD_TESTS AND TARGET Catch2::Catch2WithMain)
    add_executable(mosh_engine_tests
        "${CMAKE_SOURCE_DIR}/tests/test_engine_smoke.cpp"
        "${CMAKE_SOURCE_DIR}/tests/test_generative_engine.cpp")
    target_link_libraries(mosh_engine_tests PRIVATE mosh_engine juce::juce_gui_basics Catch2::Catch2WithMain)
    target_compile_features(mosh_engine_tests PRIVATE cxx_std_20)
    target_compile_definitions(mosh_engine_tests PRIVATE MOSH_SERVICE_DIR="${CMAKE_SOURCE_DIR}/service")
    set_target_properties(mosh_engine_tests PROPERTIES FOLDER "mosh")

    list(APPEND CMAKE_MODULE_PATH "${Catch2_SOURCE_DIR}/extras")
    include(Catch)
    catch_discover_tests(mosh_engine_tests)
endif()
