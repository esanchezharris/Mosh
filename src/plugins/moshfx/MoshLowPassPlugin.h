#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/moshfx/MoshFilterDesign.h"

#include <atomic>

namespace mosh
{
namespace te = tracktion::engine;

// Tracktion's low/high-pass filter with a selectable slope: 6 to 48 dB/oct in steps of
// 6, a Butterworth cascade of order slope / 6 (MoshFilterDesign.h). The slope is the
// CachedValue-only setting `slope` (set_plugin_state, src/moshops/PluginState.h), saved
// as the plugin property "moshFilterSlope" in dB/oct through the Edit's UndoManager. The
// default (12) is never written, so a session or preset tree without the property plays
// at 12 dB/oct, and an older Mosh opening a session saved at another slope plays it at 12.
//
// The subclass does ALL the filtering. te::LowPassPlugin keeps its filters, cutoff cache
// and updateFilters() private, so a subclass could only delegate to the base's
// applyToBuffer at 12 dB/oct, and the base's filter state would go stale while another
// slope ran (a click on the way back). At 12 dB/oct this class makes exactly the base's
// calls instead: the 2-argument JUCE makers with the same float cutoff and
// Plugin::sampleRate, one juce::IIRFilter per channel (the same compiled
// IIRFilterBase<SpinLock>), the same per-block "cutoff or mode changed" test with no
// smoothing and no state reset, the same clearChannels and sanitiseValues (+-3). So 12
// dB/oct is bit-identical to Tracktion's filter (--selftest compares it with a directly
// constructed te::LowPassPlugin, including a cutoff change and a mode flip mid-stream).
//
// A slope change while audio runs resets a second cascade and WARMS it on the input with
// its output unheard (the running cascade is still what plays) for five of its slowest
// section's time constants (MoshFilterDesign.h: 51 ms at 80 Hz and 48 dB/oct, 102 ms at
// 40 Hz; at least 30 ms, at most 200 ms), and only then crossfades over about 20 ms from
// the running cascade to it (two banks; the scratch for the second is allocated in
// initialise, so the audio thread never allocates). Without the warm-up a bass-range
// cutoff's high-Q section was still ringing up from silence when the fade ended (LP 80 Hz
// 12 -> 48 dB/oct: -7.8 dB re peak off a crossfade of two warm filters during the fade,
// -19.4 dB after it); with it, under -45 dB for 40-80 Hz content at the cutoff (below about
// 20 Hz the 200 ms cap leaves more). So the new slope is heard 30-200 ms after the change,
// and a change that lands while one is running waits for it. The mode is mirrored into an atomic
// from valueTreePropertyChanged, reading the tree rather than the CachedValue (whose own
// listener may run after this one), so the audio thread never reads the mode String.
//
// Same xmlTypeName as Tracktion's ("lowpass", inherited), registered from
// MoshEngineBehaviour::autoInitialiseDeviceManager() (src/engine/MoshEngine.cpp) before
// Tracktion registers its own LowPassPlugin; --selftest fails if a created, loaded or
// reloaded "lowpass"/"highpass" is not one of these. Every dynamic_cast to
// te::LowPassPlugin keeps working.
class MoshLowPassPlugin : public te::LowPassPlugin
{
public:
    /** set_plugin_state's ceiling for `slope` (dB/oct); the cascade is sized for it. */
    static constexpr int kMaxSlopeDbPerOct = moshfx::filterdesign::kMaxSlope;
    /** The crossfade from the old cascade to the new one when the slope changes. */
    static constexpr double kSlopeCrossfadeSeconds = 0.020;
    /** The new cascade's unheard warm-up before that crossfade: this many of its slowest
        section's time constants, clamped to [min, max] seconds. */
    static constexpr double kSlopeWarmupTimeConstants = 5.0;
    static constexpr double kSlopeWarmupMinSeconds = 0.030;
    static constexpr double kSlopeWarmupMaxSeconds = 0.200;

    /** The warm-up, in samples, of a change to `order` at `cutoff` Hz. */
    static int slopeWarmupSamples (int order, double cutoff, double rate) noexcept;
    /** The crossfade, in samples, at `rate` (what initialise sizes it as). */
    static int slopeCrossfadeSamples (double rate) noexcept;

    /** "moshFilterSlope": the saved slope in dB/oct. */
    static const juce::Identifier& slopePropertyId();

    explicit MoshLowPassPlugin (te::PluginCreationInfo);
    ~MoshLowPassPlugin() override;

    void initialise (const te::PluginInitialisationInfo&) override;
    void applyToBuffer (const te::PluginRenderContext&) override;

    /** The saved slope as written (dB/oct; default 12). */
    juce::CachedValue<te::AtomicWrapper<int>> slope;

    /** The slope the filter runs at: the saved value snapped onto the 6..48 grid. */
    int getSlope() const noexcept { return moshfx::filterdesign::snapSlope ((int) slope.get()); }

protected:
    void valueTreePropertyChanged (juce::ValueTree&, const juce::Identifier&) override;

private:
    static constexpr int kBanks = 2;
    static constexpr int kChannels = 2;
    static constexpr int kSections = moshfx::filterdesign::kMaxSections;

    // [bank][channel][section]. juce::IIRFilter (not SingleThreadedIIRFilter): the class
    // te::LowPassPlugin runs, so order 2 is the same compiled code.
    juce::IIRFilter banks[kBanks][kChannels][kSections];
    int bankOrder[kBanks] { 2, 2 };
    int live = 0;
    // A slope change: switchPos < 0 when none is running, else the samples since it began.
    // The new bank warms for warmTotal of them (unheard), then the crossfade runs fadeTotal.
    int switchPos = -1, warmTotal = 0, fadeTotal = 1;
    float lastFreq = 0.0f;
    bool lastHighPass = false;
    std::atomic<bool> highPassMirror { false };

    // The second bank's input during a crossfade. Sized in initialise, only ever grown.
    juce::AudioBuffer<float> scratch;
    int scratchSamples = 0;

    void designBank (int bank, float freq, bool highPass) noexcept;
    void resetBank (int bank) noexcept;
    void runBank (int bank, int channel, float* samples, int numSamples) noexcept;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshLowPassPlugin)
};
}
