#include <catch2/catch_test_macros.hpp>

// Stage 0 toolchain sanity. The real spine tests (command-surface harness,
// RenderLayer/cache-fingerprint round-trip, ASTD mapping) arrive in Stage 1+.
TEST_CASE ("toolchain sanity", "[stage0]")
{
    REQUIRE (1 + 1 == 2);
    REQUIRE (sizeof (void*) == 8);   // arm64
}
