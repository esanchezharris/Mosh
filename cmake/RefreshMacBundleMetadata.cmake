# RefreshMacBundleMetadata.cmake - final macOS bundle metadata pass.
#
# The generated app is modified by several post-build/restage steps: JUCE writes the
# base bundle, repo scripts inject Info.plist privacy keys, and Vite outputs are
# copied into Resources. TCC reads usage descriptions from the signed bundle
# metadata, so the final local bundle must be signed after those mutations.

if (NOT BUNDLE)
    message(FATAL_ERROR "RefreshMacBundleMetadata: -DBUNDLE=<Mosh.app> is required")
endif()
if (NOT PLIST)
    message(FATAL_ERROR "RefreshMacBundleMetadata: -DPLIST=<Mosh.app/Contents/Info.plist> is required")
endif()
if (NOT EXISTS "${BUNDLE}")
    message(FATAL_ERROR "RefreshMacBundleMetadata: bundle not found at '${BUNDLE}'")
endif()
if (NOT EXISTS "${PLIST}")
    message(FATAL_ERROR "RefreshMacBundleMetadata: Info.plist not found at '${PLIST}'")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/InjectInfoPlistKeys.cmake")

file(GLOB_RECURSE _ds_store_files "${BUNDLE}/.DS_Store" "${BUNDLE}/*/.DS_Store")
if (_ds_store_files)
    file(REMOVE ${_ds_store_files})
endif()

find_program(_ditto ditto)
if (NOT _ditto)
    message(FATAL_ERROR "RefreshMacBundleMetadata: ditto is required")
endif()

set(_tmp_parent "$ENV{TMPDIR}")
if (NOT _tmp_parent)
    set(_tmp_parent "/tmp")
endif()
string(RANDOM LENGTH 8 ALPHABET "0123456789abcdef" _tmp_token)
set(_signing_bundle "${_tmp_parent}/MoshRefreshBundleMetadata-${_tmp_token}.app")
set(_restore_bundle "${BUNDLE}.restore-${_tmp_token}")
file(REMOVE_RECURSE "${_signing_bundle}")
file(REMOVE_RECURSE "${_restore_bundle}")

execute_process(COMMAND "${_ditto}" --norsrc --noextattr "${BUNDLE}" "${_signing_bundle}"
                RESULT_VARIABLE _copy_to_tmp_result
                OUTPUT_VARIABLE _copy_to_tmp_out
                ERROR_VARIABLE _copy_to_tmp_err)
if (_copy_to_tmp_result)
    message(FATAL_ERROR
        "RefreshMacBundleMetadata: clean bundle copy failed for '${BUNDLE}'\n"
        "${_copy_to_tmp_out}${_copy_to_tmp_err}")
endif()

execute_process(COMMAND /usr/bin/codesign --force --deep --sign - "${_signing_bundle}"
                RESULT_VARIABLE _sign_result
                OUTPUT_VARIABLE _sign_out
                ERROR_VARIABLE _sign_err)
if (_sign_result)
    file(REMOVE_RECURSE "${_signing_bundle}")
    message(FATAL_ERROR
        "RefreshMacBundleMetadata: ad-hoc codesign failed for '${_signing_bundle}'\n"
        "${_sign_out}${_sign_err}")
endif()

execute_process(COMMAND /usr/bin/codesign --verify --deep --strict --verbose=2 "${_signing_bundle}"
                RESULT_VARIABLE _tmp_verify_result
                OUTPUT_VARIABLE _tmp_verify_out
                ERROR_VARIABLE _tmp_verify_err)
if (_tmp_verify_result)
    file(REMOVE_RECURSE "${_signing_bundle}")
    message(FATAL_ERROR
        "RefreshMacBundleMetadata: strict codesign verify failed for '${_signing_bundle}'\n"
        "${_tmp_verify_out}${_tmp_verify_err}")
endif()

execute_process(COMMAND "${_ditto}" --norsrc --noextattr "${_signing_bundle}" "${_restore_bundle}"
                RESULT_VARIABLE _copy_back_result
                OUTPUT_VARIABLE _copy_back_out
                ERROR_VARIABLE _copy_back_err)
file(REMOVE_RECURSE "${_signing_bundle}")
if (_copy_back_result)
    file(REMOVE_RECURSE "${_restore_bundle}")
    message(FATAL_ERROR
        "RefreshMacBundleMetadata: signed bundle restore failed for '${BUNDLE}'\n"
        "${_copy_back_out}${_copy_back_err}")
endif()
file(REMOVE_RECURSE "${BUNDLE}")
file(RENAME "${_restore_bundle}" "${BUNDLE}")

execute_process(COMMAND /usr/bin/codesign --verify --deep --strict --verbose=2 "${BUNDLE}"
                RESULT_VARIABLE _verify_result
                OUTPUT_VARIABLE _verify_out
                ERROR_VARIABLE _verify_err)
if (_verify_result)
    message(FATAL_ERROR
        "RefreshMacBundleMetadata: strict codesign verify failed for '${BUNDLE}'\n"
        "${_verify_out}${_verify_err}")
endif()
