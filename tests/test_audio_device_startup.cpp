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

TEST_CASE ("the hardware probe is a separate killable process", "[audiostartup]")
{
    const juce::File executable ("/Applications/Mosh Audit.app/Contents/MacOS/Mosh");
    const juce::String nonce ("0123456789abcdef0123456789abcdef");
    juce::XmlElement setup ("DEVICESETUP");
    setup.setAttribute ("deviceType", "CoreAudio");
    setup.setAttribute ("audioOutputDeviceName", "MacBook Pro Speakers");
    setup.setAttribute ("audioInputDeviceName", "BlackHole 2ch");
    setup.setAttribute ("audioDeviceRate", 44100.0);
    setup.setAttribute ("audioDeviceBufferSize", 1024);
    setup.setAttribute ("audioDeviceInChans", "01");
    setup.setAttribute ("audioDeviceOutChans", "10");
    const auto args = probeChildArguments (executable,
                                           nonce,
                                           &setup,
                                           512,
                                           512,
                                           60000);

    REQUIRE (args.size() == 7);
    CHECK (args[0] == executable.getFullPathName());
    CHECK (args[1] == "--audio-probe");
    CHECK (args[2] == nonce);
    CHECK (args[3].startsWith ("xml:"));
    CHECK (args[4] == "512");
    CHECK (args[5] == "512");
    CHECK (args[6] == "60000");

    const auto output = "startup noise\n"
                        + probeResultLine (nonce, "device failed to start")
                        + "shutdown noise\n";
    const auto response = parseProbeResponse (output, nonce);
    REQUIRE (response.valid);
    CHECK (response.error == "device failed to start");

    auto childArgs = args;
    childArgs.remove (0);
    const auto request = parseProbeRequest (childArgs);
    REQUIRE (request.valid);
    CHECK (request.nonce == nonce);
    CHECK_FALSE (request.useDefaultSetup);
    CHECK (request.numInputChannels == 512);
    CHECK (request.numOutputChannels == 512);
    CHECK (request.stallMs == 60000);
    const auto parsedSetup = juce::XmlDocument::parse (request.setupXml);
    REQUIRE (parsedSetup != nullptr);
    CHECK (parsedSetup->getStringAttribute ("audioOutputDeviceName")
           == "MacBook Pro Speakers");
    CHECK (parsedSetup->getStringAttribute ("audioInputDeviceName")
           == "BlackHole 2ch");
    CHECK (parsedSetup->getDoubleAttribute ("audioDeviceRate") == 44100.0);
    CHECK (parsedSetup->getIntAttribute ("audioDeviceBufferSize") == 1024);
    CHECK (parsedSetup->getStringAttribute ("audioDeviceInChans") == "01");
    CHECK (parsedSetup->getStringAttribute ("audioDeviceOutChans") == "10");
}

TEST_CASE ("probe framing cannot be shifted or spoofed by device output", "[audiostartup]")
{
    const juce::File executable ("/Applications/Mosh.app/Contents/MacOS/Mosh");
    const juce::String nonce ("abcdef0123456789abcdef0123456789");
    juce::XmlElement setup ("DEVICESETUP");
    setup.setAttribute ("audioOutputDeviceName", "--audio-probe-input");
    setup.setAttribute ("audioInputDeviceName", "--audio-probe-stall-ms");
    const auto args = probeChildArguments (executable, nonce, &setup, 2, 2, 250);
    auto childArgs = args;
    childArgs.remove (0);
    const auto request = parseProbeRequest (childArgs);
    REQUIRE (request.valid);
    const auto parsedSetup = juce::XmlDocument::parse (request.setupXml);
    REQUIRE (parsedSetup != nullptr);
    CHECK (parsedSetup->getStringAttribute ("audioOutputDeviceName")
           == "--audio-probe-input");
    CHECK (parsedSetup->getStringAttribute ("audioInputDeviceName")
           == "--audio-probe-stall-ms");
    auto invalidSetupArgs = childArgs;
    invalidSetupArgs.set (2, "xml:not-base64");
    CHECK_FALSE (parseProbeRequest (invalidSetupArgs).valid);
    auto excessiveChannelsArgs = childArgs;
    excessiveChannelsArgs.set (3, "513");
    CHECK_FALSE (parseProbeRequest (excessiveChannelsArgs).valid);

    const auto spoof = juce::String (kProbeResultPrefix)
                     + "00000000000000000000000000000000 \"\"\n";
    CHECK_FALSE (parseProbeResponse (spoof, nonce).valid);
    CHECK_FALSE (parseProbeResponse (spoof + probeResultLine (nonce, "real"), nonce)
                     .error.isEmpty());
    CHECK_FALSE (parseProbeResponse (
        probeResultLine (nonce, {}) + probeResultLine (nonce, "duplicate"), nonce).valid);
    CHECK_FALSE (parseProbeResponse (
        juce::String (kProbeResultPrefix) + nonce + " not-json\n", nonce).valid);
    CHECK_FALSE (parseProbeResponse (
        juce::String (kProbeResultPrefix) + nonce + " \"\" trailing\n", nonce).valid);
    const auto multiline = parseProbeResponse (
        probeResultLine (nonce, "first line\nsecond line"), nonce);
    REQUIRE (multiline.valid);
    CHECK (multiline.error == "first line\nsecond line");
}

TEST_CASE ("default and one-sided device setups survive strict probe framing",
           "[audiostartup]")
{
    const juce::File executable ("/Applications/Mosh.app/Contents/MacOS/Mosh");
    const juce::String nonce ("fedcba9876543210fedcba9876543210");

    SECTION ("system default")
    {
        auto args = probeChildArguments (executable, nonce, nullptr, 2, 2, 0);
        REQUIRE (args.size() == 7);
        CHECK (args[3] == "default");
        CHECK_FALSE (args.contains (juce::String(), false));
        args.remove (0);
        const auto request = parseProbeRequest (args);
        REQUIRE (request.valid);
        CHECK (request.useDefaultSetup);
        CHECK (request.setupXml.isEmpty());
    }

    for (const auto inputOnly : { false, true })
    {
        juce::XmlElement setup ("DEVICESETUP");
        setup.setAttribute (inputOnly ? "audioInputDeviceName"
                                      : "audioOutputDeviceName",
                            inputOnly ? "BlackHole 2ch"
                                      : "MacBook Pro Speakers");
        auto args = probeChildArguments (executable, nonce, &setup, 2, 2, 0);
        REQUIRE (args.size() == 7);
        CHECK_FALSE (args.contains (juce::String(), false));
        args.remove (0);
        const auto request = parseProbeRequest (args);
        REQUIRE (request.valid);
        const auto decoded = juce::XmlDocument::parse (request.setupXml);
        REQUIRE (decoded != nullptr);
        CHECK (decoded->getStringAttribute ("audioOutputDeviceName")
               == (inputOnly ? "" : "MacBook Pro Speakers"));
        CHECK (decoded->getStringAttribute ("audioInputDeviceName")
               == (inputOnly ? "BlackHole 2ch" : ""));
    }
}

TEST_CASE ("a timed-out process is killed before the caller resumes", "[audiostartup]")
{
    const auto result = runProbeProcess ({ "/bin/sleep", "10" }, 50);
    CHECK (result.status == ProbeProcessStatus::timedOut);
}
