#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "Astd.h"

using namespace mosh;
using Catch::Approx;

// ASTD: 0–100 UI maps onto a CLAMPED safe sub-range by default; Lab mode unlocks
// the full raw range (04 §6 / 05 §6). One shared impl, both tiers.
TEST_CASE ("ASTD clamps the default UI range below quality-collapse", "[astd]")
{
    // Full model range 0..10, but production collapses above 6 → safe ceiling 6.
    AstdParam p { "drive", 0.0, 10.0, 0.0, 6.0, 1.0 };
    REQUIRE (p.isValid());

    SECTION ("default (clamped) mode")
    {
        REQUIRE (p.uiToRaw (0.0,   false) == Approx (0.0));
        REQUIRE (p.uiToRaw (100.0, false) == Approx (6.0));   // clamp ceiling, NOT 10
        REQUIRE (p.uiToRaw (50.0,  false) == Approx (3.0));
    }

    SECTION ("lab mode unlocks the full raw range")
    {
        REQUIRE (p.uiToRaw (0.0,   true) == Approx (0.0));
        REQUIRE (p.uiToRaw (100.0, true) == Approx (10.0));   // the broken/alien top
        REQUIRE (p.uiToRaw (50.0,  true) == Approx (5.0));
    }
}

TEST_CASE ("ASTD uiToRaw/rawToUi are inverses within the active range", "[astd]")
{
    AstdParam p { "cfg", 0.0, 20.0, 1.0, 9.0, 1.0 };
    for (double ui : { 0.0, 12.5, 25.0, 50.0, 75.0, 100.0 })
    {
        const double raw = p.uiToRaw (ui, false);
        REQUIRE (p.rawToUi (raw, false) == Approx (ui).margin (1e-6));
    }
}

TEST_CASE ("ASTD skew biases UI resolution but preserves endpoints", "[astd]")
{
    AstdParam p { "amount", 0.0, 1.0, 0.0, 1.0, 2.0 }; // skew=2 → more low-end resolution
    REQUIRE (p.uiToRaw (0.0,   false) == Approx (0.0));
    REQUIRE (p.uiToRaw (100.0, false) == Approx (1.0));
    // midpoint pulled toward the bottom by the skew.
    REQUIRE (p.uiToRaw (50.0, false) == Approx (0.25));
}

TEST_CASE ("ASTD clampRaw enforces the safe ceiling unless lab mode", "[astd]")
{
    AstdParam p { "drive", 0.0, 10.0, 0.0, 6.0, 1.0 };
    REQUIRE (p.clampRaw (9.0, false) == Approx (6.0));   // pulled back to safe ceiling
    REQUIRE (p.clampRaw (9.0, true)  == Approx (9.0));   // allowed in lab mode
    REQUIRE (p.clampRaw (99.0, true) == Approx (10.0));  // still bounded by raw max
}

TEST_CASE ("AstdRegistry maps by param id and passes unmapped through", "[astd]")
{
    AstdRegistry reg;
    reg.set ({ "drive", 0.0, 10.0, 0.0, 6.0, 1.0 });

    REQUIRE (reg.has ("drive"));
    REQUIRE (reg.uiToRaw ("drive", 100.0, false) == Approx (6.0));
    // Unknown param passes the UI value through verbatim.
    REQUIRE (reg.uiToRaw ("unknown", 42.0, false) == Approx (42.0));
}
