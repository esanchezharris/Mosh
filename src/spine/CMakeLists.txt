# ── mosh_spine — the Tracktion-free, unit-testable command/state spine ─────────
# Pure logic over JUCE's data modules only (no audio, no Tracktion). This is the
# load-bearing contract (MoshOps + state feed + RenderLayer + ASTD + fingerprint)
# and it builds/tests on any OS — the highest-leverage early verification.

add_library(mosh_spine STATIC
    DslExecutor.cpp
    GenerativeJobManager.cpp
    GenerativeCommands.cpp
    AsyncRenderPool.cpp
    # header-only units (listed for IDE/registration):
    AsyncRenderPool.h
    Ids.h
    MoshResult.h
    MoshCommand.h
    MoshEvent.h
    JsonlLog.h
    SnapshotSource.h
    DslExecutor.h
    Astd.h
    Fingerprint.h
    RenderLayer.h
    ClipMath.h
    Generative.h
    GenerativeJobManager.h
    GenerativeCommands.h
)

target_include_directories(mosh_spine PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_features(mosh_spine PUBLIC cxx_std_20)

target_link_libraries(mosh_spine
    PUBLIC
        juce::juce_core
        juce::juce_data_structures
        juce::juce_events
    PRIVATE
        $<TARGET_NAME_IF_EXISTS:juce::juce_recommended_config_flags>
        $<TARGET_NAME_IF_EXISTS:juce::juce_recommended_warning_flags>
)

# Keep the spine's OWN juce_core compile lean & cross-platform-clean (no web
# browser / curl). These are PRIVATE so they do NOT leak through the link into the
# app target — the app needs JUCE_WEB_BROWSER=1 for WebBrowserComponent.
target_compile_definitions(mosh_spine PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_STANDALONE_APPLICATION=1
    JUCE_MODAL_LOOPS_PERMITTED=0
)

set_target_properties(mosh_spine PROPERTIES FOLDER "mosh")
