# Build the minimal native process handoff helper used by owner-only repair swaps.
# It is staged as nested code so local bundle refresh signs it ad hoc and the
# release signer seals it inside-out with the same Developer ID team as Mosh.

if (NOT APPLE)
    return()
endif()

add_executable(MoshRepairHelper
    "${CMAKE_SOURCE_DIR}/service/repair-helper/MoshRepairHelper.cpp")
target_compile_features(MoshRepairHelper PRIVATE cxx_std_20)
target_link_libraries(MoshRepairHelper PRIVATE
    "-framework CoreFoundation"
    "-framework Security")

set(MOSH_REPAIR_HELPER_STAGE_DIR
    "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Helpers")
add_custom_command(TARGET MoshRepairHelper POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${MOSH_REPAIR_HELPER_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:MoshRepairHelper>"
            "${MOSH_REPAIR_HELPER_STAGE_DIR}/MoshRepairHelper"
    COMMENT "Staging signed repair handoff helper into Mosh.app"
    VERBATIM)

add_custom_target(MoshStageRepairHelper ALL
    COMMAND ${CMAKE_COMMAND} -E make_directory "${MOSH_REPAIR_HELPER_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:MoshRepairHelper>"
            "${MOSH_REPAIR_HELPER_STAGE_DIR}/MoshRepairHelper"
    COMMENT "Restaging repair handoff helper into Mosh.app"
    VERBATIM)
add_dependencies(MoshStageRepairHelper Mosh MoshRepairHelper)
