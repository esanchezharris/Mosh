#include <catch2/catch_test_macros.hpp>
#include "moshops/StemExport.h"

using namespace mosh;

// G7 — per-track stem export, common zero point
// (docs/superpowers/specs/2026-07-10-g7-stem-export-per-track-common-zero-point.md).
//
// Engine-free: exercises the pure naming primitive `stemFileBaseName` that
// MoshOps::cmdExportStems uses to build each stem's on-disk file name. The
// render loop itself (te::Renderer over a real te::Edit — the "common zero
// point" `{0, editLength}` window every stem shares) needs a live engine and
// is covered by --selftest (src/app/SelfTest.cpp) and the real-rendered-audio
// gate (scripts/verify-hardware/verify.py's check_stem_export).

TEST_CASE ("stemFileBaseName zero-pads the snapshot index to two digits", "[export][stems]")
{
    REQUIRE (stemFileBaseName (0, "Drums")  == "00-Drums");
    REQUIRE (stemFileBaseName (1, "Bass")   == "01-Bass");
    REQUIRE (stemFileBaseName (9, "Vocal")  == "09-Vocal");
    // Beyond two digits the padding simply stops widening (juce's paddedLeft never
    // truncates) — still unique, just no longer zero-padded to a fixed width.
    REQUIRE (stemFileBaseName (10, "Synth") == "10-Synth");
}

TEST_CASE ("stemFileBaseName disambiguates duplicate track names by index alone", "[export][stems]")
{
    // Two tracks can legitimately share a display name ("Vocal", "Vocal (2)"-style
    // renaming isn't enforced anywhere upstream). The index — not the name — is
    // what the loop guarantees is unique, so two same-named tracks must still
    // produce two distinct file names.
    const auto a = stemFileBaseName (0, "Vocal");
    const auto b = stemFileBaseName (1, "Vocal");
    REQUIRE (a != b);
    REQUIRE (a == "00-Vocal");
    REQUIRE (b == "01-Vocal");
}

TEST_CASE ("stemFileBaseName sanitizes filesystem-illegal characters in the track name", "[export][stems]")
{
    // createLegalFileName strips/replaces characters that aren't valid in a file
    // name on the host filesystem (slashes above all — a literal "/" in a track
    // name must never be read as a path separator and escape the export dir).
    const auto name = stemFileBaseName (2, "Lead/Synth:Take*2?");
    REQUIRE (! name.contains ("/"));
    INFO (name.toStdString());
    REQUIRE (name.startsWith ("02-"));
}

TEST_CASE ("stemFileBaseName preserves ordinary track names verbatim", "[export][stems]")
{
    REQUIRE (stemFileBaseName (5, "Lead Vocal") == "05-Lead Vocal");
}
