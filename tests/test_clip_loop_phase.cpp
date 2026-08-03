#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "moshops/ClipLoopPhase.h"

using Catch::Approx;

TEST_CASE ("loop phase materialisation wraps an exact EOF to source zero", "[clips][loop]")
{
    CHECK (mosh::materialiseLoopSourceOffset (4.0, 0.0, 4.0) == Approx (0.0));
}

TEST_CASE ("loop phase materialisation preserves a partial loop's audible phase", "[clips][loop]")
{
    CHECK (mosh::materialiseLoopSourceOffset (12.75, 0.5, 1.0) == Approx (1.25));
}

TEST_CASE ("loop phase materialisation uses negative-aware floating modulo", "[clips][loop]")
{
    CHECK (mosh::materialiseLoopSourceOffset (-2.25, 0.5, 1.0) == Approx (1.25));
}

TEST_CASE ("loop phase materialisation leaves an unlooped offset unchanged", "[clips][loop]")
{
    CHECK (mosh::materialiseLoopSourceOffset (3.25, 0.0, 0.0) == Approx (3.25));
}
