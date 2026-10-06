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
// A slope change while audio runs crossfades over about 20 ms from the running cascade
// to a freshly reset one (two banks; the scratch for the second is allocated in
// initialise, so the audio thread never allocates). The mode is mirrored into an atomic
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
    int fadeTotal = 1, fadeDone = -1;   // fadeDone < 0: no crossfade running
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
