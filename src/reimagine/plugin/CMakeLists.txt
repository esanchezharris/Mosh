juce_add_plugin(MoshReImaginePlugin
  COMPANY_NAME "Mosh"
  BUNDLE_ID "studio.mosh.reimagine"
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  NEEDS_MIDI_OUTPUT FALSE
  IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS TRUE
  COPY_PLUGIN_AFTER_BUILD FALSE
  PLUGIN_MANUFACTURER_CODE Mosh
  PLUGIN_CODE Mrim
  FORMATS VST3
  PRODUCT_NAME "Mosh Re-Imagine"
)

target_sources(MoshReImaginePlugin PRIVATE
  ReImagineProcessor.cpp
  ReImagineProcessor.h
  ReImagineEditor.cpp
  ReImagineEditor.h
  ../ReImagineCore.cpp
  ../ReImagineCore.h
  ../ReImagineService.cpp
  ../ReImagineService.h
)

target_include_directories(MoshReImaginePlugin PRIVATE ${CMAKE_SOURCE_DIR}/src)

target_compile_definitions(MoshReImaginePlugin PUBLIC
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(MoshReImaginePlugin
  PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_formats
    juce::juce_cryptography
    juce::juce_dsp
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags
)

set_target_properties(MoshReImaginePlugin PROPERTIES FOLDER "mosh/plugins")

juce_add_console_app(MoshReImagineBundleSmoke PRODUCT_NAME "Mosh Re-Imagine Bundle Smoke")
target_sources(MoshReImagineBundleSmoke PRIVATE ReImagineBundleSmoke.cpp)
target_compile_definitions(MoshReImagineBundleSmoke PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
)
target_link_libraries(MoshReImagineBundleSmoke PRIVATE
  juce::juce_audio_utils
  juce::juce_recommended_config_flags
)
add_dependencies(MoshReImagineBundleSmoke MoshReImaginePlugin_VST3)
add_test(NAME MoshReImagineBundleSmoke
  COMMAND MoshReImagineBundleSmoke
    "$<TARGET_BUNDLE_DIR:MoshReImaginePlugin_VST3>")
set_tests_properties(MoshReImagineBundleSmoke PROPERTIES TIMEOUT 30)
