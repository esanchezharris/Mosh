# Portable, idempotent application of the Tracktion createNewItemID engine patch.
#
# Invoked as a FetchContent PATCH_COMMAND:
#   cmake -DPATCH=<abs path to .patch> -P apply-tracktion-patch.cmake
# CMake's working directory here is the tracktion_engine SOURCE_DIR (a git clone),
# so a plain `git apply` resolves the patch's a/ b/ paths against the engine tree.
#
# Replaces the previous `bash -c "git apply ..."`: on Windows `bash` resolves to
# WSL, which cannot open a C:/-style patch path (it expects /mnt/c/...), so the
# patch step failed with a bogus "No such file or directory". Native git driven by
# `cmake -P` behaves identically on macOS and Windows and needs no shell.

if(NOT DEFINED PATCH)
    message(FATAL_ERROR "apply-tracktion-patch.cmake: -DPATCH=<file> is required")
endif()

find_package(Git REQUIRED)

# Already applied? `git apply -R --check` succeeds only when the patch reverse-applies
# cleanly, i.e. it is currently present in the tree. This keeps the patch step
# idempotent across re-configures (FetchContent caches the source dir between runs).
execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply -R --check "${PATCH}"
    RESULT_VARIABLE reverse_ok
    OUTPUT_QUIET ERROR_QUIET)
if(reverse_ok EQUAL 0)
    message(STATUS "tracktion createNewItemID patch already applied - skipping")
    return()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply "${PATCH}"
    RESULT_VARIABLE apply_res
    OUTPUT_VARIABLE apply_out
    ERROR_VARIABLE apply_err)
if(NOT apply_res EQUAL 0)
    message(FATAL_ERROR
        "Failed to apply tracktion patch:\n  ${PATCH}\n${apply_out}${apply_err}")
endif()
message(STATUS "Applied tracktion createNewItemID patch")
