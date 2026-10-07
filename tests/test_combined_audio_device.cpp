// Two audio devices presented as one (audio/CombinedAudioDevice.h): the channel maths,
// the proxy's forwarding contract, and the monitoring-delay estimate. The CoreAudio half
// (creating the private aggregate) needs real hardware and is not covered here.

#include <catch2/catch_test_macros.hpp>
#include "audio/CombinedAudioDevice.h"

#include <string>
#include <vector>

using namespace mosh::audio;

namespace
{
juce::BigInteger bits (std::initializer_list<int> set)
{
    juce::BigInteger b;
    for (int i : set)
        b.setBit (i);
    return b;
}

// Stands in for the aggregate: `outs` output channels, `ins` input channels, and a log
// of everything the proxy asked of it.
struct FakeDevice final : juce::AudioIODevice
{
    FakeDevice (int outs, int ins, std::vector<std::string>& l)
        : juce::AudioIODevice ("Mosh I/O: fake", "CoreAudio"), numOuts (outs), numIns (ins), log (l) {}
    ~FakeDevice() override { log.push_back ("inner destroyed"); }

    juce::StringArray getOutputChannelNames() override
    {
        juce::StringArray names;
        for (int i = 0; i < numOuts; ++i) names.add ("out " + juce::String (i + 1));
        return names;
    }
    juce::StringArray getInputChannelNames() override
    {
        juce::StringArray names;
        for (int i = 0; i < numIns; ++i) names.add ("in " + juce::String (i + 1));
        return names;
    }
    juce::Array<double> getAvailableSampleRates() override { return { 44100.0, 48000.0 }; }
    juce::Array<int> getAvailableBufferSizes() override    { return { 32, 64, 128 }; }
    int getDefaultBufferSize() override                    { return 128; }
    juce::String open (const juce::BigInteger& in, const juce::BigInteger& out, double rate, int buffer) override
    {
        activeIn = in; activeOut = out; sampleRate = rate; bufferSize = buffer; opened = true;
        return {};
    }
    void close() override     { opened = false; log.push_back ("inner closed"); }
    bool isOpen() override    { return opened; }
    void start (juce::AudioIODeviceCallback* cb) override
    {
        callback = cb;
        if (cb != nullptr) cb->audioDeviceAboutToStart (this);   // as CoreAudioIODevice does
    }
    void stop() override
    {
        if (auto* cb = std::exchange (callback, nullptr)) cb->audioDeviceStopped();
    }
    bool isPlaying() override                 { return callback != nullptr; }
    juce::String getLastError() override      { return {}; }
    int getCurrentBufferSizeSamples() override { return bufferSize; }
    double getCurrentSampleRate() override     { return sampleRate; }
    int getCurrentBitDepth() override          { return 24; }
    juce::BigInteger getActiveOutputChannels() const override { return activeOut; }
    juce::BigInteger getActiveInputChannels() const override  { return activeIn; }
    int getOutputLatencyInSamples() override   { return outputLatency; }
    int getInputLatencyInSamples() override    { return inputLatency; }

    const int numOuts, numIns;
    std::vector<std::string>& log;
    juce::BigInteger activeIn, activeOut;
    juce::AudioIODeviceCallback* callback = nullptr;
    double sampleRate = 0.0;
    int bufferSize = 0, inputLatency = 0, outputLatency = 0;
    bool opened = false;
};

struct RecordingCallback final : juce::AudioIODeviceCallback
{
    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut,
                                           int numSamples, const juce::AudioIODeviceCallbackContext&) override
    {
        ++blocks;
        lastNumIn = numIn;
        for (int ch = 0; ch < numOut; ++ch)
            for (int i = 0; i < numSamples; ++i)
                out[ch][i] = numIn > 0 ? in[0][i] : 1.0f;
    }
    void audioDeviceAboutToStart (juce::AudioIODevice* d) override { startedWith = d; }
    void audioDeviceStopped() override                              { ++stops; }
    void audioDeviceError (const juce::String& e) override          { error = e; }

    juce::AudioIODevice* startedWith = nullptr;
    juce::String error;
    int blocks = 0, stops = 0, lastNumIn = -1;
};

// Headphones (2 out, 0 in) + built-in microphone (1 in): the laptop case.
constexpr CombinedLayout kLaptop { 2, 0, 1 };
// An output device that also has 2 inputs of its own (a USB headset) + a 4-input interface.
constexpr CombinedLayout kHeadsetPlusInterface { 2, 2, 4 };
}

TEST_CASE ("combined device: input channels shift past the output device's own inputs", "[audio-combine]")
{
    CHECK (toAggregateInputs (bits ({ 0 }), kLaptop) == bits ({ 0 }));
    CHECK (toAggregateInputs (bits ({ 0, 3 }), kHeadsetPlusInterface) == bits ({ 2, 5 }));
    CHECK (fromAggregateInputs (bits ({ 2, 5 }), kHeadsetPlusInterface) == bits ({ 0, 3 }));

    // The output device's own inputs are never offered, and channels the input device
    // does not have are dropped rather than landing on a neighbour.
    CHECK (fromAggregateInputs (bits ({ 0, 1 }), kHeadsetPlusInterface).isZero());
    CHECK (toAggregateInputs (bits ({ 4, 9 }), kHeadsetPlusInterface).isZero());

    for (int ch = 0; ch < kHeadsetPlusInterface.numInputs; ++ch)
        CHECK (fromAggregateInputs (toAggregateInputs (bits ({ ch }), kHeadsetPlusInterface), kHeadsetPlusInterface)
               == bits ({ ch }));
}

TEST_CASE ("combined device: outputs are limited to the output device's channels", "[audio-combine]")
{
    CHECK (toAggregateOutputs (bits ({ 0, 1 }), kLaptop) == bits ({ 0, 1 }));
    CHECK (toAggregateOutputs (bits ({ 0, 1, 2, 7 }), kLaptop) == bits ({ 0, 1 }));
}

TEST_CASE ("combined device: the proxy is the output device's outputs and the input device's inputs",
           "[audio-combine]")
{
    std::vector<std::string> log;
    auto* fake = new FakeDevice (2, 6, log);   // aggregate: 2 out; 2 headset in + 4 interface in
    fake->inputLatency = 300;
    fake->outputLatency = 200;
    CombinedDeviceProxy proxy ("Headset", "Interface", "CoreAudio", std::unique_ptr<juce::AudioIODevice> (fake),
                               kHeadsetPlusInterface);

    // JUCE names a two-device combination after its output device, and its device
    // manager looks that name up to decide whether the device still exists.
    CHECK (proxy.getName() == "Headset");
    CHECK (proxy.getTypeName() == "CoreAudio");
    CHECK (proxy.getOutputDeviceName() == "Headset");
    CHECK (proxy.getInputDeviceName() == "Interface");

    CHECK (proxy.getOutputChannelNames() == juce::StringArray ({ "out 1", "out 2" }));
    CHECK (proxy.getInputChannelNames() == juce::StringArray ({ "in 3", "in 4", "in 5", "in 6" }));
    CHECK (proxy.getAvailableBufferSizes() == juce::Array<int> ({ 32, 64, 128 }));

    REQUIRE (proxy.open (bits ({ 0, 1 }), bits ({ 0, 1 }), 48000.0, 64).isEmpty());
    CHECK (fake->activeIn == bits ({ 2, 3 }));
    CHECK (fake->activeOut == bits ({ 0, 1 }));
    CHECK (proxy.getActiveInputChannels() == bits ({ 0, 1 }));
    CHECK (proxy.getActiveOutputChannels() == bits ({ 0, 1 }));
    CHECK (proxy.getCurrentBufferSizeSamples() == 64);
    CHECK (proxy.getCurrentSampleRate() == 48000.0);
    CHECK (proxy.getInputLatencyInSamples() == 300);
    CHECK (proxy.getOutputLatencyInSamples() == 200);
}

TEST_CASE ("combined device: whoever starts the proxy is told about the proxy, never the device inside",
           "[audio-combine]")
{
    std::vector<std::string> log;
    auto* fake = new FakeDevice (2, 1, log);
    CombinedDeviceProxy proxy ("Headphones", "Microphone", "CoreAudio", std::unique_ptr<juce::AudioIODevice> (fake),
                               kLaptop);
    REQUIRE (proxy.open (bits ({ 0 }), bits ({ 0, 1 }), 48000.0, 128).isEmpty());

    RecordingCallback callback;
    proxy.start (&callback);
    CHECK (callback.startedWith == &proxy);
    CHECK (proxy.isPlaying());
    REQUIRE (fake->callback != nullptr);

    // Audio passes straight through: the same buffers, no copy and no FIFO.
    float in[4] = { 0.25f, 0.5f, 0.75f, 1.0f }, left[4] = {}, right[4] = {};
    const float* ins[] = { in };
    float* outs[] = { left, right };
    fake->callback->audioDeviceIOCallbackWithContext (ins, 1, outs, 2, 4, {});
    CHECK (callback.blocks == 1);
    CHECK (callback.lastNumIn == 1);
    CHECK (left[3] == 1.0f);
    CHECK (right[0] == 0.25f);

    fake->callback->audioDeviceError ("unplugged");
    CHECK (callback.error == "unplugged");

    auto* innerCallback = fake->callback;
    proxy.stop();
    CHECK (callback.stops == 1);
    CHECK_FALSE (proxy.isPlaying());

    // A late block after stop() must not reach the old callback, and must not leave
    // whatever was in the output buffers playing.
    left[0] = right[0] = 0.9f;
    innerCallback->audioDeviceIOCallbackWithContext (ins, 1, outs, 2, 4, {});
    CHECK (callback.blocks == 1);
    CHECK (left[0] == 0.0f);
    CHECK (right[0] == 0.0f);
}

TEST_CASE ("combined device: the aggregate is released only after the device inside it is gone",
           "[audio-combine]")
{
    std::vector<std::string> log;
    {
        CombinedDeviceProxy proxy ("Headphones", "Microphone", "CoreAudio",
                                   std::make_unique<FakeDevice> (2, 1, log), kLaptop,
                                   [&log] { log.push_back ("aggregate released"); });
        REQUIRE (proxy.open (bits ({ 0 }), bits ({ 0, 1 }), 48000.0, 128).isEmpty());
    }
    REQUIRE (log.size() >= 2);
    CHECK (log[log.size() - 2] == "inner destroyed");
    CHECK (log.back() == "aggregate released");
}

TEST_CASE ("combined device: input latency is corrected to the input device's own stream", "[audio-combine]")
{
    // JUCE reads the aggregate's FIRST input stream. Behind a headset's own inputs the
    // microphone's stream comes second, so the device inside reports the headset's.
    std::vector<std::string> log;
    auto* fake = new FakeDevice (2, 3, log);
    fake->inputLatency = 74 + 128;   // safety offset + buffer, the wrong stream's 0
    int microphoneStreamLatency = 1439;
    CombinedDeviceProxy proxy ("Headset", "Microphone", "CoreAudio", std::unique_ptr<juce::AudioIODevice> (fake),
                               CombinedLayout { 2, 2, 1 }, {},
                               [&microphoneStreamLatency] { return microphoneStreamLatency; });

    REQUIRE (proxy.open (bits ({ 0 }), bits ({ 0, 1 }), 48000.0, 128).isEmpty());
    CHECK (proxy.getInputLatencyInSamples() == 74 + 128 + 1439);
    CHECK (proxy.getOutputLatencyInSamples() == 0);   // outputs lead the aggregate: nothing to correct

    // The device inside restarts itself at a new rate; the stream latency changes with it.
    microphoneStreamLatency = 1322;
    RecordingCallback callback;
    proxy.start (&callback);
    CHECK (proxy.getInputLatencyInSamples() == 74 + 128 + 1322);
    proxy.stop();
}

TEST_CASE ("combined device: how input and output are joined", "[audio-combine]")
{
    std::vector<std::string> log;
    CHECK (combineModeOf (nullptr, "Microphone", "Headphones") == CombineMode::none);

    FakeDevice plain (2, 2, log);
    // Output only (Mosh's launch state, before an input is activated).
    REQUIRE (plain.open ({}, bits ({ 0, 1 }), 48000.0, 128).isEmpty());
    CHECK (combineModeOf (&plain, "Interface", "Interface") == CombineMode::none);

    REQUIRE (plain.open (bits ({ 0 }), bits ({ 0, 1 }), 48000.0, 128).isEmpty());
    CHECK (combineModeOf (&plain, "Interface", "Interface") == CombineMode::single);
    CHECK (combineModeOf (&plain, "Microphone", "Headphones") == CombineMode::fifo);
    CHECK (combineModeOf (&plain, "", "Headphones") == CombineMode::none);

    CombinedDeviceProxy proxy ("Headphones", "Microphone", "CoreAudio", std::make_unique<FakeDevice> (2, 1, log),
                               kLaptop);
    REQUIRE (proxy.open (bits ({ 0 }), bits ({ 0, 1 }), 48000.0, 128).isEmpty());
    CHECK (combineModeOf (&proxy, "Microphone", "Headphones") == CombineMode::aggregate);

    // The log line a support request would quote.
    auto* inside = new FakeDevice (2, 1, log);
    inside->inputLatency = 1513 + 128;
    inside->outputLatency = 170 + 128;
    CombinedDeviceProxy described ("Headphones", "Microphone", "CoreAudio", std::unique_ptr<juce::AudioIODevice> (inside),
                                   kLaptop);
    REQUIRE (described.open (bits ({ 0 }), bits ({ 0, 1 }), 48000.0, 128).isEmpty());
    CHECK (describeOpenDevice (&described, "Microphone", "Headphones")
           == "out \"Headphones\" in \"Microphone\" joined=aggregate rate=48000 buffer=128 "
              "reportedIn=1641 reportedOut=298 monitoring=40.4ms");
    CHECK (describeOpenDevice (nullptr, "Microphone", "Headphones").isEmpty());

    CHECK (std::string (combineModeName (CombineMode::aggregate)) == "aggregate");
    CHECK (std::string (combineModeName (CombineMode::fifo)) == "fifo");
}

TEST_CASE ("combined device: monitoring delay for a MacBook microphone and headphones", "[audio-combine]")
{
    // Hardware, at 48 kHz: microphone 1513 samples, headphones 170. CoreAudio devices
    // report those plus one buffer each.
    const int buffer = 128, microphone = 1513, headphones = 170;

    // One device (or one aggregate): both latencies and two buffers.
    const int direct = estimatedRoundTripSamples (CombineMode::aggregate, microphone + buffer, headphones + buffer, buffer);
    CHECK (direct == microphone + headphones + 2 * buffer);   // 1939 = 40.4 ms
    CHECK (estimatedRoundTripSamples (CombineMode::single, microphone + buffer, headphones + buffer, buffer) == direct);

    // JUCE's FIFO: it reports the microphone plus a buffer as its input latency and the
    // rest of its delay (headphones plus two buffers) as its output latency, then the
    // hardware pays both latencies again.
    const int fifo = estimatedRoundTripSamples (CombineMode::fifo, microphone + buffer, headphones + 2 * buffer, buffer);
    CHECK (fifo == 2 * (microphone + headphones) + 3 * buffer);   // 3750 = 78.1 ms
    CHECK (fifo - direct == microphone + headphones + buffer);    // what the aggregate saves

    CHECK (estimatedRoundTripSamples (CombineMode::none, microphone, headphones, buffer) == 0);
    CHECK (estimatedRoundTripSamples (CombineMode::fifo, -5, -5, buffer) == 0);
}

#if JUCE_MAC
namespace
{
struct Silence final : juce::AudioIODeviceCallback
{
    void audioDeviceIOCallbackWithContext (const float* const*, int, float* const* out, int numOut, int numSamples,
                                           const juce::AudioIODeviceCallbackContext&) override
    {
        for (int ch = 0; ch < numOut; ++ch)
            juce::FloatVectorOperations::clear (out[ch], numSamples);
    }
    void audioDeviceAboutToStart (juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}
};
}

// Real hardware, so hidden: it runs only when asked for by tag, with the two devices named
// in the environment. It opens them (the input device is captured for under a second and
// the samples are discarded) and plays silence.
//   MOSH_TEST_AUDIO_OUT="External Headphones" MOSH_TEST_AUDIO_IN="MacBook Pro Microphone" \
//     MoshTests "[.audio-combine-live]"
TEST_CASE ("combined device, live: two real devices open as one, repeatedly", "[.audio-combine-live]")
{
    const auto outputName = juce::SystemStats::getEnvironmentVariable ("MOSH_TEST_AUDIO_OUT", {});
    const auto inputName = juce::SystemStats::getEnvironmentVariable ("MOSH_TEST_AUDIO_IN", {});
    REQUIRE (outputName.isNotEmpty());
    REQUIRE (inputName.isNotEmpty());
    const int rounds = juce::jmax (1, juce::SystemStats::getEnvironmentVariable ("MOSH_TEST_AUDIO_ROUNDS", "3").getIntValue());
    const int buffer = juce::jmax (16, juce::SystemStats::getEnvironmentVariable ("MOSH_TEST_AUDIO_BUFFER", "128").getIntValue());

    juce::MessageManager::getInstance();
    auto type = createCoreAudioTypeWithPrivateAggregates();
    REQUIRE (type != nullptr);
    type->scanForDevices();
    REQUIRE (type->getDeviceNames (false).contains (outputName));
    REQUIRE (type->getDeviceNames (true).contains (inputName));

    for (int round = 0; round < rounds; ++round)
    {
        INFO ("round " << round);
        // What Mosh does: it launches on the output device alone, and when an input is
        // wanted it closes that device and at once opens the pair.
        {
            std::unique_ptr<juce::AudioIODevice> outputOnly (type->createDevice (outputName, {}));
            REQUIRE (outputOnly != nullptr);
            CHECK (dynamic_cast<CombinedDeviceProxy*> (outputOnly.get()) == nullptr);
            juce::BigInteger launchOuts;
            launchOuts.setRange (0, juce::jmin (2, outputOnly->getOutputChannelNames().size()), true);
            REQUIRE (outputOnly->open ({}, launchOuts, 48000.0, 512).isEmpty());
            Silence silence;
            outputOnly->start (&silence);
            juce::Thread::sleep (150);
            outputOnly->stop();
            outputOnly->close();
        }

        std::unique_ptr<juce::AudioIODevice> device (type->createDevice (outputName, inputName));
        REQUIRE (device != nullptr);
        REQUIRE (dynamic_cast<CombinedDeviceProxy*> (device.get()) != nullptr);
        CHECK (device->getName() == outputName);

        // Nothing Mosh lists ever shows the aggregate itself.
        type->scanForDevices();
        for (const bool inputs : { true, false })
            for (const auto& listedName : type->getDeviceNames (inputs))
                CHECK_FALSE (isPrivateAggregateName (listedName));

        REQUIRE (device->getInputChannelNames().size() >= 1);
        REQUIRE (device->getOutputChannelNames().size() >= 1);
        juce::BigInteger outs;
        outs.setRange (0, juce::jmin (2, device->getOutputChannelNames().size()), true);
        REQUIRE (device->open (bits ({ 0 }), outs, 48000.0, buffer).isEmpty());
        CHECK (device->getCurrentBufferSizeSamples() == buffer);
        CHECK (combineModeOf (device.get(), inputName, outputName) == CombineMode::aggregate);
        WARN (describeOpenDevice (device.get(), inputName, outputName));

        struct Counter final : juce::AudioIODeviceCallback
        {
            void audioDeviceIOCallbackWithContext (const float* const*, int numIn, float* const* out, int numOut,
                                                   int numSamples, const juce::AudioIODeviceCallbackContext&) override
            {
                inputs.store (numIn);
                blocks.fetch_add (1);
                for (int ch = 0; ch < numOut; ++ch)
                    juce::FloatVectorOperations::clear (out[ch], numSamples);
            }
            void audioDeviceAboutToStart (juce::AudioIODevice*) override {}
            void audioDeviceStopped() override {}
            std::atomic<int> blocks { 0 }, inputs { -1 };
        } counter;

        device->start (&counter);
        juce::Thread::sleep (400);
        device->stop();
        CHECK (counter.blocks.load() > 10);
        CHECK (counter.inputs.load() == 1);
        CHECK (device->getXRunCount() <= 1);
        device->close();
    }
    juce::MessageManager::deleteInstance();
}
#endif
