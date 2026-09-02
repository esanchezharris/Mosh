// AUD-017 — the pure decision layer of the bounded audio-device startup.
//
// The blocking part (a CoreAudio open in a killable child process with a timeout)
// needs real hardware and lives in MoshEngine.cpp, which MoshTests deliberately
// cannot link. What IS testable here is everything that decides how long to wait
// and what the user is told — and those are exactly the parts that would silently
// rot: a timeout that a typo turns off, or an error message that names nothing.

#include <catch2/catch_test_macros.hpp>

#include "engine/AudioDeviceStartup.h"
#include "app/MacMicrophonePermission.h"
#include "util/Env.h"

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

TEST_CASE ("normal launch projects a saved setup to output only", "[audiostartup][privacy]")
{
    juce::XmlElement saved ("DEVICESETUP");
    saved.setAttribute ("deviceType", "CoreAudio");
    saved.setAttribute ("audioOutputDeviceName", "MacBook Pro Speakers");
    saved.setAttribute ("audioInputDeviceName", "MacBook Pro Microphone");
    saved.setAttribute ("audioDeviceInChans", "11");
    saved.setAttribute ("audioDeviceOutChans", "11");
    saved.setAttribute ("audioDeviceRate", 48000.0);
    saved.createNewChildElement ("MIDIINPUT")->setAttribute ("name", "Keyboard");

    const auto projected = outputOnlySetup (&saved);

    REQUIRE (projected != nullptr);
    CHECK (projected->getStringAttribute ("audioOutputDeviceName")
           == "MacBook Pro Speakers");
    CHECK (projected->getStringAttribute ("audioInputDeviceName").isEmpty());
    CHECK (projected->getStringAttribute ("audioDeviceInChans") == "0");
    CHECK (projected->getStringAttribute ("audioDeviceOutChans") == "11");
    CHECK (projected->getDoubleAttribute ("audioDeviceRate") == 48000.0);
    CHECK (projected->getChildByName ("MIDIINPUT") != nullptr);
    CHECK (saved.getStringAttribute ("audioInputDeviceName")
           == "MacBook Pro Microphone");
}

TEST_CASE ("legacy duplex setup keeps its output while deferring its input",
           "[audiostartup][privacy]")
{
    juce::XmlElement saved ("DEVICESETUP");
    saved.setAttribute ("audioDeviceName", "Scarlett 2i2");
    saved.setAttribute ("audioDeviceInChans", "11");

    CHECK (inputNameFromSetup (&saved) == "Scarlett 2i2");
    const auto projected = outputOnlySetup (&saved);

    REQUIRE (projected != nullptr);
    CHECK_FALSE (projected->hasAttribute ("audioDeviceName"));
    CHECK (projected->getStringAttribute ("audioOutputDeviceName") == "Scarlett 2i2");
    CHECK (projected->getStringAttribute ("audioInputDeviceName").isEmpty());
    CHECK (projected->getStringAttribute ("audioDeviceInChans") == "0");
}

TEST_CASE ("record arm activates audio input only for audio routes", "[audiostartup][privacy]")
{
    using mosh::audiostartup::shouldActivateAudioInputForArm;

    CHECK_FALSE (shouldActivateAudioInputForArm (false, false, false));
    CHECK_FALSE (shouldActivateAudioInputForArm (true, true, false));
    CHECK_FALSE (shouldActivateAudioInputForArm (true, false, true));
    CHECK (shouldActivateAudioInputForArm (true, false, false));
}

TEST_CASE ("explicit non-audio inputs fail closed before microphone activation",
           "[audiostartup][privacy]")
{
    using mosh::audiostartup::explicitInputBlocksAudioActivation;

    CHECK_FALSE (explicitInputBlocksAudioActivation ({}, {}, false));
    CHECK_FALSE (explicitInputBlocksAudioActivation ("built-in-mic", "wave", false));
    CHECK (explicitInputBlocksAudioActivation ("keyboard", "midi", true));
    CHECK (explicitInputBlocksAudioActivation ("disconnected", {}, false));
    CHECK (explicitInputBlocksAudioActivation ("keyboard", "wave", true));
}

TEST_CASE ("an unknown setter route remains microphone cold when armed",
           "[audiostartup][privacy]")
{
    const auto storedKind = explicitInputKind (false, false);

    CHECK (storedKind == "unknown");
    CHECK (explicitInputBlocksAudioActivation ("not-a-real-device", storedKind, false));
    CHECK (explicitInputKind (true, false) == "wave");
    CHECK (explicitInputKind (true, true) == "midi");
}

TEST_CASE ("legacy wave selections survive output-only startup",
           "[audiostartup][privacy]")
{
    const auto availableWave = effectiveExplicitInputKind (
        "wavein_live", {}, true, false);
    const auto unavailableLegacyWave = effectiveExplicitInputKind (
        "wavein_1a2b3c", {}, false, false);
    const auto unavailableUnknown = effectiveExplicitInputKind (
        "not-a-real-device", {}, false, false);

    CHECK (availableWave == "wave");
    CHECK_FALSE (explicitInputBlocksAudioActivation ("legacy-wave", availableWave, false));
    CHECK (unavailableLegacyWave == "wave");
    CHECK_FALSE (explicitInputBlocksAudioActivation (
        "wavein_1a2b3c", unavailableLegacyWave, false));
    CHECK (unavailableUnknown == "unknown");
    CHECK (explicitInputBlocksAudioActivation (
        "not-a-real-device", unavailableUnknown, false));
    CHECK (effectiveExplicitInputKind (
        "wavein_live", "unknown", true, false) == "wave");
    CHECK (effectiveExplicitInputKind (
        "midiin_live", "unknown", true, true) == "midi");
}

TEST_CASE ("the probed input channel mask is reused for the live open",
           "[audiostartup][privacy]")
{
    const auto channels = inputChannelMaskForOpen (2);

    CHECK (channels.toString (2) == "11");
    CHECK (channels.countNumberOfSetBits() == 2);
    CHECK (inputChannelMaskForOpen (0).isZero());
}

TEST_CASE ("deferred activation retains the preferred input and falls back to CoreAudio",
           "[audiostartup][privacy]")
{
    const juce::StringArray inputs { "Emilio's iPhone Microphone",
                                     "MacBook Pro Microphone" };

    CHECK (inputNameForActivation ("BlackHole 2ch", "MacBook Pro Microphone",
                                   inputs, 1) == "BlackHole 2ch");
    CHECK (inputNameForActivation ({}, "MacBook Pro Microphone",
                                   inputs, 0) == "MacBook Pro Microphone");
    CHECK (inputNameForActivation ({}, "Missing input",
                                   inputs, 1) == "MacBook Pro Microphone");
    CHECK (inputNameForActivation ({}, {}, inputs, -1)
           == "Emilio's iPhone Microphone");
    CHECK (inputNameForActivation ({}, {}, {}, -1).isEmpty());
}

TEST_CASE ("microphone denial returns a recoverable recording error",
           "[audiostartup][privacy]")
{
    using mosh::mac::MicrophonePermissionStatus;
    using mosh::mac::microphonePermissionError;

    CHECK (microphonePermissionError (MicrophonePermissionStatus::granted).isEmpty());
    CHECK (microphonePermissionError (MicrophonePermissionStatus::denied)
               .contains ("System Settings"));
    CHECK (microphonePermissionError (MicrophonePermissionStatus::restricted)
               .contains ("not available"));
    CHECK (microphonePermissionError (MicrophonePermissionStatus::timedOut)
               .contains ("did not finish"));
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

TEST_CASE ("physical recovery requires reacquisition and live callbacks",
           "[audiostartup][recovery]")
{
    RecoveryGateEvidence evidence;
    evidence.degradedBeforeRetry = true;

    CHECK_FALSE (physicalRecoveryPassed (evidence));

    evidence.retryOk = true;
    evidence.audioEnabledAfterRetry = true;
    evidence.deviceTypeCountAfterRetry = 1;
    evidence.liveAudioFailures = 0;

    CHECK (physicalRecoveryPassed (evidence));
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
    const auto spoofThenReal =
        parseProbeResponse (spoof + probeResultLine (nonce, "real"), nonce);
    REQUIRE (spoofThenReal.valid);
    CHECK_FALSE (spoofThenReal.error.isEmpty());
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

TEST_CASE ("persisted device setup is bounded before parent parsing", "[audiostartup]")
{
    const auto file = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getNonexistentChildFile ("mosh-audio-device-setup", ".xml");

    SECTION ("a valid file at the byte ceiling is accepted")
    {
        juce::String xml ("<DEVICESETUP/>");
        xml += juce::String::repeatedString (
            " ", static_cast<int> (kMaxProbeSetupBytes - xml.getNumBytesAsUTF8()));
        REQUIRE (xml.getNumBytesAsUTF8() == kMaxProbeSetupBytes);
        REQUIRE (file.replaceWithData (xml.toRawUTF8(), xml.getNumBytesAsUTF8()));

        auto loaded = loadBoundedDeviceSetup (file);
        CHECK (loaded.valid);
        REQUIRE (loaded.xml != nullptr);
        CHECK (loaded.xml->hasTagName ("DEVICESETUP"));
    }

    SECTION ("oversized input is rejected before allocation and parse")
    {
        juce::MemoryBlock bytes (kMaxProbeSetupBytes + 1, true);
        REQUIRE (file.replaceWithData (bytes.getData(), bytes.getSize()));
        CHECK_FALSE (loadBoundedDeviceSetup (file).valid);
    }

    SECTION ("malformed XML, invalid UTF-8, and a wrong root fail closed")
    {
        for (const auto xml : { juce::String ("<DEVICESETUP>"),
                                juce::String ("<NOTDEVICE/>") })
        {
            REQUIRE (file.replaceWithData (xml.toRawUTF8(), xml.getNumBytesAsUTF8()));
            CHECK_FALSE (loadBoundedDeviceSetup (file).valid);
        }

        const unsigned char invalidUtf8[] = {
            '<', 'D', 'E', 'V', 'I', 'C', 'E', 'S', 'E', 'T', 'U', 'P', '>',
            0xff,
            '<', '/', 'D', 'E', 'V', 'I', 'C', 'E', 'S', 'E', 'T', 'U', 'P', '>'
        };
        REQUIRE (file.replaceWithData (invalidUtf8, sizeof (invalidUtf8)));
        CHECK_FALSE (loadBoundedDeviceSetup (file).valid);
    }

    file.deleteFile();
}

TEST_CASE ("device setup XML refuses DTD entity expansion before parsing",
           "[audiostartup]")
{
    const juce::String entityBomb (
        "<?xml version=\"1.0\"?>\n"
        "<!DOCTYPE DEVICESETUP [\n"
        "<!ENTITY a \"1234567890\">\n"
        "<!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;\">\n"
        "<!ENTITY c \"&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;\">\n"
        "<!ENTITY d \"&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;\">\n"
        "<!ENTITY e \"&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;\">\n"
        "]>\n"
        "<DEVICESETUP audioOutputDeviceName=\"&e;\"/>");

    REQUIRE (entityBomb.getNumBytesAsUTF8() < kMaxProbeSetupBytes);
    CHECK_FALSE (isSafeDeviceSetupXmlText (entityBomb));
    CHECK_FALSE (parseBoundedDeviceSetup (
        entityBomb.toRawUTF8(),
        static_cast<size_t> (entityBomb.getNumBytesAsUTF8())).valid);

    const auto encodedBomb = "xml:" + juce::Base64::toBase64 (
        entityBomb.toRawUTF8(),
        static_cast<size_t> (entityBomb.getNumBytesAsUTF8()));
    const juce::StringArray childArgs {
        "--audio-probe",
        "0123456789abcdef0123456789abcdef",
        encodedBomb,
        "2",
        "2",
        "0"
    };
    CHECK_FALSE (parseProbeRequest (childArgs).valid);
}

TEST_CASE ("probe setup serialization is parent-bounded", "[audiostartup]")
{
    juce::XmlElement wrongRoot ("NOTDEVICE");
    CHECK (probeSetupArgument (&wrongRoot).isEmpty());
    CHECK (probeChildArguments ({ "/Applications/Mosh.app/Contents/MacOS/Mosh" },
                                "fedcba9876543210fedcba9876543210",
                                &wrongRoot, 2, 2, 0).isEmpty());

    juce::XmlElement oversized ("DEVICESETUP");
    oversized.setAttribute (
        "audioOutputDeviceName",
        juce::String::repeatedString ("x", static_cast<int> (kMaxProbeSetupBytes)));
    CHECK (probeSetupArgument (&oversized).isEmpty());
    CHECK (probeChildArguments ({ "/Applications/Mosh.app/Contents/MacOS/Mosh" },
                                "fedcba9876543210fedcba9876543210",
                                &oversized, 2, 2, 0).isEmpty());
}

TEST_CASE ("probe argv stays inside a conservative Windows command envelope",
           "[audiostartup]")
{
    const juce::String nonce ("fedcba9876543210fedcba9876543210");
    juce::XmlElement setup ("DEVICESETUP");
    setup.setAttribute ("audioOutputDeviceName", "MacBook Pro Speakers");

    const auto args = probeChildArguments (
        { "/Applications/Mosh Audit.app/Contents/MacOS/Mosh" },
        nonce, &setup, 2, 2, 60000);
    REQUIRE (args.size() == 7);

    size_t commandChars = 0;
    for (const auto& arg : args)
        commandChars += static_cast<size_t> (arg.length()) + 3;
    CHECK (commandChars <= static_cast<size_t> (kMaxProbeCommandLineChars));
    CHECK (kMaxProbeCommandLineChars < 32767);

    const auto oversizedExecutable = juce::String ("/")
        + juce::String::repeatedString (
            "x", kMaxProbeCommandLineChars)
        + "/Mosh.exe";
    CHECK (probeChildArguments ({ oversizedExecutable }, nonce, &setup,
                                2, 2, 60000).isEmpty());
}

TEST_CASE ("audio probe timeout child fixture", "[audiostartup-child]")
{
    const auto heartbeat = juce::SystemStats::getEnvironmentVariable (
        "MOSH_AUDIO_TEST_HEARTBEAT", {});
    if (heartbeat.isEmpty())
        return;

    const juce::File heartbeatFile (heartbeat);
    for (int i = 0; i < 1000; ++i)
    {
        heartbeatFile.appendText ("x");
        juce::Thread::sleep (10);
    }
}

TEST_CASE ("a timed-out process is killed before the caller resumes", "[audiostartup]")
{
    // The subject here is the kill, and the heartbeat is the independent evidence for
    // it: a child that was demonstrably writing before the timeout must write nothing
    // after runProbeProcess returns. That evidence only means something if the child
    // was actually caught mid-write, so "it wrote at least once" is a PRECONDITION,
    // not the claim — and a fixed budget races the child's own process startup (exec +
    // JUCE static init + Catch2 registration) for it. Measured on this Mac: ~35-80ms
    // idle, but past 250ms once several processes start at once, at which point the
    // child is killed before its first appendText and the file never exists. That was
    // a ~1-in-28 flake failing on the precondition while the kill itself was fine.
    //
    // So establish the precondition instead of gambling on it: escalate the budget
    // until the child has demonstrably started writing, then assert the kill. A quiet
    // machine still pays only the first 250ms; a loaded one buys the margin it needs.
    // The cap stays well under the child fixture's own ~10s lifetime (1000 x 10ms) so
    // that every attempt is still a kill and never a child exiting on its own.
    juce::File heartbeat;
    ProbeProcessResult result;
    juce::int64 sizeAfterReturn = 0;

    for (int timeoutMs = 250; timeoutMs <= 4000; timeoutMs *= 2)
    {
        heartbeat = juce::File::getSpecialLocation (juce::File::tempDirectory)
                        .getNonexistentChildFile ("mosh-audio-probe-heartbeat", ".txt");
        mosh::setEnvVar ("MOSH_AUDIO_TEST_HEARTBEAT",
                         heartbeat.getFullPathName().toRawUTF8());
        result = runProbeProcess (
            { juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                  .getFullPathName(),
              "[audiostartup-child]" },
            timeoutMs);
        mosh::unsetEnvVar ("MOSH_AUDIO_TEST_HEARTBEAT");

        sizeAfterReturn = heartbeat.getSize();
        if (heartbeat.existsAsFile() && sizeAfterReturn > 0)
            break;

        // Killed before it could write, so this attempt proves nothing either way.
        heartbeat.deleteFile();
    }

    CHECK (result.status == ProbeProcessStatus::timedOut);
    REQUIRE (heartbeat.existsAsFile());
    REQUIRE (sizeAfterReturn > 0);
    juce::Thread::sleep (100);
    CHECK (heartbeat.getSize() == sizeAfterReturn);
    heartbeat.deleteFile();
}
