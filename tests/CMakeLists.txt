# Catch2 test target + the MoshOps command-surface harness (06 §4).
# Stage 0: a sanity test proving the toolchain links Catch2.
# Stage 1+: the command-surface harness (drive MoshOps, assert results / events /
# JSONL / snapshot) is the key test and is added here.

add_executable(MoshTests
    test_sanity.cpp)

target_include_directories(MoshTests PRIVATE ${CMAKE_SOURCE_DIR}/src)

# Catch2WithMain supplies main(); no custom entry point needed.
target_link_libraries(MoshTests PRIVATE Catch2::Catch2WithMain)
target_compile_features(MoshTests PRIVATE cxx_std_20)

add_test(NAME MoshTests COMMAND MoshTests)
