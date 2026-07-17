#pragma once

#include <juce_core/juce_core.h>

// G2b — count-in / pre-roll BARS before recording starts.
//
// Mosh's own domain is deliberately small: {0 (off), 1 (one bar), 2 (two
// bars)}. This is NOT an arbitrary choice — tracktion_engine already ships a
// REAL, engine-native pre-roll (te::Edit::setCountInMode / getNumCountInBeats,
// consulted by TransportControl's record-start logic to roll the playhead
// back N beats and play an audible click through the pre-roll before capture
// actually begins — see tracktion_TransportControl.cpp's performRecord). Its
// own te::Edit::CountIn enum offers none/oneBar/twoBar (plus oneBeat/twoBeat,
// not exposed here — a future extension, not a v0 need), and those three
// values happen to be 0/1/2 — so a bars value validated here casts straight
// across at the MoshOps call site with zero lookup table (see
// MoshOps::cmdSetCountIn / MoshOps::applyCountInToEdit, which static_assert
// the alignment against the real enum).
//
// Header-only + engine-free (juce_core only, no tracktion_engine, no
// juce_data_structures) so it unit-tests in MoshTests with zero engine
// dependency — mirroring state/Migrations.h / moshops/DrumPattern.h. The
// command itself (snapshot field, persistence, undo posture) is exercised
// against a live Edit in src/app/SelfTest.cpp, the same split already used by
// its siblings set_key / set_metronome / set_project_settings (MoshTests
// doesn't compile MoshOps.cpp/MoshEngine.cpp, so a live-engine command can't
// be Catch2-tested directly).
namespace mosh::countin
{
    inline constexpr int kMinBars = 0;
    inline constexpr int kMaxBars = 2;

    inline bool isValidBars (int bars) noexcept
    {
        return bars >= kMinBars && bars <= kMaxBars;
    }

    inline juce::String validationError()
    {
        return "bars must be 0 (off), 1 (one bar), or 2 (two bars)";
    }
}
