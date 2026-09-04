// CAP-001 — recording residue after an unclean exit: the engine-free decisions.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "engine/RecordingResidue.h"

#include <juce_audio_formats/juce_audio_formats.h>

using namespace mosh::residue;

TEST_CASE ("take file names parse on the LAST _Take_ marker", "[residue]")
{
    auto r = parseTakeFileName ("session_Vocal_Take_3");
    REQUIRE (r.has_value());
    CHECK (r->editName == "session");
    CHECK (r->trackName == "Vocal");
    CHECK (r->take == 3);

    // Track names with underscores keep them.
    auto u = parseTakeFileName ("mysong_Lead_Vox_L_Take_12");
    REQUIRE (u.has_value());
    CHECK (u->editName == "mysong");
    CHECK (u->trackName == "Lead_Vox_L");
    CHECK (u->take == 12);

    // The unnamed-Edit form Tracktion actually writes for a Mosh project (no "%edit%_").
    auto bare = parseTakeFileName ("Vox_Take_1");
    REQUIRE (bare.has_value());
    CHECK (bare->editName.isEmpty());
    CHECK (bare->trackName == "Vox");
    CHECK (bare->take == 1);

    CHECK_FALSE (parseTakeFileName ("mix").has_value());
    CHECK_FALSE (parseTakeFileName ("_Take_1").has_value());
    CHECK_FALSE (parseTakeFileName ("session_Vocal_Take_").has_value());
    CHECK_FALSE (parseTakeFileName ("session_Vocal_Take_x").has_value());
}

TEST_CASE ("residue is adopted only when it is real audio at the project rate", "[residue]")
{
    CHECK (decide (true, 48000, 48000.0, 48000.0) == Decision::adopt);
    CHECK (decide (true, 48000, 48000.0, 0.0) == Decision::adopt);          // unknown project rate
    CHECK (decide (false, 48000, 48000.0, 48000.0) == Decision::quarantine);
    CHECK (decide (true, 0, 48000.0, 48000.0) == Decision::quarantine);
    CHECK (decide (true, 48000, 44100.0, 48000.0) == Decision::quarantine); // no resampling
}

TEST_CASE ("quarantine renames in place and never collides", "[residue]")
{
    const juce::File f ("/tmp/proj/session_Vocal_Take_3.wav");
    const auto q1 = quarantineName (f);
    const auto q2 = quarantineName (f);
    CHECK (q1.getParentDirectory() == f.getParentDirectory());
    CHECK (q1.getFileName().startsWith ("session_Vocal_Take_3.wav.quarantined-"));
    CHECK (q1 != q2);
    CHECK (q1.getFileExtension() != ".wav");   // no reader will mistake it for audio
}

TEST_CASE ("BWAV time reference places the take", "[residue]")
{
    CHECK (startSecondsFromTimeReference ("96000", 48000.0) == Catch::Approx (2.0));
    CHECK (startSecondsFromTimeReference ("", 48000.0) == 0.0);
    CHECK (startSecondsFromTimeReference ("96000", 0.0) == 0.0);
    CHECK (startSecondsFromTimeReference ("-5", 48000.0) == 0.0);
}

TEST_CASE ("residue scan lists orphan take files newest first and nothing else", "[residue]")
{
    auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                   .getChildFile ("mosh-residue-" + juce::Uuid().toString().substring (0, 8));
    REQUIRE (dir.createDirectory());
    auto fresh = dir.getChildFile ("song_Vocal_Take_3.wav");   REQUIRE (fresh.replaceWithText ("RIFF"));
    auto torn  = dir.getChildFile ("song_Vocal_Take_4.wav");   REQUIRE (torn.replaceWithText ("junk"));
    auto old   = dir.getChildFile ("song_Vocal_Take_1.wav");   REQUIRE (old.replaceWithText ("RIFF"));
    REQUIRE (old.setLastModificationTime (juce::Time::getCurrentTime() - juce::RelativeTime::days (1)));
    auto used  = dir.getChildFile ("song_Vocal_Take_2.wav");   REQUIRE (used.replaceWithText ("RIFF"));
    auto other = dir.getChildFile ("bounce.wav");              REQUIRE (other.replaceWithText ("RIFF"));
    auto notWav = dir.getChildFile ("song_Vocal_Take_5.aiff"); REQUIRE (notWav.replaceWithText ("RIFF"));

    std::set<juce::String> referenced { used.getFullPathName() };
    const auto found = findResidue (dir, referenced);
    juce::StringArray names;
    for (const auto& f : found) names.add (f.getFileName());
    CHECK (names.contains ("song_Vocal_Take_3.wav"));
    CHECK (names.contains ("song_Vocal_Take_4.wav"));         // torn is still LISTED (to be quarantined)
    CHECK (names.contains ("song_Vocal_Take_1.wav"));         // old orphans are offered too (no freshness rule)
    CHECK_FALSE (names.contains ("song_Vocal_Take_2.wav"));   // referenced by a clip
    CHECK_FALSE (names.contains ("bounce.wav"));              // not a take file
    CHECK_FALSE (names.contains ("song_Vocal_Take_5.aiff"));
    CHECK (names[names.size() - 1] == "song_Vocal_Take_1.wav");   // newest first, the day-old one last
    CHECK (reasonNotEligible (used, referenced) == "a clip already references it");
    CHECK (reasonNotEligible (other, referenced) == "not a Tracktion take file");
    CHECK (reasonNotEligible (fresh, referenced).isEmpty());
    dir.deleteRecursively();
}

TEST_CASE ("a crash-torn WAV header is inspected and repaired into a readable copy", "[residue]")
{
    // Exactly what a mid-take SIGKILL leaves: JUCE's header with data size 0 (and a stale
    // RIFF size), then the PCM bytes that were streamed before the kill.
    auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                   .getChildFile ("mosh-residue-wav-" + juce::Uuid().toString().substring (0, 8));
    REQUIRE (dir.createDirectory());
    auto torn = dir.getChildFile ("Vox_Take_1.wav");
    {
        juce::MemoryOutputStream m;
        auto tag = [&] (const char* t) { m.write (t, 4); };
        tag ("RIFF"); m.writeInt (36); tag ("WAVE");
        tag ("fmt "); m.writeInt (16);
        m.writeShort (1); m.writeShort (1); m.writeInt (48000); m.writeInt (48000 * 2); m.writeShort (2); m.writeShort (16);
        tag ("data"); m.writeInt (0);                 // the lie
        for (int i = 0; i < 48000; ++i)               // one second of 16-bit ramp
            m.writeShort ((short) ((i % 2000) * 10 - 10000));
        REQUIRE (torn.replaceWithData (m.getData(), m.getDataSize()));
    }
    const auto shape = inspectWav (torn);
    CHECK (shape.riff);
    CHECK (shape.channels == 1);
    CHECK (shape.bitsPerSample == 16);
    CHECK (shape.sampleRate == Catch::Approx (48000.0));
    CHECK (shape.declaredDataBytes == 0);
    CHECK (shape.payloadFrames() == 48000);
    CHECK (shape.headerTorn());

    // Every reader refuses the torn file...
    juce::AudioFormatManager afm; afm.registerBasicFormats();
    {
        std::unique_ptr<juce::AudioFormatReader> r (afm.createReaderFor (torn));
        CHECK ((r == nullptr || r->lengthInSamples == 0));
    }
    // ...and reads the repaired copy in full, with the original untouched.
    auto fixed = dir.getChildFile ("Vox_Take_1.recovered.wav");
    REQUIRE (repairTruncatedWav (torn, fixed));
    {
        std::unique_ptr<juce::AudioFormatReader> r (afm.createReaderFor (fixed));
        REQUIRE (r != nullptr);
        CHECK (r->lengthInSamples == 48000);
        CHECK (r->sampleRate == Catch::Approx (48000.0));
    }
    CHECK (inspectWav (torn).declaredDataBytes == 0);
    CHECK_FALSE (inspectWav (fixed).headerTorn());
    // A healthy file is not "torn", and junk is not a WAV at all.
    auto junk = dir.getChildFile ("Vox_Take_2.wav");
    REQUIRE (junk.replaceWithText ("this is not a wav"));
    CHECK_FALSE (inspectWav (junk).riff);
    CHECK_FALSE (repairTruncatedWav (junk, dir.getChildFile ("nope.wav")));
    CHECK_FALSE (dir.getChildFile ("nope.wav").existsAsFile());
    CHECK (decide (true, 48000, 48000.0, 48000.0) == Decision::adopt);
    dir.deleteRecursively();
}
