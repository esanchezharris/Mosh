# ── Mosh — the standalone JUCE 8 GUI app target ────────────────────────────────
# Stage 0: a window hosting a JUCE 8 WebView that loads the bundled React/Vite UI.
# Tracktion Engine + the engine/MoshOps bootstrap are wired in Stage 1 (kept out of
# Stage 0 so the skeleton builds fast and its gate stays "window + placeholder").
#
# NOTE: heavy deps (Tracktion, anira/RTNeural/chowdsp for Tier-A) are CPM-added in
# the stages that introduce them, not here, to keep each stage's build lean.

juce_add_gui_app(Mosh
    PRODUCT_NAME "Mosh"
    COMPANY_NAME "Mosh"
    BUNDLE_ID "com.mosh.app"
    NEEDS_WEB_BROWSER TRUE
    # macOS: WKWebView is the native backend; Windows: WebView2 (auto-fetched).
)

target_sources(Mosh PRIVATE
    Main.cpp
    MainWindow.cpp
    WebViewHost.cpp
)

target_compile_features(Mosh PRIVATE cxx_std_20)

target_link_libraries(Mosh PRIVATE
    mosh_spine
    juce::juce_gui_extra        # WebBrowserComponent lives here
    juce::juce_gui_basics
    juce::juce_events
    juce::juce_core
    juce::juce_data_structures
    $<TARGET_NAME_IF_EXISTS:juce::juce_recommended_config_flags>
    $<TARGET_NAME_IF_EXISTS:juce::juce_recommended_warning_flags>
)

target_compile_definitions(Mosh PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2=1      # Windows backend
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Mosh,PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="${PROJECT_VERSION}"
    # Where the WebView looks for the staged UI bundle, relative to the executable.
    MOSH_UI_STAGE_DIRNAME="ui"
)

set_target_properties(Mosh PROPERTIES FOLDER "mosh")

# ── Frontend (Vite) build + staging ────────────────────────────────────────────
# Build ui/ → ui/dist, then copy the bundle next to the executable so the WebView
# resource provider can serve it. The swappability gate (Stage 2) rebuilds this
# bundle with ZERO backend change — so the bundle is a pure build artifact here.
if(MOSH_BUILD_UI)
    find_program(MOSH_NPM npm npm.cmd REQUIRED)
    set(MOSH_UI_DIR  "${CMAKE_SOURCE_DIR}/ui")
    set(MOSH_UI_DIST "${MOSH_UI_DIR}/dist")

    add_custom_command(
        OUTPUT "${MOSH_UI_DIST}/index.html"
        COMMAND ${MOSH_NPM} install --no-audit --no-fund
        COMMAND ${MOSH_NPM} run build
        WORKING_DIRECTORY "${MOSH_UI_DIR}"
        COMMENT "Mosh: building the React/Vite UI bundle"
        VERBATIM
    )
    add_custom_target(mosh_ui DEPENDS "${MOSH_UI_DIST}/index.html")
    add_dependencies(Mosh mosh_ui)

    # Stage the built bundle next to the app executable (→ <exe dir>/ui).
    add_custom_command(TARGET Mosh POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${MOSH_UI_DIST}" "$<TARGET_FILE_DIR:Mosh>/ui"
        COMMENT "Mosh: staging UI bundle next to the executable"
        VERBATIM
    )
endif()
