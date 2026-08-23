find_library(APPKIT_FRAMEWORK AppKit REQUIRED)
find_library(FOUNDATION_FRAMEWORK Foundation REQUIRED)
find_library(COREIMAGE_FRAMEWORK CoreImage REQUIRED)
find_library(SECURITY_FRAMEWORK Security REQUIRED)

set(DAWN_CORE_SOURCES
    Protocol.mm
    ProtocolJson.mm
    Resources.mm
    SocketSupport.mm
    ScriptServer.mm
    HttpServer.mm)

add_library(MoshDawnBridgeCore STATIC ${DAWN_CORE_SOURCES})
target_include_directories(MoshDawnBridgeCore PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_compile_options(MoshDawnBridgeCore PRIVATE -fobjc-arc)
target_link_libraries(MoshDawnBridgeCore PUBLIC
    ${FOUNDATION_FRAMEWORK}
    ${SECURITY_FRAMEWORK})

add_executable(MoshDawnBridge MACOSX_BUNDLE
    main.mm
    AppDelegate.mm)
set_target_properties(MoshDawnBridge PROPERTIES
    OUTPUT_NAME "MoshDawnBridge"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist")
target_compile_options(MoshDawnBridge PRIVATE -fobjc-arc)
target_link_libraries(MoshDawnBridge PRIVATE
    MoshDawnBridgeCore
    ${APPKIT_FRAMEWORK}
    ${COREIMAGE_FRAMEWORK})

find_program(DAWN_NPM_EXECUTABLE npm REQUIRED)
file(GLOB_RECURSE DAWN_COMPANION_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/ui/src/companion/*.ts"
    "${CMAKE_SOURCE_DIR}/ui/src/companion/*.css"
    "${CMAKE_SOURCE_DIR}/ui/src/companion/*.html")
set(DAWN_COMPANION_HTML "${CMAKE_SOURCE_DIR}/ui/companion-dist/index.html")
add_custom_command(
    OUTPUT "${DAWN_COMPANION_HTML}"
    COMMAND "${DAWN_NPM_EXECUTABLE}" install --no-audit --no-fund
    COMMAND "${DAWN_NPM_EXECUTABLE}" run build:companion
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}/ui"
    DEPENDS "${CMAKE_SOURCE_DIR}/ui/package.json"
            "${CMAKE_SOURCE_DIR}/ui/package-lock.json"
            "${CMAKE_SOURCE_DIR}/ui/vite.companion.config.ts"
            ${DAWN_COMPANION_SOURCES}
    COMMENT "Building the DAWN companion page"
    VERBATIM)
add_custom_target(MoshDawnCompanionUI DEPENDS "${DAWN_COMPANION_HTML}")
add_dependencies(MoshDawnBridge MoshDawnCompanionUI)
add_custom_command(TARGET MoshDawnBridge POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -rf
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/companion"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_SOURCE_DIR}/ui/companion-dist"
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/companion"
    COMMAND ${CMAKE_COMMAND} -E rm -rf
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/MoshDawnController"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_SOURCE_DIR}/resources/ableton/MoshDawnController"
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/MoshDawnController"
    COMMENT "Staging DAWN companion and Remote Script resources"
    VERBATIM)
add_custom_target(MoshDawnBridgeResources
    COMMAND ${CMAKE_COMMAND} -E rm -rf
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/companion"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_SOURCE_DIR}/ui/companion-dist"
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/companion"
    COMMAND ${CMAKE_COMMAND} -E rm -rf
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/MoshDawnController"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_SOURCE_DIR}/resources/ableton/MoshDawnController"
            "$<TARGET_BUNDLE_DIR:MoshDawnBridge>/Contents/Resources/MoshDawnController"
    COMMENT "Refreshing DAWN app resources"
    VERBATIM)
add_dependencies(MoshDawnBridgeResources MoshDawnBridge MoshDawnCompanionUI)

if (MOSH_BUILD_TESTS)
    add_executable(MoshDawnBridgeTests
        tests/test_protocol.mm
        tests/test_result_correlation.mm
        tests/test_resources.mm
        tests/test_servers.mm)
    target_compile_options(MoshDawnBridgeTests PRIVATE -fobjc-arc)
    target_link_libraries(MoshDawnBridgeTests PRIVATE
        MoshDawnBridgeCore
        Catch2::Catch2WithMain)
    add_test(NAME MoshDawnBridgeTests COMMAND MoshDawnBridgeTests)
    add_test(NAME MoshDawnBridgeRunScriptSafety
        COMMAND bash "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_run_script.sh"
                     "${CMAKE_SOURCE_DIR}/scripts/build-and-run-dawn-bridge.sh")
endif()
