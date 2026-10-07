#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <atomic>
#include <functional>
#include <memory>
#include <optional>

// Low-latency handling of "input on one device, output on another" — the default laptop
// setup (built-in microphone + headphones are two CoreAudio devices).
//
// JUCE joins two devices with AudioIODeviceCombiner: each runs its own IOProc, the user
// callback runs inside the INPUT device's, and a FIFO carries its output to the output
// device's. JUCE delays that FIFO by
//     bufferSize + reportedInputLatency + reportedOutputLatency
// measured from the input buffer's capture timestamp to the output buffer's play
// timestamp, so both devices' latencies are paid TWICE and three buffers are paid where
// one device pays two. With a MacBook Pro microphone (1513 samples at 48 kHz) and
// headphones (170) at a 128-sample buffer that is about 76 ms from mouth to ear; the
// same hardware as one device needs about 40 ms. It also makes the device under-report
// its round trip by the same 36 ms, so recorded takes land late.
//
// The fix is the one CoreAudio provides: an aggregate device. Mosh creates a PRIVATE one
// (visible only to this process, gone when it exits) from the two devices and opens it as
// a single duplex device, so there is one IOProc and no FIFO. CombinedDeviceProxy then
// presents that aggregate as what the user asked for: the output device's outputs and the
// input device's inputs, under the output device's name. Nothing above the device type
// (device names, persistence, the Settings pickers) knows an aggregate exists.

namespace mosh::audio
{
/** Every private aggregate Mosh creates is named with this prefix, and no device list
    Mosh shows ever includes a name that starts with it. */
inline constexpr const char* kPrivateAggregatePrefix = "Mosh I/O: ";

[[nodiscard]] inline bool isPrivateAggregateName (const juce::String& deviceName)
{
    return deviceName.startsWith (kPrivateAggregatePrefix);
}

/** How the proxy's channels sit inside the aggregate. The aggregate lists the OUTPUT
    device first, so its outputs lead; its inputs (if it has any) lead the input list
    too, and the input device's channels follow them. */
struct CombinedLayout
{
    int numOutputs = 0;  // the output device's output channels: aggregate outputs [0, numOutputs)
    int inputOffset = 0; // the output device's own input channels, skipped
    int numInputs = 0;   // the input device's input channels: aggregate inputs [inputOffset, inputOffset + numInputs)
};

/** `outer` input channels (0-based within the input device) as aggregate channels. */
[[nodiscard]] juce::BigInteger toAggregateInputs (const juce::BigInteger& outer, const CombinedLayout&);
/** The inverse: aggregate input channels as the input device's own. */
[[nodiscard]] juce::BigInteger fromAggregateInputs (const juce::BigInteger& aggregate, const CombinedLayout&);
/** Output channels limited to the output device's. */
[[nodiscard]] juce::BigInteger toAggregateOutputs (const juce::BigInteger& outer, const CombinedLayout&);

/** One duplex device (in practice a private aggregate) presented as an output device's
    outputs plus an input device's inputs. Owns the inner device; `releaseInner` runs
    after the inner device is destroyed (it destroys the aggregate).

    `extraInputLatency` corrects the inner device's reported input latency. JUCE reads a
    CoreAudio device's stream latency from its FIRST input stream; in an aggregate whose
    output device has inputs of its own, that is the wrong stream (a MacBook microphone
    behind a headset's inputs would be reported 1439 samples short, and takes would land
    30 ms late). It is asked once per open/start, on the calling thread. */
class CombinedDeviceProxy final : public juce::AudioIODevice,
                                  private juce::AudioIODeviceCallback
{
public:
    CombinedDeviceProxy (const juce::String& outputDeviceName, const juce::String& inputDeviceName,
                         const juce::String& typeName, std::unique_ptr<juce::AudioIODevice> innerDevice,
                         CombinedLayout, std::function<void()> releaseInner = {},
                         std::function<int()> extraInputLatency = {});
    ~CombinedDeviceProxy() override;

    [[nodiscard]] const juce::String& getOutputDeviceName() const noexcept { return outputName; }
    [[nodiscard]] const juce::String& getInputDeviceName() const noexcept  { return inputName; }

    juce::StringArray getOutputChannelNames() override;
    juce::StringArray getInputChannelNames() override;
    std::optional<juce::BigInteger> getDefaultOutputChannels() const override;
    std::optional<juce::BigInteger> getDefaultInputChannels() const override;
    juce::Array<double> getAvailableSampleRates() override        { return inner->getAvailableSampleRates(); }
    juce::Array<int> getAvailableBufferSizes() override           { return inner->getAvailableBufferSizes(); }
    int getDefaultBufferSize() override                           { return inner->getDefaultBufferSize(); }
    juce::String open (const juce::BigInteger& inputChannels, const juce::BigInteger& outputChannels,
                       double sampleRate, int bufferSizeSamples) override;
    void close() override                                         { inner->close(); }
    bool isOpen() override                                        { return inner->isOpen(); }
    void start (juce::AudioIODeviceCallback*) override;
    void stop() override;
    bool isPlaying() override                                     { return inner->isPlaying(); }
    juce::String getLastError() override                          { return inner->getLastError(); }
    int getCurrentBufferSizeSamples() override                    { return inner->getCurrentBufferSizeSamples(); }
    double getCurrentSampleRate() override                        { return inner->getCurrentSampleRate(); }
    int getCurrentBitDepth() override                             { return inner->getCurrentBitDepth(); }
    juce::BigInteger getActiveOutputChannels() const override;
    juce::BigInteger getActiveInputChannels() const override;
    int getOutputLatencyInSamples() override                      { return inner->getOutputLatencyInSamples(); }
    int getInputLatencyInSamples() override
    {
        return inner->getInputLatencyInSamples() + inputLatencyExtra.load (std::memory_order_relaxed);
    }
    juce::AudioWorkgroup getWorkgroup() const override            { return inner->getWorkgroup(); }
    bool hasControlPanel() const override                         { return inner->hasControlPanel(); }
    bool showControlPanel() override                              { return inner->showControlPanel(); }
    bool setAudioPreprocessingEnabled (bool enabled) override     { return inner->setAudioPreprocessingEnabled (enabled); }
    int getXRunCount() const noexcept override                    { return inner->getXRunCount(); }

private:
    // The inner device calls back with ITSELF as the device; whoever started the proxy
    // must be told about the proxy instead.
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData, int numInputChannels,
                                           float* const* outputChannelData, int numOutputChannels,
                                           int numSamples, const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice*) override;
    void audioDeviceStopped() override;
    void audioDeviceError (const juce::String& errorMessage) override;

    const juce::String outputName, inputName;
    std::unique_ptr<juce::AudioIODevice> inner;
    const CombinedLayout layout;
    std::function<void()> release;
    std::function<int()> extraInputLatency;
    std::atomic<int> inputLatencyExtra { 0 };
    std::atomic<juce::AudioIODeviceCallback*> target { nullptr };

    void refreshInputLatency();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CombinedDeviceProxy)
};

/** How the currently open device joins its input and output, for diagnostics and the
    Settings read-out. */
enum class CombineMode
{
    none,      // no device, or a single device doing one direction
    single,    // one physical device for both directions
    aggregate, // two devices as one private CoreAudio aggregate (this file)
    fifo       // two devices joined by JUCE's FIFO (the fallback)
};

[[nodiscard]] CombineMode combineModeOf (juce::AudioIODevice* device, const juce::String& inputDeviceName,
                                         const juce::String& outputDeviceName);
[[nodiscard]] const char* combineModeName (CombineMode) noexcept;

/** Estimated microphone-to-headphone delay in samples, from what the open device reports
    (`getInputLatencyInSamples()` / `getOutputLatencyInSamples()`, each of which already
    includes one buffer on a CoreAudio device). A single or aggregate device costs exactly
    their sum. JUCE's FIFO reports that same sum but costs both device latencies again:
    twice the sum less the three buffers it contains (and less the devices' safety
    offsets, which cannot be seen from here, so this over-states it by a few ms). Plugin
    latency on the monitored track is extra. */
[[nodiscard]] int estimatedRoundTripSamples (CombineMode, int reportedInputLatency, int reportedOutputLatency,
                                             int bufferSize) noexcept;

/** One line for the log about the open device: what is joined to what and how, the rate
    and buffer, what it reports, and the estimate above in ms. Empty with no device. */
[[nodiscard]] juce::String describeOpenDevice (juce::AudioIODevice* device, const juce::String& inputDeviceName,
                                               const juce::String& outputDeviceName);

/** macOS: JUCE's CoreAudio device type, except that two different devices are opened as
    one private aggregate (falling back to JUCE's own path if that fails, or when
    MOSH_AUDIO_NO_AGGREGATE is set). Returns nullptr on other platforms. */
[[nodiscard]] std::unique_ptr<juce::AudioIODeviceType> createCoreAudioTypeWithPrivateAggregates();
}
