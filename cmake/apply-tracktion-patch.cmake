# Portable, idempotent application of Mosh's pinned Tracktion/JUCE patches.
#
# Invoked as a FetchContent PATCH_COMMAND:
#   cmake "-DPATCHES=<abs path 1>;<abs path 2>" -P apply-tracktion-patch.cmake
# CMake's working directory here is the tracktion_engine SOURCE_DIR (a git clone),
# so a plain `git apply` resolves the patch's a/ b/ paths against the engine tree.
#
# Replaces the previous `bash -c "git apply ..."`: on Windows `bash` resolves to
# WSL, which cannot open a C:/-style patch path (it expects /mnt/c/...), so the
# patch step failed with a bogus "No such file or directory". Native git driven by
# `cmake -P` behaves identically on macOS and Windows and needs no shell.
# `--unidiff-zero` keeps one-line dependency patches possible without embedding
# whitespace-only context lines that make `git diff --check` fail in this repo.

if(DEFINED PATCHES)
    set(patches ${PATCHES})
elseif(DEFINED PATCH)
    set(patches ${PATCH})
else()
    message(FATAL_ERROR "apply-tracktion-patch.cmake: -DPATCHES=<files> is required")
endif()

find_package(Git REQUIRED)

foreach(patch IN LISTS patches)
    # Already applied? `git apply -R --check` succeeds only when the patch reverse-applies
    # cleanly, i.e. it is currently present in the tree. This keeps the patch step
    # idempotent across re-configures (FetchContent caches the source dir between runs).
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --unidiff-zero -R --check "${patch}"
        RESULT_VARIABLE reverse_ok
        OUTPUT_QUIET ERROR_QUIET)
    if(reverse_ok EQUAL 0)
        message(STATUS "Mosh dependency patch already applied - skipping: ${patch}")
        continue()
    endif()

    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --unidiff-zero "${patch}"
        RESULT_VARIABLE apply_res
        OUTPUT_VARIABLE apply_out
        ERROR_VARIABLE apply_err)
    if(NOT apply_res EQUAL 0)
        message(FATAL_ERROR
            "Failed to apply Mosh dependency patch:\n  ${patch}\n${apply_out}${apply_err}")
    endif()
    message(STATUS "Applied Mosh dependency patch: ${patch}")
endforeach()
