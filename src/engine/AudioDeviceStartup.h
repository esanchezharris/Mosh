#pragma once

#include <juce_core/juce_core.h>

/** AUD-017 — the engine-independent parts of guarded audio-device startup.

    Opening a CoreAudio device is a synchronous IPC to coreaudiod that can block
    forever when the HAL wedges (see docs/auto-loop/backlog.jsonl AUD-017: the app
    launched, showed no window, and sat at 0% CPU indefinitely). MoshEngine therefore
    preflights the exact setup in a child process and waits with a timeout. If
    CoreAudio wedges, the whole child is terminated so no blocked HAL call remains
    in Mosh; the in-process Tracktion initialisation runs only after that exact
    preflight succeeds.

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

    inline juce::String probeDeviceTypeName()
    {
       #if JUCE_MAC
        return "CoreAudio";
       #elif JUCE_WINDOWS
        return "Windows Audio";
       #else
        return {};
       #endif
    }

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

    struct ProbeRequest
    {
        bool valid = false;
        juce::String nonce;
        juce::String output;
        juce::String input;
        int stallMs = 0;
    };

    inline bool isValidProbeNonce (const juce::String& nonce)
    {
        return juce::isPositiveAndBelow (nonce.length(), 65)
            && nonce.length() >= 16
            && nonce.containsOnly ("0123456789abcdefABCDEF-");
    }

    inline juce::StringArray probeChildArguments (const juce::File& executable,
                                                  const juce::String& nonce,
                                                  const juce::String& output,
                                                  const juce::String& input,
                                                  int stallMs)
    {
        return { executable.getFullPathName(), "--audio-probe", nonce, output, input,
                 juce::String (stallMs) };
    }

    inline ProbeRequest parseProbeRequest (const juce::StringArray& args)
    {
        ProbeRequest request;
        const auto marker = args.indexOf ("--audio-probe");
        if (marker < 0 || args.size() != marker + 5)
            return request;

        const auto stall = args[marker + 4];
        if (! isValidProbeNonce (args[marker + 1])
            || stall.isEmpty()
            || ! stall.containsOnly ("0123456789")
            || stall.length() > 8)
            return request;

        request.valid = true;
        request.nonce = args[marker + 1];
        request.output = args[marker + 2];
        request.input = args[marker + 3];
        request.stallMs = juce::jlimit (0, kMaxTimeoutMs, stall.getIntValue());
        return request;
    }

    inline juce::String probeResultLine (const juce::String& nonce,
                                         const juce::String& error)
    {
        return juce::String (kProbeResultPrefix) + nonce + " "
             + juce::JSON::toString (juce::var (error), false) + "\n";
    }

    struct ProbeResponse
    {
        bool valid = false;
        juce::String error;
    };

    inline ProbeResponse parseProbeResponse (const juce::String& output,
                                             const juce::String& nonce)
    {
        ProbeResponse response;
        if (! isValidProbeNonce (nonce))
            return response;

        const auto expected = juce::String (kProbeResultPrefix) + nonce + " ";
        juce::String payload;
        int matches = 0;
        for (auto& line : juce::StringArray::fromLines (output))
            if (line.startsWith (expected))
            {
                ++matches;
                payload = line.substring (expected.length());
            }

        if (matches != 1)
            return response;

        const auto decoded = juce::JSON::fromString (payload);
        if (! decoded.isString()
            || juce::JSON::toString (decoded, false) != payload)
            return response;

        response.valid = true;
        response.error = decoded.toString();
        return response;
    }

    enum class ProbeProcessStatus
    {
        finished,
        failedToStart,
        timedOut,
        failedToTerminate
    };

    struct ProbeProcessResult
    {
        ProbeProcessStatus status = ProbeProcessStatus::failedToStart;
        juce::String output;
        juce::uint32 exitCode = 0;
    };

    inline ProbeProcessResult runProbeProcess (const juce::StringArray& arguments,
                                               int timeoutMs)
    {
        ProbeProcessResult result;
        juce::ChildProcess process;
        if (! process.start (arguments))
            return result;

        if (process.waitForProcessToFinish (timeoutMs))
        {
            result.status = ProbeProcessStatus::finished;
            result.exitCode = process.getExitCode();
            result.output = process.readAllProcessOutput();
            return result;
        }

        const bool killed = process.kill();
        const bool reaped = process.waitForProcessToFinish (1000);
        result.status = (killed && reaped && ! process.isRunning())
                            ? ProbeProcessStatus::timedOut
                            : ProbeProcessStatus::failedToTerminate;
        return result;
    }

    inline bool shouldEnumerateDeviceTypes (bool audioOpen)
    {
        return audioOpen;
    }

    juce::String runProbeChild (const ProbeRequest& request);
} // namespace mosh::audiostartup
