juce_add_plugin(MoshTestTonePlugin
  COMPANY_NAME "Mosh"
  BUNDLE_ID "com.mosh.fixture.testtone"
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  NEEDS_MIDI_OUTPUT FALSE
  IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS FALSE
  COPY_PLUGIN_AFTER_BUILD TRUE
  VST3_COPY_DIR "${MOSH_PLUGIN_FIXTURE_VST3_COPY_DIR}"
  PLUGIN_MANUFACTURER_CODE Mosh
  PLUGIN_CODE Mtst
  FORMATS VST3
  PRODUCT_NAME "Mosh Test Tone"
)

target_sources(MoshTestTonePlugin PRIVATE
  MoshTestTonePlugin.cpp
)

target_compile_definitions(MoshTestTonePlugin
  PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(MoshTestTonePlugin
  PRIVATE
    juce::juce_audio_utils
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

set_target_properties(MoshTestTonePlugin PROPERTIES FOLDER "mosh/fixtures")
