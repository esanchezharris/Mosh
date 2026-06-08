#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include "ClipMath.h"

using namespace mosh;
using Catch::Approx;

TEST_CASE ("moveBy shifts the clip and preserves length + offset", "[clipmath]")
{
    ClipGeom c { 4.0, 8.0, 2.0 };
    auto m = moveBy (c, 3.0);
    REQUIRE (m.start == Approx (7.0));
    REQUIRE (m.end == Approx (11.0));
    REQUIRE (m.offset == Approx (2.0));
    REQUIRE (m.length() == Approx (4.0));
}

TEST_CASE ("moveBy clamps at the timeline start, preserving length", "[clipmath]")
{
    ClipGeom c { 1.0, 5.0, 0.0 };
    auto m = moveBy (c, -10.0);
    REQUIRE (m.start == Approx (0.0));
    REQUIRE (m.length() == Approx (4.0));   // length kept, not squashed
}

TEST_CASE ("trimStart moves the source offset with the edge", "[clipmath]")
{
    ClipGeom c { 4.0, 8.0, 2.0 };
    auto t = trimStart (c, 5.0);
    REQUIRE (t.has_value());
    REQUIRE (t->start == Approx (5.0));
    REQUIRE (t->end == Approx (8.0));
    REQUIRE (t->offset == Approx (3.0));    // offset += (5 - 4)
}

TEST_CASE ("trimStart refuses to read before the source start or invert", "[clipmath]")
{
    ClipGeom c { 4.0, 8.0, 0.5 };
    REQUIRE_FALSE (trimStart (c, 3.0).has_value());   // offset would go negative
    REQUIRE_FALSE (trimStart (c, 8.0).has_value());   // zero-length
    REQUIRE_FALSE (trimStart (c, 9.0).has_value());   // inverted
}

TEST_CASE ("trimEnd changes only the end, refuses inversion", "[clipmath]")
{
    ClipGeom c { 4.0, 8.0, 2.0 };
    auto t = trimEnd (c, 6.0);
    REQUIRE (t.has_value());
    REQUIRE (t->end == Approx (6.0));
    REQUIRE (t->offset == Approx (2.0));
    REQUIRE_FALSE (trimEnd (c, 4.0).has_value());
}

TEST_CASE ("splitAt yields two seamless pieces", "[clipmath]")
{
    ClipGeom c { 4.0, 8.0, 2.0 };
    auto s = splitAt (c, 6.0);
    REQUIRE (s.has_value());
    auto [a, b] = *s;
    REQUIRE (a.start == Approx (4.0));
    REQUIRE (a.end == Approx (6.0));
    REQUIRE (a.offset == Approx (2.0));
    REQUIRE (b.start == Approx (6.0));
    REQUIRE (b.end == Approx (8.0));
    REQUIRE (b.offset == Approx (4.0));     // 2 + (6 - 4): seamless continuation
    // The two pieces tile the original exactly.
    REQUIRE (a.length() + b.length() == Approx (c.length()));
}

TEST_CASE ("splitAt refuses a cut outside the clip", "[clipmath]")
{
    ClipGeom c { 4.0, 8.0, 0.0 };
    REQUIRE_FALSE (splitAt (c, 4.0).has_value());
    REQUIRE_FALSE (splitAt (c, 8.0).has_value());
    REQUIRE_FALSE (splitAt (c, 2.0).has_value());
}
