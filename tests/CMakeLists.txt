# ── mosh_tests — Catch2 units + the command-surface harness (06 §4) ────────────
# Links only mosh_spine (Tracktion-free), so it builds & runs on any OS — the
# real, runnable verification of the spine contract.

add_executable(mosh_tests
    test_result_envelope.cpp
    test_astd.cpp
    test_fingerprint.cpp
    test_renderlayer.cpp
    test_events.cpp
    test_clipmath.cpp
    test_command_surface.cpp
)

target_link_libraries(mosh_tests PRIVATE mosh_spine Catch2::Catch2WithMain)
target_compile_features(mosh_tests PRIVATE cxx_std_20)
set_target_properties(mosh_tests PROPERTIES FOLDER "mosh")

# Register individual Catch2 cases with CTest.
list(APPEND CMAKE_MODULE_PATH "${Catch2_SOURCE_DIR}/extras")
include(Catch)
catch_discover_tests(mosh_tests)
