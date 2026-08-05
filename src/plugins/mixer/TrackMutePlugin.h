#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh
{
namespace te = tracktion::engine;

/**
    CAP-AUT-006 (mute half) — the per-track mute GATE.

    WHAT THIS IS, precisely, because the distinction is the whole point of the ticket:
    this is a **gain gate carrying an automatable parameter**, NOT the engine's routing
    mute. The pinned tracktion clone (2877b621) exposes no automatable mute parameter on
    any axis — track mute is `Track::setMute(bool)` -> the `mute` property, read once per
    block by `TrackMuteState` and applied by `TrackMutingNode` in the playback graph, and
    `VolumeAndPanPlugin::muteOrUnmute()` is a fader-position toggle, not a parameter. See
    docs/ENGINE_API_NOTES.md for the search that established that.

    So a curve needs something to point AT, and this plugin is it: one discrete
    (two-state) `AutomatableParameter` whose applied effect is a 5 ms-ramped multiply by
    zero. It is placed immediately before the post-fader level meter, so a track the
    curve has muted reads silent on its meter as well as in the render.

    HOW IT DIFFERS FROM `set_track_mute`, exactly:

      - `set_track_mute` is routing. `TrackMuteState::shouldTrackContentsBeProcessed()`
        returns false, so `PluginNode` skips the track's plugins entirely and the clips
        node upstream of them is silenced too. Nothing runs.
      - This gate runs. The clips and every plugin on the track still process; their
        output is multiplied by zero here. Same audible result at the track output, more
        CPU while muted, and a plugin sitting downstream of this gate (Mosh appends
        `load_plugin`/`load_builtin` to the END of the chain, so that happens) can still
        ring a tail out of its own internal state after the gate closes.

    The two are independent and both silence the track — `set_track_mute` is untouched by
    this file. A producer automating mute should leave the mute BUTTON off; a track that
    is button-muted is routing-muted regardless of what the curve says.

    Hidden from the snapshot's `plugins` rack array the same way the metering tap and the
    fader are (real pluginList index preserved so plugin-addressed commands still
    resolve); it is surfaced for automation through `track.mixerPlugins`.
*/
class TrackMutePlugin : public te::Plugin
{
public:
    static const char* xmlTypeName;
    static const char* getPluginName() { return "Mute"; }

    /** The paramID of the one automatable parameter — the `mixerPlugins` snapshot entry
        is matched on this by the UI, so it is part of the seam contract. */
    static const char* muteParamID;

    explicit TrackMutePlugin (te::PluginCreationInfo);
    ~TrackMutePlugin() override;

    juce::String getName() const override { return getPluginName(); }
    juce::String getPluginType() override { return xmlTypeName; }
    juce::String getSelectableDescription() override { return getName(); }

    // A fixed mixer element, not a rack-able effect: nothing may move, rack or remove it.
    bool canBeAddedToRack() override { return false; }
    bool canBeMoved() override { return false; }
    bool shouldMeasureCpuUsage() const noexcept override { return false; }

    void initialise (const te::PluginInitialisationInfo&) override;
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext&) override;
    int getNumOutputChannelsGivenInputs (int n) override { return n; }
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;

    /** The gate's manual (un-automated) state. During playback the AUTOMATED value is
        the one that matters — read `getMuteParameter()->getCurrentValue()` for that. */
    bool isGateClosed() const { return muteValue.get() >= 0.5f; }

    te::AutomatableParameter* getMuteParameter() const { return muteParam.get(); }

private:
    juce::CachedValue<float> muteValue;
    te::AutomatableParameter::Ptr muteParam;
    // 1.0 = open, 0.0 = muted. Ramped so a curve edge is a click-free fade, not a step
    // discontinuity in the PCM.
    juce::SmoothedValue<float> gateGain;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackMutePlugin)
};

}
