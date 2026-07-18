// G2b — count-in / pre-roll bars: pure validation-logic goldens.
//
// MoshTests doesn't link tracktion_engine (it's a lightweight console app over
// the engine-free logic modules — see tests/CMakeLists.txt), so the live
// command (MoshOps::cmdSetCountIn, the snapshot field, save/reload,
// non-undoable-preference posture) can't be Catch2-tested directly; it's
// exercised against a real Edit in src/app/SelfTest.cpp's "G2b" section,
// the same split already used by its siblings set_key / set_metronome /
// set_project_settings (none of which have Catch2 coverage either). This file
// covers exactly what cmdSetCountIn/applyCountInToEdit rely on: the pure
// {0,1,2}-bars domain in state/CountIn.h, which is deliberately engine-free so
// it CAN be unit-tested here (mirrors state/test_migrations.cpp).
#include <catch2/catch_test_macros.hpp>
#include "state/CountIn.h"

using namespace mosh::countin;

TEST_CASE ("countin: 0, 1, 2 are valid bars", "[countin]")
{
    CHECK (isValidBars (0));
    CHECK (isValidBars (1));
    CHECK (isValidBars (2));
}

TEST_CASE ("countin: negative and >2 are rejected", "[countin]")
{
    CHECK_FALSE (isValidBars (-1));
    CHECK_FALSE (isValidBars (3));
    CHECK_FALSE (isValidBars (4));
    CHECK_FALSE (isValidBars (100));
    CHECK_FALSE (isValidBars (-100));
}

TEST_CASE ("countin: kMinBars/kMaxBars bound the domain exactly", "[countin]")
{
    CHECK (kMinBars == 0);
    CHECK (kMaxBars == 2);
    CHECK (isValidBars (kMinBars));
    CHECK (isValidBars (kMaxBars));
    CHECK_FALSE (isValidBars (kMinBars - 1));
    CHECK_FALSE (isValidBars (kMaxBars + 1));
}

TEST_CASE ("countin: validationError is a non-empty, deterministic message", "[countin]")
{
    CHECK (validationError().isNotEmpty());
    CHECK (validationError() == validationError());   // same string every call
    // Mentions the actual domain, so a future bars-range change can't silently
    // leave a stale error message behind.
    CHECK (validationError().contains ("0"));
    CHECK (validationError().contains ("2"));
}
