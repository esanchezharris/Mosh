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

if(DEFINED PATCH_MANIFEST)
    if(NOT EXISTS "${PATCH_MANIFEST}")
        message(FATAL_ERROR "apply-tracktion-patch.cmake: PATCH_MANIFEST does not exist: ${PATCH_MANIFEST}")
    endif()
    file(STRINGS "${PATCH_MANIFEST}" patches)
elseif(DEFINED PATCHES)
    set(patches ${PATCHES})
elseif(DEFINED PATCH)
    set(patches ${PATCH})
else()
    message(FATAL_ERROR "apply-tracktion-patch.cmake: -DPATCH_MANIFEST=<file> or -DPATCHES=<files> is required")
endif()

find_package(Git REQUIRED)

# Patches are an ordered, append-only stack. Later patches may intentionally edit lines
# introduced by earlier ones, so an earlier patch may no longer reverse-apply after the
# whole stack lands. Search newest-to-oldest: the newest reverse-applicable patch proves
# that it and every preceding patch form an already-applied prefix. Apply only the tail.
# This handles fresh sources, caches carrying an older prefix, and repeated configures.
set(patches_to_apply ${patches})
set(reverse_patches ${patches})
list(REVERSE reverse_patches)
set(applied_prefix_end -1)
foreach(candidate IN LISTS reverse_patches)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply --unidiff-zero -R --check "${candidate}"
        RESULT_VARIABLE reverse_ok
        OUTPUT_QUIET ERROR_QUIET)
    if(reverse_ok EQUAL 0)
        list(FIND patches "${candidate}" applied_prefix_end)
        break()
    endif()
endforeach()

if(applied_prefix_end GREATER_EQUAL 0)
    math(EXPR first_unapplied "${applied_prefix_end} + 1")
    list(LENGTH patches patch_count)
    if(first_unapplied LESS patch_count)
        list(SUBLIST patches ${first_unapplied} -1 patches_to_apply)
    else()
        set(patches_to_apply "")
    endif()
    list(GET patches ${applied_prefix_end} newest_applied_patch)
    message(STATUS "Mosh dependency patch prefix already applied through: ${newest_applied_patch}")
endif()

foreach(patch IN LISTS patches_to_apply)
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
