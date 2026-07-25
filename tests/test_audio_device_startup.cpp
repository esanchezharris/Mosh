// AUD-017 — the pure decision layer of the bounded audio-device startup.
//
// The blocking part (a CoreAudio open on a worker thread with a timeout) needs real
// hardware and lives in MoshEngine.cpp, which MoshTests deliberately cannot link. What
// IS testable here is everything that decides how long to wait and what the user is
// told — and those are exactly the parts that would silently rot: a timeout that a typo
// turns off, or an error message that names nothing.

#include <catch2/catch_test_macros.hpp>

#include "engine/AudioDeviceStartup.h"

using namespace mosh::audiostartup;

TEST_CASE ("audio-open timeout resolves from the env value", "[audiostartup]")
{
    SECTION ("absent / blank / junk all fall back to the default")
    {
        CHECK (timeoutMsFromEnv ({}) == kDefaultTimeoutMs);
        CHECK (timeoutMsFromEnv ("   ") == kDefaultTimeoutMs);
        CHECK (timeoutMsFromEnv ("banana") == kDefaultTimeoutMs);
    }

    SECTION ("a bound can never be turned OFF by a bad value")
    {
        // This is the whole point of the clamp: 0 or a negative would mean "wait
        // forever" / "don't wait", either of which restores the original hang.
        CHECK (timeoutMsFromEnv ("0") == kDefaultTimeoutMs);
        CHECK (timeoutMsFromEnv ("-1") == kDefaultTimeoutMs);
        CHECK (timeoutMsFromEnv ("999999") == kMaxTimeoutMs);
        CHECK (timeoutMsFromEnv ("1") == kMinTimeoutMs);
    }

    SECTION ("a sane value is honoured verbatim")
    {
        CHECK (timeoutMsFromEnv ("2500") == 2500);
        CHECK (timeoutMsFromEnv ("  8000  ") == 8000);
    }
}

TEST_CASE ("the failure names the device the user has to fix", "[audiostartup]")
{
    SECTION ("no saved setup — the system default")
    {
        CHECK (deviceLabel (nullptr) == "the system default audio device");
        juce::XmlElement empty ("DEVICESETUP");
        CHECK (deviceLabel (&empty) == "the system default audio device");
    }

    SECTION ("output name")
    {
        juce::XmlElement xml ("DEVICESETUP");
        xml.setAttribute ("audioOutputDeviceName", "MacBook Pro Speakers");
        CHECK (deviceLabel (&xml) == "\"MacBook Pro Speakers\"");
    }

    SECTION ("a distinct input is named too — the AUD-017 repro was an input pairing")
    {
        // The observed hang was inside AudioIODeviceCombiner: JUCE pairing a SEPARATE
        // input device with the output. Blaming only the output would point the user at
        // the wrong hardware.
        juce::XmlElement xml ("DEVICESETUP");
        xml.setAttribute ("audioOutputDeviceName", "MacBook Pro Speakers");
        xml.setAttribute ("audioInputDeviceName", "iPhone Microphone");
        CHECK (deviceLabel (&xml) == "\"MacBook Pro Speakers\" (input \"iPhone Microphone\")");
    }

    SECTION ("input only")
    {
        juce::XmlElement xml ("DEVICESETUP");
        xml.setAttribute ("audioInputDeviceName", "BlackHole 2ch");
        CHECK (deviceLabel (&xml) == "input \"BlackHole 2ch\"");
    }

    SECTION ("the legacy single-name attribute is honoured")
    {
        juce::XmlElement xml ("DEVICESETUP");
        xml.setAttribute ("audioDeviceName", "Scarlett 2i2");
        CHECK (deviceLabel (&xml) == "\"Scarlett 2i2\"");
    }
}

TEST_CASE ("the timeout message is actionable, not a shrug", "[audiostartup]")
{
    const auto msg = timeoutMessage (deviceLabel (nullptr), 5000);

    // Names the device, states the degraded mode, and says what to do. A user who reads
    // only this string must know why there is no sound and what their next move is.
    CHECK (msg.contains ("the system default audio device"));
    CHECK (msg.contains ("5.0s"));
    CHECK (msg.contains ("WITHOUT audio"));
    CHECK (msg.contains ("Retry"));

    juce::XmlElement xml ("DEVICESETUP");
    xml.setAttribute ("audioOutputDeviceName", "Wedged Interface");
    CHECK (timeoutMessage (deviceLabel (&xml), 2500).contains ("\"Wedged Interface\""));
    CHECK (timeoutMessage (deviceLabel (&xml), 2500).contains ("2.5s"));
}
