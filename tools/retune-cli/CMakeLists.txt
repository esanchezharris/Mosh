# MoshRetuneCli — renders a WAV through Mosh AutoTune's engine so the owner can
# judge it by ear outside the app (docs/AUTOTUNE-SCOPE-2026-10-01.md §10).
# Off by default; enable with -DMOSH_BUILD_RETUNE_CLI=ON.

juce_add_console_app(MoshRetuneCli PRODUCT_NAME "MoshRetuneCli")

target_sources(MoshRetuneCli PRIVATE
    main.cpp
    ${CMAKE_SOURCE_DIR}/src/plugins/moshfx/retune/RetuneCore.cpp)

target_include_directories(MoshRetuneCli PRIVATE ${CMAKE_SOURCE_DIR}/src)

target_compile_definitions(MoshRetuneCli PRIVATE
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_STANDALONE_APPLICATION=1)

target_link_libraries(MoshRetuneCli PRIVATE
    juce::juce_audio_formats
    juce::juce_recommended_config_flags)
