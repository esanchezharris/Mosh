#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include "plugins/neural/Astd.h"

using namespace mosh::astd;
using Catch::Matchers::WithinAbs;

TEST_CASE ("ASTD clamps a 0–100 knob below quality-collapse (04 §6)", "[stage4][astd]")
{
    Range r { 1.0f, 25.0f, 12.0f };   // rawMin, rawMax, safeMax(collapse)

    SECTION ("normal mode: UI 100 stops at the safe clamp, never the raw max")
    {
        REQUIRE_THAT (r.toRaw (100.0f, false), WithinAbs (12.0f, 1e-4));
        REQUIRE_THAT (r.toRaw (0.0f,   false), WithinAbs (1.0f,  1e-4));
        REQUIRE_THAT (r.toRaw (50.0f,  false), WithinAbs (6.5f,  1e-4));   // 1 + .5*(12-1)
        REQUIRE (r.clampedRawMax() == 12.0f);
    }
    SECTION ("Lab mode unlocks the full raw range beyond the clamp")
    {
        REQUIRE_THAT (r.toRaw (100.0f, true), WithinAbs (25.0f, 1e-4));
        REQUIRE (r.toRaw (100.0f, true) > r.toRaw (100.0f, false));        // strictly hotter
    }
    SECTION ("round-trips UI<->raw against the active top")
    {
        REQUIRE_THAT (r.toUi (12.0f, false), WithinAbs (100.0f, 1e-3));
        REQUIRE_THAT (r.toUi (6.5f,  false), WithinAbs (50.0f,  1e-3));
        REQUIRE_THAT (r.toUi (25.0f, true),  WithinAbs (100.0f, 1e-3));
    }
}

TEST_CASE ("ASTD registry keys by (model,param) with identity fallback", "[stage4][astd]")
{
    Registry reg;
    reg.set ("nam", "drive", { 1.0f, 25.0f, 12.0f });
    REQUIRE (reg.has ("nam", "drive"));
    REQUIRE_FALSE (reg.has ("rave", "drive"));
    REQUIRE (reg.get ("nam", "drive").safeMax == 12.0f);

    // Unknown → identity 0..1 (safe == full), so no clamping surprises.
    auto fallback = reg.get ("unknown", "x");
    REQUIRE (fallback.rawMin == 0.0f);
    REQUIRE (fallback.rawMax == 1.0f);
    REQUIRE (fallback.safeMax == 1.0f);
}
