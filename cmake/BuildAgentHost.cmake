# Build and stage the Owner Cockpit's Node Agent Host as one deterministic ESM
# artifact. Node itself remains an owner-installed runtime; the app bundle carries
# all host application code and JS dependencies so a Finder/deployed launch cannot
# accidentally fall back to a developer checkout.

find_program(NPM_EXECUTABLE npm)
set(MOSH_AGENT_HOST_DIR "${CMAKE_SOURCE_DIR}/service/agent-host")
set(MOSH_AGENT_HOST_BUNDLE "${MOSH_AGENT_HOST_DIR}/dist/agent-host.mjs")

if (NOT EXISTS "${MOSH_AGENT_HOST_DIR}/package.json" OR NOT EXISTS "${MOSH_AGENT_HOST_DIR}/package-lock.json")
    message(FATAL_ERROR "Agent Host source or lockfile missing; refusing to build an app without its required supervisor runtime")
endif()
if (NOT NPM_EXECUTABLE)
    message(FATAL_ERROR "npm is required to bundle the packaged Agent Host runtime")
endif()

file(GLOB_RECURSE MOSH_AGENT_HOST_SOURCES CONFIGURE_DEPENDS
     "${MOSH_AGENT_HOST_DIR}/src/*.ts"
     "${MOSH_AGENT_HOST_DIR}/scripts/*.mjs")

add_custom_command(
    OUTPUT "${MOSH_AGENT_HOST_BUNDLE}"
    COMMAND ${NPM_EXECUTABLE} ci --no-audit --no-fund
    COMMAND ${NPM_EXECUTABLE} run bundle
    WORKING_DIRECTORY "${MOSH_AGENT_HOST_DIR}"
    DEPENDS "${MOSH_AGENT_HOST_DIR}/package.json"
            "${MOSH_AGENT_HOST_DIR}/package-lock.json"
            ${MOSH_AGENT_HOST_SOURCES}
    COMMENT "Bundling packaged Agent Host → dist/agent-host.mjs"
    VERBATIM)

add_custom_target(MoshAgentHostBundle DEPENDS "${MOSH_AGENT_HOST_BUNDLE}")
add_dependencies(Mosh MoshAgentHostBundle)

if (APPLE)
    set(MOSH_AGENT_HOST_STAGE_DIR "$<TARGET_BUNDLE_CONTENT_DIR:Mosh>/Resources/agent-host")
else()
    set(MOSH_AGENT_HOST_STAGE_DIR "$<TARGET_FILE_DIR:Mosh>/agent-host")
endif()

# Direct `cmake --build --target Mosh` must stage the host too. The ALL target
# handles a host-only rebuild when relinking Mosh is unnecessary.
add_custom_command(TARGET Mosh POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${MOSH_AGENT_HOST_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MOSH_AGENT_HOST_BUNDLE}" "${MOSH_AGENT_HOST_STAGE_DIR}/agent-host.mjs"
    COMMENT "Staging packaged Agent Host → ${MOSH_AGENT_HOST_STAGE_DIR}"
    VERBATIM)

add_custom_target(MoshStageAgentHost ALL
    COMMAND ${CMAKE_COMMAND} -E make_directory "${MOSH_AGENT_HOST_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MOSH_AGENT_HOST_BUNDLE}" "${MOSH_AGENT_HOST_STAGE_DIR}/agent-host.mjs"
    COMMENT "Restaging packaged Agent Host into the app"
    VERBATIM)
add_dependencies(MoshStageAgentHost Mosh MoshAgentHostBundle)
