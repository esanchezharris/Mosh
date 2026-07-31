#pragma once

#include <juce_core/juce_core.h>

/** AUD-017 — the PURE parts of the bounded audio-device startup.

    Opening a CoreAudio device is a synchronous IPC to coreaudiod that can block
    forever when the HAL wedges (see docs/auto-loop/backlog.jsonl AUD-017: the app
    launched, showed no window, and sat at 0% CPU indefinitely). MoshEngine therefore
    performs the open in a child process and waits with a timeout. If CoreAudio
    wedges, the whole child is terminated so no blocked HAL call remains in Mosh.

    The decision inputs (how long to wait, what to call the device, what to tell the
    user) live here so they are unit-testable WITHOUT the engine — `MoshTests` is
    engine-free and cannot link MoshEngine.cpp. */
namespace mosh::audiostartup
{
    /** How long the message thread waits for the child before giving up. Long enough
        that a slow-but-healthy aggregate/USB interface still opens normally; short
        enough that a wedged HAL costs seconds, not the session. */
    inline constexpr int kDefaultTimeoutMs = 5000;
    inline constexpr int kMinTimeoutMs     = 250;
    inline constexpr int kMaxTimeoutMs     = 60000;
    inline constexpr auto kProbeResultPrefix = "MOSH_AUDIO_PROBE_RESULT ";

    /** Resolve the timeout from a raw MOSH_AUDIO_OPEN_TIMEOUT_MS value. Empty,
        non-numeric, or <= 0 all mean "use the default" — a typo must never turn the
        bound OFF, which would restore the very hang this exists to prevent. */
    inline int timeoutMsFromEnv (const juce::String& raw)
    {
        const auto v = raw.trim().getIntValue();
        return v > 0 ? juce::jlimit (kMinTimeoutMs, kMaxTimeoutMs, v) : kDefaultTimeoutMs;
    }

    /** The output / input device names a saved JUCE AudioDeviceManager setup asks for
        (the attributes createStateXml writes). Empty means "whatever the system
        default is" — which is exactly what the probe should then open. */
    inline juce::String outputNameFromSetup (const juce::XmlElement* setupXml)
    {
        if (setupXml == nullptr)
            return {};
        auto out = setupXml->getStringAttribute ("audioOutputDeviceName");
        return out.isNotEmpty() ? out : setupXml->getStringAttribute ("audioDeviceName");
    }

    inline juce::String inputNameFromSetup (const juce::XmlElement* setupXml)
    {
        return setupXml != nullptr ? setupXml->getStringAttribute ("audioInputDeviceName")
                                   : juce::String();
    }

    /** Name the device we were trying to open, for the error the user actually reads.
        A setup with no explicit names is the system default. */
    inline juce::String deviceLabel (const juce::XmlElement* setupXml)
    {
        const auto out = outputNameFromSetup (setupXml);
        const auto in  = inputNameFromSetup (setupXml);

        if (out.isNotEmpty() && in.isNotEmpty() && in != out)
            return "\"" + out + "\" (input \"" + in + "\")";
        if (out.isNotEmpty())
            return "\"" + out + "\"";
        if (in.isNotEmpty())
            return "input \"" + in + "\"";

        return "the system default audio device";
    }

    /** The message surfaced as snapshot.session.audioDeviceError. Names the device,
        says what state the app is in, and says what to do — an error the user can act
        on, versus today's silent hang. */
    inline juce::String timeoutMessage (const juce::String& device, int timeoutMs)
    {
        return "Audio device " + device + " did not open within "
             + juce::String (timeoutMs / 1000.0, 1) + "s. Running WITHOUT audio — "
             "playback and recording are off. Disconnect or change the device in "
             "system audio settings, then "
             "press Retry.";
    }

    inline juce::StringArray probeChildArguments (const juce::File& executable,
                                                  const juce::String& output,
                                                  const juce::String& input,
                                                  int stallMs)
    {
        return { executable.getFullPathName(),
                 "--audio-probe",
                 "--audio-probe-output", output,
                 "--audio-probe-input", input,
                 "--audio-probe-stall-ms", juce::String (stallMs) };
    }

    inline juce::String probeArgumentValue (const juce::StringArray& args,
                                            const juce::String& option)
    {
        const auto index = args.indexOf (option);
        return juce::isPositiveAndBelow (index + 1, args.size()) ? args[index + 1]
                                                                 : juce::String();
    }

    inline juce::String probeResultLine (const juce::String& error)
    {
        return juce::String (kProbeResultPrefix)
             + error.replace ("\r", " ").replace ("\n", " ") + "\n";
    }

    inline juce::String probeErrorFromOutput (const juce::String& output)
    {
        const auto marker = output.indexOf (kProbeResultPrefix);
        if (marker < 0)
            return {};
        const auto start = marker + (int) juce::String (kProbeResultPrefix).length();
        const auto end = output.indexOfChar (start, '\n');
        return output.substring (start, end >= 0 ? end : output.length()).trimEnd();
    }

    inline bool shouldEnumerateDeviceTypes (bool audioOpen)
    {
        return audioOpen;
    }

    juce::String runProbeChild (const juce::StringArray& args);
} // namespace mosh::audiostartup
