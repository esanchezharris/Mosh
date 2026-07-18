// G1: export_audio range/section + delay-tail policy — pure resolution math.
// See src/moshops/ExportRange.h (mosh::resolveExportRange) and
// docs/superpowers/specs/2026-07-10-g1-export-range-section-delay-tail-policy.md.
// Invariants: 78 (render the intended span) and 81 (delay-tail policy).
#include <catch2/catch_test_macros.hpp>
#include "moshops/ExportRange.h"

using namespace mosh;

namespace
{
    // Convenience: no start/end/tail args at all (the pre-G1 call shape).
    ExportRangeResult resolveDefault (double editLen, double loopStart = 0.0, double loopEnd = 0.0)
    {
        return resolveExportRange (editLen, loopStart, loopEnd,
                                   /*hasRange*/ false, {},
                                   /*hasStart*/ false, 0.0,
                                   /*hasEnd*/ false, 0.0,
                                   /*hasTail*/ false, {},
                                   /*hasTailSeconds*/ false, 0.0);
    }
}

TEST_CASE ("no args at all resolves to full/cut — the pre-G1 default (acceptance #1)", "[export][g1]")
{
    auto r = resolveDefault (4.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "full");
    CHECK (r.rangeStart == 0.0);
    CHECK (r.rangeEnd == 4.0);
    CHECK (r.tailKind == "cut");
    CHECK (r.tailSeconds == 0.0);
}

TEST_CASE ("explicit range:'full' is identical to omitting range", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "full",
                                 false, 0.0, false, 0.0,
                                 false, {}, false, 0.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "full");
    CHECK (r.rangeStart == 0.0);
    CHECK (r.rangeEnd == 4.0);
}

TEST_CASE ("range enum is case/whitespace-insensitive", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "  FULL  ",
                                 false, 0.0, false, 0.0,
                                 false, {}, false, 0.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "full");
}

TEST_CASE ("an unknown range keyword errors before any render", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "bogus",
                                 false, 0.0, false, 0.0,
                                 false, {}, false, 0.0);
    CHECK_FALSE (r.ok);
    CHECK (r.error.contains ("range must be"));
}

TEST_CASE ("custom range renders exactly [start,end] (invariant 78)", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "custom",
                                 true, 1.0, true, 3.0,
                                 false, {}, false, 0.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "custom");
    CHECK (r.rangeStart == 1.0);
    CHECK (r.rangeEnd == 3.0);
    // The direct arithmetic proof invariant 78 rests on: a shorter span.
    CHECK ((r.rangeEnd - r.rangeStart) < 4.0);
}

TEST_CASE ("presence of start+end alone IMPLIES range:'custom' (ergonomics, spec §2)", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 /*hasRange*/ false, {},
                                 true, 0.5, true, 2.5,
                                 false, {}, false, 0.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "custom");
    CHECK (r.rangeStart == 0.5);
    CHECK (r.rangeEnd == 2.5);
}

TEST_CASE ("range:'custom' without start/end errors", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "custom",
                                 false, 0.0, false, 0.0,
                                 false, {}, false, 0.0);
    CHECK_FALSE (r.ok);
    CHECK (r.error.contains ("requires"));
}

TEST_CASE ("range:'custom' with end <= start errors (no partial/empty file)", "[export][g1]")
{
    auto zero = resolveExportRange (4.0, 0.0, 0.0, true, "custom", true, 2.0, true, 2.0, false, {}, false, 0.0);
    CHECK_FALSE (zero.ok);

    auto inverted = resolveExportRange (4.0, 0.0, 0.0, true, "custom", true, 3.0, true, 1.0, false, {}, false, 0.0);
    CHECK_FALSE (inverted.ok);
    CHECK (inverted.error.contains ("empty"));
}

TEST_CASE ("custom bounds are clamped into [0, editLen] rather than erroring", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "custom",
                                 true, -5.0, true, 999.0,
                                 false, {}, false, 0.0);
    REQUIRE (r.ok);
    CHECK (r.rangeStart == 0.0);
    CHECK (r.rangeEnd == 4.0);
}

TEST_CASE ("range:'loop' renders the transport's current loop region", "[export][g1]")
{
    auto r = resolveExportRange (4.0, /*loopStart*/ 0.5, /*loopEnd*/ 2.5,
                                 true, "loop",
                                 false, 0.0, false, 0.0,
                                 false, {}, false, 0.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "loop");
    CHECK (r.rangeStart == 0.5);
    CHECK (r.rangeEnd == 2.5);
}

TEST_CASE ("range:'loop' with no loop configured (0,0) errors cleanly", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "loop",
                                 false, 0.0, false, 0.0,
                                 false, {}, false, 0.0);
    CHECK_FALSE (r.ok);
    CHECK (r.error.contains ("no loop region is set"));
}

TEST_CASE ("range:'loop' with a degenerate near-zero-length loop also errors", "[export][g1]")
{
    // < 0.01s counts as "no loop" (the same epsilon the reverse move/trim gestures use).
    auto r = resolveExportRange (4.0, 1.0, 1.005,
                                 true, "loop",
                                 false, 0.0, false, 0.0,
                                 false, {}, false, 0.0);
    CHECK_FALSE (r.ok);
}

TEST_CASE ("tail defaults to 'cut' (endAllowance 0) when omitted (invariant 81)", "[export][g1]")
{
    auto r = resolveDefault (4.0);
    REQUIRE (r.ok);
    CHECK (r.tailKind == "cut");
    CHECK (r.tailSeconds == 0.0);
}

TEST_CASE ("tail:'include' defaults tailSeconds to 2.0 when omitted", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 false, {}, false, 0.0, false, 0.0,
                                 true, "include",
                                 false, 0.0);
    REQUIRE (r.ok);
    CHECK (r.tailKind == "include");
    CHECK (r.tailSeconds == 2.0);
}

TEST_CASE ("tail:'include' honors an explicit tailSeconds", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 false, {}, false, 0.0, false, 0.0,
                                 true, "include",
                                 true, 5.5);
    REQUIRE (r.ok);
    CHECK (r.tailSeconds == 5.5);
}

TEST_CASE ("tailSeconds is clamped to [0.05, 30]", "[export][g1]")
{
    auto tooSmall = resolveExportRange (4.0, 0.0, 0.0, false, {}, false, 0.0, false, 0.0,
                                        true, "include", true, 0.0);
    REQUIRE (tooSmall.ok);
    CHECK (tooSmall.tailSeconds == 0.05);

    auto tooBig = resolveExportRange (4.0, 0.0, 0.0, false, {}, false, 0.0, false, 0.0,
                                      true, "include", true, 999.0);
    REQUIRE (tooBig.ok);
    CHECK (tooBig.tailSeconds == 30.0);
}

TEST_CASE ("tail:'cut' ignores any supplied tailSeconds — endAllowance stays 0", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0, false, {}, false, 0.0, false, 0.0,
                                 true, "cut", true, 12.0);
    REQUIRE (r.ok);
    CHECK (r.tailKind == "cut");
    CHECK (r.tailSeconds == 0.0);
}

TEST_CASE ("an unknown tail keyword errors before any render", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0, false, {}, false, 0.0, false, 0.0,
                                 true, "bogus", false, 0.0);
    CHECK_FALSE (r.ok);
    CHECK (r.error.contains ("tail must be"));
}

TEST_CASE ("an explicitly-empty tail string is rejected, NOT silently treated as 'cut'", "[export][g1]")
{
    // Mirrors args.getProperty("tail","cut") semantics: the default only applies when
    // the property is ABSENT, not when it's present-but-empty.
    auto r = resolveExportRange (4.0, 0.0, 0.0, false, {}, false, 0.0, false, 0.0,
                                 true, "", false, 0.0);
    CHECK_FALSE (r.ok);
}

TEST_CASE ("range + tail compose independently: a custom range with an included tail", "[export][g1]")
{
    auto r = resolveExportRange (4.0, 0.0, 0.0,
                                 true, "custom", true, 0.0, true, 1.0,
                                 true, "include", true, 2.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "custom");
    CHECK (r.rangeStart == 0.0);
    CHECK (r.rangeEnd == 1.0);
    CHECK (r.tailKind == "include");
    CHECK (r.tailSeconds == 2.0);
}

TEST_CASE ("a degenerate edit length (0s) still floors to a safe minimum, never divides by zero", "[export][g1]")
{
    auto r = resolveDefault (0.0);
    REQUIRE (r.ok);
    CHECK (r.rangeKind == "full");
    CHECK (r.rangeStart == 0.0);
    CHECK (r.rangeEnd > 0.0);   // floored to >= 0.01, not exactly 0
}
