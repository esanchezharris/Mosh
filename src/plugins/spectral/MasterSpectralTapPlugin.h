#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <array>
#include <atomic>

namespace mosh
{
namespace te = tracktion::engine;

/** Master-output spectral tap (Moshi reactivity, Part B). A custom built-in
    te::Plugin appended to the master plugin list. It is a PURE MEASURE: in
    applyToBuffer it copies the summed-mono master samples into a lock-free SPSC
    FIFO and leaves destBuffer untouched (audio passes through bit-exact — the
    null test). The message thread (MoshOps::timerCallback, 30 Hz) drains the FIFO
    and computes the band feed; no FFT/alloc/lock ever runs on the audio thread.

    Why a plugin on the master: te::LevelMeasurer gives peaks, not the buffer; the
    only clean place to tap the final master SIGNAL is a node at the end of the
    master plugin list (mirrors how LevelMeterPlugin taps a track). */
class MasterSpectralTapPlugin : public te::Plugin
{
public:
    static const char* xmlTypeName;                       // "moshMasterSpectralTap"
    static const char* getPluginName()  { return "Mosh Spectral Tap"; }

    explicit MasterSpectralTapPlugin (te::PluginCreationInfo);
    ~MasterSpectralTapPlugin() override = default;

    juce::String getName() const override            { return getPluginName(); }
    juce::String getPluginType() override            { return xmlTypeName; }
    juce::String getSelectableDescription() override { return getName(); }

    void initialise (const te::PluginInitialisationInfo& info) override { sr.store (info.sampleRate); }
    void deinitialise() override {}
    void applyToBuffer (const te::PluginRenderContext&) override;       // RT thread — pure measure
    int  getNumOutputChannelsGivenInputs (int n) override { return n; }
    void restorePluginStateFromValueTree (const juce::ValueTree&) override {}

    /** Message-thread drain: copies up to maxN of the newest mono samples into
        dest, returns the count read. */
    int    read (float* dest, int maxN);
    double getSampleRate() const { return sr.load(); }

private:
    static constexpr int kFifoSize = 1 << 14;             // 16384 samples (~340ms @48k)
    juce::AbstractFifo   fifo { kFifoSize };
    std::array<float, kFifoSize> ring {};
    std::atomic<double>  sr { 48000.0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MasterSpectralTapPlugin)
};

} // namespace mosh
