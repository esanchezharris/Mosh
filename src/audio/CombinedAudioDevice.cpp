#include "CombinedAudioDevice.h"

namespace mosh::audio
{
juce::BigInteger toAggregateInputs (const juce::BigInteger& outer, const CombinedLayout& layout)
{
    juce::BigInteger aggregate;
    for (int i = 0; i < layout.numInputs; ++i)
        if (outer[i])
            aggregate.setBit (layout.inputOffset + i);
    return aggregate;
}

juce::BigInteger fromAggregateInputs (const juce::BigInteger& aggregate, const CombinedLayout& layout)
{
    juce::BigInteger outer;
    for (int i = 0; i < layout.numInputs; ++i)
        if (aggregate[layout.inputOffset + i])
            outer.setBit (i);
    return outer;
}

juce::BigInteger toAggregateOutputs (const juce::BigInteger& outer, const CombinedLayout& layout)
{
    juce::BigInteger aggregate;
    for (int i = 0; i < layout.numOutputs; ++i)
        if (outer[i])
            aggregate.setBit (i);
    return aggregate;
}

CombinedDeviceProxy::CombinedDeviceProxy (const juce::String& outputDeviceName, const juce::String& inputDeviceName,
                                          const juce::String& typeName, std::unique_ptr<juce::AudioIODevice> innerDevice,
                                          CombinedLayout l, std::function<void()> releaseInner,
                                          std::function<int()> extraInputLatencyHook)
    // JUCE names a two-device combination after its output device; so does this.
    : juce::AudioIODevice (outputDeviceName, typeName),
      outputName (outputDeviceName), inputName (inputDeviceName),
      inner (std::move (innerDevice)), layout (l), release (std::move (releaseInner)),
      extraInputLatency (std::move (extraInputLatencyHook))
{
    jassert (inner != nullptr);
}

CombinedDeviceProxy::~CombinedDeviceProxy()
{
    stop();
    inner->close();
    inner.reset();
    if (release)
        release();
}

juce::StringArray CombinedDeviceProxy::getOutputChannelNames()
{
    auto names = inner->getOutputChannelNames();
    names.removeRange (layout.numOutputs, names.size());
    return names;
}

juce::StringArray CombinedDeviceProxy::getInputChannelNames()
{
    const auto all = inner->getInputChannelNames();
    juce::StringArray names;
    for (int i = 0; i < layout.numInputs; ++i)
        names.add (all[layout.inputOffset + i]);
    return names;
}

std::optional<juce::BigInteger> CombinedDeviceProxy::getDefaultOutputChannels() const
{
    if (const auto channels = inner->getDefaultOutputChannels())
        if (const auto mapped = toAggregateOutputs (*channels, layout); ! mapped.isZero())
            return mapped;
    return {};
}

std::optional<juce::BigInteger> CombinedDeviceProxy::getDefaultInputChannels() const
{
    if (const auto channels = inner->getDefaultInputChannels())
        if (const auto mapped = fromAggregateInputs (*channels, layout); ! mapped.isZero())
            return mapped;
    return {};
}

juce::String CombinedDeviceProxy::open (const juce::BigInteger& inputChannels, const juce::BigInteger& outputChannels,
                                        double sampleRate, int bufferSizeSamples)
{
    const auto error = inner->open (toAggregateInputs (inputChannels, layout), toAggregateOutputs (outputChannels, layout),
                                    sampleRate, bufferSizeSamples);
    refreshInputLatency();
    return error;
}

void CombinedDeviceProxy::refreshInputLatency()
{
    inputLatencyExtra.store (extraInputLatency ? extraInputLatency() : 0, std::memory_order_relaxed);
}

juce::BigInteger CombinedDeviceProxy::getActiveOutputChannels() const
{
    return toAggregateOutputs (inner->getActiveOutputChannels(), layout);
}

juce::BigInteger CombinedDeviceProxy::getActiveInputChannels() const
{
    return fromAggregateInputs (inner->getActiveInputChannels(), layout);
}

void CombinedDeviceProxy::start (juce::AudioIODeviceCallback* callback)
{
    if (callback == nullptr)
    {
        stop();
        return;
    }
    target.store (callback, std::memory_order_release);
    inner->start (this);
}

void CombinedDeviceProxy::stop()
{
    // The inner stop() returns only once its IOProc is no longer running, so the target
    // can be dropped afterwards without racing a callback.
    inner->stop();
    target.store (nullptr, std::memory_order_release);
}

void CombinedDeviceProxy::audioDeviceIOCallbackWithContext (const float* const* inputChannelData, int numInputChannels,
                                                            float* const* outputChannelData, int numOutputChannels,
                                                            int numSamples, const juce::AudioIODeviceCallbackContext& context)
{
    if (auto* callback = target.load (std::memory_order_acquire))
    {
        callback->audioDeviceIOCallbackWithContext (inputChannelData, numInputChannels,
                                                    outputChannelData, numOutputChannels, numSamples, context);
        return;
    }
    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr)
            juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);
}

void CombinedDeviceProxy::audioDeviceAboutToStart (juce::AudioIODevice*)
{
    // Also reached when the inner device restarts itself at a new sample rate, which
    // changes its stream latencies.
    refreshInputLatency();
    if (auto* callback = target.load (std::memory_order_acquire))
        callback->audioDeviceAboutToStart (this);
}

void CombinedDeviceProxy::audioDeviceStopped()
{
    if (auto* callback = target.load (std::memory_order_acquire))
        callback->audioDeviceStopped();
}

void CombinedDeviceProxy::audioDeviceError (const juce::String& errorMessage)
{
    if (auto* callback = target.load (std::memory_order_acquire))
        callback->audioDeviceError (errorMessage);
}

CombineMode combineModeOf (juce::AudioIODevice* device, const juce::String& inputDeviceName,
                           const juce::String& outputDeviceName)
{
    if (device == nullptr || inputDeviceName.isEmpty() || outputDeviceName.isEmpty()
        || device->getActiveInputChannels().isZero())
        return CombineMode::none;
    if (dynamic_cast<CombinedDeviceProxy*> (device) != nullptr)
        return CombineMode::aggregate;
    return inputDeviceName == outputDeviceName ? CombineMode::single : CombineMode::fifo;
}

const char* combineModeName (CombineMode mode) noexcept
{
    switch (mode)
    {
        case CombineMode::none:      return "none";
        case CombineMode::single:    return "single";
        case CombineMode::aggregate: return "aggregate";
        case CombineMode::fifo:      return "fifo";
    }
    return "none";
}

int estimatedRoundTripSamples (CombineMode mode, int reportedInputLatency, int reportedOutputLatency,
                               int bufferSize) noexcept
{
    const int reported = juce::jmax (0, reportedInputLatency) + juce::jmax (0, reportedOutputLatency);
    switch (mode)
    {
        case CombineMode::none:      return 0;
        case CombineMode::single:
        case CombineMode::aggregate: return reported;
        // See the header: JUCE's FIFO delay is the reported sum, and the hardware then
        // adds its own share of that sum (everything but the three buffers) again.
        case CombineMode::fifo:      return juce::jmax (reported, 2 * reported - 3 * juce::jmax (0, bufferSize));
    }
    return 0;
}

juce::String describeOpenDevice (juce::AudioIODevice* device, const juce::String& inputDeviceName,
                                 const juce::String& outputDeviceName)
{
    if (device == nullptr)
        return {};
    const auto mode = combineModeOf (device, inputDeviceName, outputDeviceName);
    const double rate = device->getCurrentSampleRate();
    const int buffer = device->getCurrentBufferSizeSamples();
    const int in = device->getInputLatencyInSamples(), out = device->getOutputLatencyInSamples();
    juce::String line;
    line << "out \"" << outputDeviceName << "\" in \"" << inputDeviceName << "\" joined=" << combineModeName (mode)
         << " rate=" << juce::String (rate, 0) << " buffer=" << buffer
         << " reportedIn=" << in << " reportedOut=" << out;
    if (mode != CombineMode::none && rate > 0.0)
        line << " monitoring=" << juce::String (estimatedRoundTripSamples (mode, in, out, buffer) * 1000.0 / rate, 1) << "ms";
    return line;
}

#if ! JUCE_MAC
std::unique_ptr<juce::AudioIODeviceType> createCoreAudioTypeWithPrivateAggregates()
{
    return nullptr;
}
#endif
}
