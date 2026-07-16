# Shared npm dependency step for the main Vite UI and phone companion page.
#
# Both bundles live under ui/ and used to run `npm install` independently. When
# CMake built them in parallel, the two installs could race inside node_modules.
# This target serializes dependency installation behind one stamp file.

if (NOT DEFINED MOSH_UI_DIR)
    set(MOSH_UI_DIR "${CMAKE_SOURCE_DIR}/ui")
endif()

if (NOT NPM_EXECUTABLE)
    find_program(NPM_EXECUTABLE npm)
endif()

set(MOSH_UI_NPM_STAMP "${MOSH_UI_DIR}/node_modules/.mosh-cmake-npm-install.stamp")

if (NPM_EXECUTABLE AND NOT TARGET MoshUIDeps)
    add_custom_command(
        OUTPUT  "${MOSH_UI_NPM_STAMP}"
        COMMAND ${NPM_EXECUTABLE} install --no-audit --no-fund
        COMMAND ${CMAKE_COMMAND} -E touch "${MOSH_UI_NPM_STAMP}"
        WORKING_DIRECTORY "${MOSH_UI_DIR}"
        DEPENDS "${MOSH_UI_DIR}/package.json"
                "${MOSH_UI_DIR}/package-lock.json"
        COMMENT "Installing Mosh UI npm dependencies"
        VERBATIM)

    add_custom_target(MoshUIDeps DEPENDS "${MOSH_UI_NPM_STAMP}")
endif()
