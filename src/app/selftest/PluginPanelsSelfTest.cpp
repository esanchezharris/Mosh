// The native plugin panels' engine seam, proven against the live engine.
//
//   SNAPSHOT   every plugin carries a stable itemId; the built-ins whose parameters are
//              plain linear ranges publish physical min/max (the compressor's threshold
//              and ratio deliberately do not); delay/chorus/phaser/low-/high-pass publish
//              their CachedValue-only settings as `state` (integer keys with their step).
//   COMMAND    set_plugin_state validates, clamps, rounds, snaps the filter slope onto its
//              6 dB/oct grid, flips the filter mode, and undoes; a `gesture` id makes a
//              whole drag ONE undo step and nothing else.
//   METERS     MoshOps::pluginMeters (the 30 Hz "plugin_meters" rail): measured gain
//              reduction that matches the compressor's static curve in steady state and
//              departs from it on a transient, staleness, bypass, an undone removal, and
//              the compressor's audio bit-identical to Tracktion's own.
//   DELAY LINE Mosh's delay and chorus (lines pre-sized off the audio thread) are what
//              "delay"/"chorus" load as, and their audio is Tracktion's bit for bit.
//   SLOPE      Mosh's low/high-pass is what "lowpass"/"highpass" load as; at 12 dB/oct its
//              audio is Tracktion's bit for bit (cutoff change and mode flip included),
//              every slope attenuates as the Butterworth closed form says, and a slope
//              change mid-stream crossfades without a jump.
//   SIGNATURE  the render-layer cache key changes with plugin state and sampler sounds.
//   4OSC       a loaded or default "4osc" is Mosh's metered subclass; all 68 parameters with
//              their paramIDs and full JUCE ranges (skew, step), every other type's
//              parameters byte-identical to before; its state keys; read-only mod routes;
//              and its live rail entry (output peak, held keys, struck notes), driven with
//              MIDI through a live (not rendering) context.
//
// A headless run has no audio thread, so the plugins are driven block by block the way
// the playback graph's PluginNode drives them (as the AutoTune section does).
#include "PluginPanelsSelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "plugins/moshfx/MoshFxPlugins.h"
#include "plugins/moshfx/MoshCompressorPlugin.h"
#include "plugins/moshfx/MoshDelayLinePlugins.h"
#include "plugins/moshfx/MoshLowPassPlugin.h"
#include "plugins/moshfx/MoshFourOscPlugin.h"
#include "moshops/PluginState.h"
#include "moshops/PluginParameterReadback.h"
#include <cmath>
#include <cstring>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <vector>

namespace mosh
{
namespace
{
using juce::String;
using juce::var;

var object (std::initializer_list<std::pair<const char*, var>> fields)
{
    auto* value = new juce::DynamicObject();
    for (const auto& [name, field] : fields)
        value->setProperty (name, field);
    return var (value);
}

var command (MoshOps& ops, const String& name, var args = {})
{
    auto* value = new juce::DynamicObject();
    value->setProperty ("command", name);
    if (! args.isVoid())
        value->setProperty ("args", args);
    return ops.execute (var (value));
}

bool ok (const var& result)        { return (bool) result.getProperty ("ok", false); }
var dataOf (const var& result)     { return result.getProperty ("data", var()); }
String errorOf (const var& result) { return result.getProperty ("error", var()).toString(); }

var trackVar (MoshOps& ops, const String& trackId)
{
    const auto snapshot = ops.snapshot();
    const auto tracks = snapshot.getProperty ("tracks", var());
    for (int i = 0; i < tracks.size(); ++i)
        if (tracks[i].getProperty ("id", var()).toString() == trackId)
            return tracks[i];
    return {};
}

var pluginsOf (MoshOps& ops, const String& trackId)
{
    return trackVar (ops, trackId).getProperty ("plugins", var());
}

var pluginAt (MoshOps& ops, const String& trackId, int index)
{
    const auto plugins = pluginsOf (ops, trackId);
    for (int i = 0; i < plugins.size(); ++i)
        if ((int) plugins[i].getProperty ("index", -1) == index)
            return plugins[i];
    return {};
}

var pluginWithItemId (MoshOps& ops, const String& trackId, const String& itemId)
{
    const auto plugins = pluginsOf (ops, trackId);
    for (int i = 0; i < plugins.size(); ++i)
        if (plugins[i].getProperty ("itemId", var()).toString() == itemId)
            return plugins[i];
    return {};
}

var paramOf (MoshOps& ops, const String& trackId, int index, int paramIndex)
{
    const auto params = pluginAt (ops, trackId, index).getProperty ("params", var());
    return paramIndex >= 0 && paramIndex < params.size() ? params[paramIndex] : var();
}

double paramValue (MoshOps& ops, const String& trackId, int index, int paramIndex)
{
    return (double) paramOf (ops, trackId, index, paramIndex).getProperty ("value", -1.0);
}

var stateEntry (MoshOps& ops, const String& trackId, int index, const char* key)
{
    return pluginAt (ops, trackId, index).getProperty ("state", var()).getProperty (key, var());
}

var stateValue (MoshOps& ops, const String& trackId, int index, const char* key)
{
    return stateEntry (ops, trackId, index, key).getProperty ("value", var());
}

te::Plugin* livePlugin (MoshEngine& eng, const String& trackId, int index)
{
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr && t->itemID.toString() == trackId)
        {
            const auto chain = t->pluginList.getPlugins();
            if (index >= 0 && index < chain.size())
                return chain[index].get();
        }
    return nullptr;
}

juce::AudioBuffer<float> signal (int channels, double seconds, const std::function<float (int, int)>& sample)
{
    juce::AudioBuffer<float> io (channels, (int) (seconds * 48000.0));
    for (int ch = 0; ch < channels; ++ch)
        for (int i = 0; i < io.getNumSamples(); ++i)
            io.setSample (ch, i, sample (ch, i));
    return io;
}

float sine (double hz, int i, float amplitude)
{
    return amplitude * (float) std::sin (juce::MathConstants<double>::twoPi * hz * i / 48000.0);
}

// The playback graph's PluginNode, by hand: initialise, one render context per block,
// deinitialise.
void drive (te::Plugin& plugin, juce::AudioBuffer<float>& io, int block)
{
    const double rate = 48000.0;
    plugin.baseClassInitialise ({ tracktion::TimePosition(), rate, block });
    const auto layout = io.getNumChannels() >= 2 ? juce::AudioChannelSet::stereo() : juce::AudioChannelSet::mono();
    for (int start = 0; start < io.getNumSamples(); start += block)
    {
        const int n = juce::jmin (block, io.getNumSamples() - start);
        const tracktion::TimeRange time (tracktion::TimePosition::fromSeconds (start / rate),
                                         tracktion::TimePosition::fromSeconds ((start + n) / rate));
        te::PluginRenderContext context (&io, layout, start, n, nullptr, 0.0, time,
                                         /*playing*/ true, /*scrubbing*/ false, /*rendering*/ true,
                                         /*allowBypassedProcessing*/ false);
        plugin.applyToBufferWithAutomation (context);
    }
    plugin.baseClassDeinitialise();
}

// The same, with `change` applied to both plugins between the two halves of the signal
// (a set_plugin_state while the plugin is playing).
void driveWithChange (te::Plugin& plugin, juce::AudioBuffer<float>& io, int block, const std::function<void (te::Plugin&)>& change)
{
    const double rate = 48000.0;
    plugin.baseClassInitialise ({ tracktion::TimePosition(), rate, block });
    const auto layout = io.getNumChannels() >= 2 ? juce::AudioChannelSet::stereo() : juce::AudioChannelSet::mono();
    const int half = (io.getNumSamples() / 2 / block) * block;
    for (int start = 0; start < io.getNumSamples(); start += block)
    {
        if (start == half)
            change (plugin);
        const int n = juce::jmin (block, io.getNumSamples() - start);
        const tracktion::TimeRange time (tracktion::TimePosition::fromSeconds (start / rate),
                                         tracktion::TimePosition::fromSeconds ((start + n) / rate));
        te::PluginRenderContext context (&io, layout, start, n, nullptr, 0.0, time,
                                         /*playing*/ true, /*scrubbing*/ false, /*rendering*/ true,
                                         /*allowBypassedProcessing*/ false);
        plugin.applyToBufferWithAutomation (context);
    }
    plugin.baseClassDeinitialise();
}

// The same, with `beforeBlock (plugin, blockStart)` called before every block (changes at
// chosen points of the stream).
void driveScheduled (te::Plugin& plugin, juce::AudioBuffer<float>& io, int block,
                     const std::function<void (te::Plugin&, int)>& beforeBlock)
{
    const double rate = 48000.0;
    plugin.baseClassInitialise ({ tracktion::TimePosition(), rate, block });
    const auto layout = io.getNumChannels() >= 2 ? juce::AudioChannelSet::stereo() : juce::AudioChannelSet::mono();
    for (int start = 0; start < io.getNumSamples(); start += block)
    {
        beforeBlock (plugin, start);
        const int n = juce::jmin (block, io.getNumSamples() - start);
        const tracktion::TimeRange time (tracktion::TimePosition::fromSeconds (start / rate),
                                         tracktion::TimePosition::fromSeconds ((start + n) / rate));
        te::PluginRenderContext context (&io, layout, start, n, nullptr, 0.0, time,
                                         /*playing*/ true, /*scrubbing*/ false, /*rendering*/ true,
                                         /*allowBypassedProcessing*/ false);
        plugin.applyToBufferWithAutomation (context);
    }
    plugin.baseClassDeinitialise();
}

// An instrument the way the playback graph drives it during LIVE playback: initialised
// ONCE (FourOsc's initialise turns every voice off, so re-initialising between calls
// would cut what is sounding), then rendered block by block with rendering FALSE (the
// drive helpers above pass true) and each block handed the MIDI that falls in it, the
// edit time running on across calls. In play(), `events` are (sample, message) pairs
// counted from the start of that call; a message's timestamp is its sample over the
// rate, measured, like the block's bufferStartSample, from the start of the call's buffer
// (FourOsc keeps a message when round (timestamp * rate) lands inside the block).
// `strays` go into the FIRST block's MIDI only, whatever their sample: a stray past the
// first block is handed to a block it does not belong to, so the synth must ignore it.
using MidiEvents = std::vector<std::pair<int, juce::MidiMessage>>;
struct LiveInstrument
{
    LiveInstrument (te::Plugin& p, int blockSize) : plugin (p), block (blockSize)
    {
        plugin.baseClassInitialise ({ tracktion::TimePosition(), rate, block });
    }
    ~LiveInstrument() { plugin.baseClassDeinitialise(); }

    juce::AudioBuffer<float> play (double seconds, const MidiEvents& events = {}, bool rendering = false,
                                   const MidiEvents& strays = {})
    {
        juce::AudioBuffer<float> io (2, (int) (seconds * rate));
        io.clear();
        for (int start = 0; start < io.getNumSamples(); start += block)
        {
            const int n = juce::jmin (block, io.getNumSamples() - start);
            midi.clear();
            for (const auto& [at, message] : events)
                if (at >= start && at < start + n)
                    midi.addMidiMessage (message, at / rate, source);
            if (start == 0)
                for (const auto& [at, message] : strays)
                    midi.addMidiMessage (message, at / rate, source);
            const tracktion::TimeRange time (tracktion::TimePosition::fromSeconds ((double) (position + start) / rate),
                                             tracktion::TimePosition::fromSeconds ((double) (position + start + n) / rate));
            te::PluginRenderContext context (&io, juce::AudioChannelSet::stereo(), start, n, &midi, 0.0, time,
                                             /*playing*/ true, /*scrubbing*/ false, rendering,
                                             /*allowBypassedProcessing*/ false);
            plugin.applyToBufferWithAutomation (context);
        }
        position += io.getNumSamples();
        return io;
    }

    te::Plugin& plugin;
    const int block;
    const double rate = 48000.0;
    juce::int64 position = 0;
    te::MidiMessageArray midi;
    const te::MPESourceID source = te::createUniqueMPESourceID();
};

// A parameter object exactly as pluginToVar built it before the 4OSC work (2026-10-05):
// index, name, value, the readback (display/unit, and min/max when `range` is given), the
// stepped-parameter fields, automated and its points. Used to prove that the payload of
// every other plugin type is byte-identical, and that the 4OSC's first 16 only GAINED keys.
var legacyParamVar (te::AutomatableParameter& param, int index, std::optional<juce::Range<float>> range)
{
    auto* po = new juce::DynamicObject();
    po->setProperty ("index", index);
    po->setProperty ("name", param.getParameterName());
    po->setProperty ("value", param.getCurrentNormalisedValue());
    addPluginParameterReadback (*po, param, range);
    if (param.isDiscrete())
    {
        po->setProperty ("discrete", true);
        po->setProperty ("states", juce::jmax (2, param.getNumberOfStates()));
        if (param.hasLabels())
        {
            juce::Array<var> choices;
            for (const auto& label : param.getAllLabels())
                choices.add (label);
            po->setProperty ("choices", choices);
        }
    }
    const bool automated = param.hasAutomationPoints();
    po->setProperty ("automated", automated);
    if (automated)
    {
        auto& curve = param.getCurve();
        juce::Array<var> pts;
        for (int j = 0; j < curve.getNumPoints(); ++j)
        {
            auto* pt = new juce::DynamicObject();
            pt->setProperty ("t", curve.getPointTime (j).inSeconds());
            pt->setProperty ("v", param.valueRange.convertTo0to1 (curve.getPointValue (j)));
            pts.add (var (pt));
        }
        po->setProperty ("points", pts);
    }
    return var (po);
}

// `entry` without the keys named in `drop` (a copy; the property order is kept).
var withoutKeys (const var& entry, std::initializer_list<const char*> drop)
{
    auto* copy = new juce::DynamicObject();
    if (auto* object = entry.getDynamicObject())
        for (const auto& property : object->getProperties())
        {
            bool dropped = false;
            for (auto* key : drop)
                dropped = dropped || property.name.toString() == key;
            if (! dropped)
                copy->setProperty (property.name, property.value);
        }
    return var (copy);
}

std::vector<int> notesIn (const var& array)
{
    std::vector<int> notes;
    for (int i = 0; i < array.size(); ++i)
        notes.push_back ((int) array[i]);
    return notes;
}

int samplesDiffering (const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    int differing = 0;
    for (int ch = 0; ch < juce::jmin (a.getNumChannels(), b.getNumChannels()); ++ch)
        for (int i = 0; i < juce::jmin (a.getNumSamples(), b.getNumSamples()); ++i)
            if (std::memcmp (a.getReadPointer (ch) + i, b.getReadPointer (ch) + i, sizeof (float)) != 0)
                ++differing;
    return differing;
}

// A genuine Tracktion plugin of class T built from a copy of `source`'s state (fresh id).
template <typename T>
te::Plugin::Ptr tracktionTwin (MoshEngine& eng, te::Plugin& source)
{
    auto tree = source.state.createCopy();
    tree.removeProperty (te::IDs::id, nullptr);
    te::EditItemID::readOrCreateNewID (eng.edit(), tree);
    return te::Plugin::Ptr (new T (te::PluginCreationInfo (eng.edit(), tree, false)));
}

void pump (int ms)
{
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (ms);
}

var meterFor (const var& payload, const String& trackId, int index)
{
    const auto entries = payload.getProperty ("plugins", var());
    for (int i = 0; i < entries.size(); ++i)
        if (entries[i].getProperty ("trackId", var()).toString() == trackId
            && (int) entries[i].getProperty ("index", -1) == index)
            return entries[i];
    return {};
}

double db (double linear) { return 20.0 * std::log10 (linear); }
}

void runPluginPanelsSelfTest (MoshEngine& eng, MoshOps& ops, const PluginPanelsSelfTestCallbacks& cb)
{
    const auto& section = cb.section;
    const auto& check = cb.check;

    // ── Fixture: one track carrying every in-scope native type, plus AutoTune ──
    section ("Plugin panels: itemId and physical parameter ranges");
    const auto tid = dataOf (command (ops, "create_track", object ({ { "name", "Plugin Panels" } })))
                         .getProperty ("trackId", var()).toString();
    check (tid.isNotEmpty(), "panels fixture track created");
    const char* types[] = { "compressor", "4bandEq", "delay", "chorus", "phaser", "lowpass", "highpass",
                            "pitchShifter", "moshOTT", "softclip", "moshXFeedback", "moshAutoTune" };
    std::map<String, int> at;
    for (auto* type : types)
    {
        const auto r = command (ops, "load_builtin", object ({ { "trackId", tid }, { "type", type } }));
        at[type] = (int) dataOf (r).getProperty ("index", -1);
        check (ok (r) && at[type] >= 0, String ("load_builtin ") + type + " for the panels fixture");
    }

    // itemId: on every plugin, distinct, and it follows the plugin through a reorder.
    {
        const auto plugins = pluginsOf (ops, tid);
        std::set<String> ids;
        bool everyOneHasId = plugins.size() >= (int) std::size (types);
        for (int i = 0; i < plugins.size(); ++i)
        {
            const auto id = plugins[i].getProperty ("itemId", var()).toString();
            everyOneHasId = everyOneHasId && id.isNotEmpty();
            ids.insert (id);
        }
        check (everyOneHasId, "every plugin in the snapshot carries an itemId");
        check ((int) ids.size() == plugins.size(), "itemIds are distinct within the chain");

        std::map<int, String> idAtIndex;
        int first = 1 << 30;
        for (int i = 0; i < plugins.size(); ++i)
        {
            const int index = (int) plugins[i].getProperty ("index", -1);
            idAtIndex[index] = plugins[i].getProperty ("itemId", var()).toString();
            first = juce::jmin (first, index);
        }
        const auto delayId = idAtIndex[at["delay"]];
        check (ok (command (ops, "reorder_plugin", object ({ { "trackId", tid }, { "index", at["delay"] }, { "toIndex", first } }))),
               "reorder_plugin moves the delay to the head of the chain");
        const auto moved = pluginWithItemId (ops, tid, delayId);
        check ((int) moved.getProperty ("index", -1) == first && moved.getProperty ("type", var()).toString() == "delay",
               "the delay's itemId followed it to its new index");
        std::set<String> idsAfter;
        const auto pluginsAfter = pluginsOf (ops, tid);
        for (int i = 0; i < pluginsAfter.size(); ++i)
            idsAfter.insert (pluginsAfter[i].getProperty ("itemId", var()).toString());
        check (idsAfter == ids, "a reorder keeps every plugin's itemId (none minted, none lost)");
        check (ok (command (ops, "undo")), "undo the reorder");
        bool restored = true;
        for (auto& [index, id] : idAtIndex)
            restored = restored && pluginAt (ops, tid, index).getProperty ("itemId", var()).toString() == id;
        check (restored, "after undo every index holds the itemId it held before");
    }

    // Physical endpoints: phys = min + value * (max - min) for every built-in listed.
    {
        auto range = [&] (int index, int paramIndex, double lo, double hi)
        {
            const auto p = paramOf (ops, tid, index, paramIndex);
            return p.hasProperty ("min") && p.hasProperty ("max")
                && std::abs ((double) p["min"] - lo) < 1.0e-4 && std::abs ((double) p["max"] - hi) < 1.0e-4;
        };
        auto allRanged = [&] (int index, int count)
        {
            const auto params = pluginAt (ops, tid, index).getProperty ("params", var());
            bool all = params.size() == count;
            for (int i = 0; i < params.size(); ++i)
                all = all && params[i].hasProperty ("min") && params[i].hasProperty ("max");
            return all;
        };
        const int eq = at["4bandEq"];
        check (allRanged (eq, 12), "4bandEq publishes min/max on all 12 parameters");
        check (range (eq, 0, 20.0, 20000.0) && range (eq, 1, -20.0, 20.0) && range (eq, 2, 0.1, 4.0)
                   && range (eq, 9, 20.0, 20000.0) && range (eq, 10, -20.0, 20.0) && range (eq, 11, 0.1, 4.0),
               "4bandEq ranges: 20..20000 Hz, -20..20 dB, Q 0.1..4");
        check (allRanged (at["delay"], 2) && range (at["delay"], 0, -30.0, 0.0) && range (at["delay"], 1, 0.0, 1.0),
               "delay: feedback -30..0 dB, mix 0..1");
        check (allRanged (at["pitchShifter"], 1) && range (at["pitchShifter"], 0, -24.0, 24.0), "pitchShifter: -24..24 semitones");
        check (allRanged (at["moshOTT"], 7) && range (at["moshOTT"], 1, 5.0, 500.0) && range (at["moshOTT"], 6, -18.0, 6.0),
               "moshOTT publishes all 7 ranges (time 5..500 ms, output -18..6 dB)");
        check (allRanged (at["softclip"], 2) && range (at["softclip"], 0, 0.0, 24.0) && range (at["softclip"], 1, -12.0, 0.0),
               "softclip: drive 0..24 dB, ceiling -12..0 dBFS");
        check (allRanged (at["moshXFeedback"], 7) && range (at["moshXFeedback"], 3, 50.0, 3000.0),
               "moshXFeedback publishes all 7 ranges (release 50..3000 ms)");
        check (allRanged (at["moshAutoTune"], 9) && range (at["moshAutoTune"], 0, 0.0, 11.0) && range (at["moshAutoTune"], 1, 0.0, 2.0),
               "moshAutoTune publishes all 9 ranges (key 0..11, scale 0..2 index its choices)");
        const auto threshold = paramOf (ops, tid, at["compressor"], 0), ratio = paramOf (ops, tid, at["compressor"], 1);
        check (! threshold.hasProperty ("min") && ! threshold.hasProperty ("max")
                   && ! ratio.hasProperty ("min") && ! ratio.hasProperty ("max"),
               "compressor threshold and ratio still publish no min/max (their encodings are not linear dB)");
        check (range (at["compressor"], 2, 0.3, 200.0), "compressor attack keeps its 0.3..200 ms range");
        check (! pluginAt (ops, tid, at["compressor"]).hasProperty ("state")
                   && ! pluginAt (ops, tid, at["4bandEq"]).hasProperty ("state"),
               "plugins without CachedValue-only settings carry no state object");
    }

    // ── set_plugin_state ──
    section ("Plugin panels: plugin state and set_plugin_state");
    {
        const int delay = at["delay"], chorus = at["chorus"], phaser = at["phaser"];
        const int lowpass = at["lowpass"], highpass = at["highpass"];
        // step 0: the entry must carry no step (number kinds).
        auto entryIs = [&] (int index, const char* key, double value, double lo, double hi, const char* unit, int step)
        {
            const auto e = stateEntry (ops, tid, index, key);
            const bool unitOk = String (unit).isEmpty() ? ! e.hasProperty ("unit") : e.getProperty ("unit", var()).toString() == unit;
            const bool stepOk = step > 0 ? (int) e.getProperty ("step", 0) == step : ! e.hasProperty ("step");
            return std::abs ((double) e.getProperty ("value", -999.0) - value) < 1.0e-4
                && std::abs ((double) e.getProperty ("min", -999.0) - lo) < 1.0e-6
                && std::abs ((double) e.getProperty ("max", -999.0) - hi) < 1.0e-6
                && unitOk && stepOk;
        };
        check (entryIs (delay, "lengthMs", 150.0, 1.0, 2000.0, "ms", 1), "delay state.lengthMs = 150 ms, 1..2000, step 1");
        check (entryIs (chorus, "depthMs", 3.0, 0.1, 20.0, "ms", 0) && entryIs (chorus, "speedHz", 1.0, 0.1, 10.0, "Hz", 0)
                   && entryIs (chorus, "width", 0.5, 0.0, 1.0, "", 0) && entryIs (chorus, "mix", 0.5, 0.0, 1.0, "", 0),
               "chorus state: depthMs, speedHz, width, mix with their defaults and ranges");
        check (entryIs (phaser, "depth", 5.0, 0.0, 8.0, "oct", 0) && entryIs (phaser, "rate", 0.4, 0.05, 10.0, "Hz", 0)
                   && entryIs (phaser, "feedback", 0.7, -0.95, 0.95, "", 0),
               "phaser state: depth, rate, feedback with their defaults and ranges");
        check (entryIs (lowpass, "slope", 12.0, 6.0, 48.0, "dB/oct", 6) && entryIs (highpass, "slope", 12.0, 6.0, 48.0, "dB/oct", 6),
               "lowpass/highpass state.slope = 12 dB/oct, 6..48, step 6");
        {
            const auto lp = stateEntry (ops, tid, lowpass, "mode"), hp = stateEntry (ops, tid, highpass, "mode");
            const auto choices = lp.getProperty ("choices", var());
            check (lp.getProperty ("value", var()).toString() == "lowpass" && hp.getProperty ("value", var()).toString() == "highpass"
                       && choices.size() == 2 && choices[0].toString() == "lowpass" && choices[1].toString() == "highpass"
                       && ! lp.hasProperty ("min"),
                   "lowpass/highpass state.mode with choices [lowpass, highpass]");
        }

        auto setState = [&] (int index, const char* key, var value)
        {
            return command (ops, "set_plugin_state", object ({ { "trackId", tid }, { "index", index }, { "key", key }, { "value", value } }));
        };

        auto r = setState (delay, "lengthMs", 333.6);
        check (ok (r) && (int) dataOf (r).getProperty ("value", -1) == 334 && dataOf (r).getProperty ("key", var()).toString() == "lengthMs",
               "lengthMs 333.6 is applied as the integer 334 and the result says so");
        check ((int) stateValue (ops, tid, delay, "lengthMs") == 334, "the snapshot reads lengthMs 334");
        {
            auto* live = dynamic_cast<te::DelayPlugin*> (livePlugin (eng, tid, delay));
            check (live != nullptr, "the live plugin at the delay's index is a te::DelayPlugin");
            if (live != nullptr)
                check (live->lengthMs.get() == 334, "the DelayPlugin itself holds 334 ms");
        }
        check (ok (command (ops, "undo")) && (int) stateValue (ops, tid, delay, "lengthMs") == 150, "undo restores lengthMs 150");

        r = setState (delay, "lengthMs", 0);
        check (ok (r) && (int) dataOf (r).getProperty ("value", -1) == 1, "lengthMs 0 is clamped to 1 (never a zero-length delay)");
        check (ok (command (ops, "undo")) && (int) stateValue (ops, tid, delay, "lengthMs") == 150, "undo restores lengthMs after the clamp");
        r = setState (delay, "lengthMs", 99999);
        check (ok (r) && (int) stateValue (ops, tid, delay, "lengthMs") == 2000, "lengthMs 99999 is clamped to 2000");
        check (ok (command (ops, "undo")), "undo the 2000 ms clamp");

        r = setState (delay, "lengthMs", "abc");
        check (! ok (r) && errorOf (r).contains ("finite"), "a non-numeric lengthMs is refused");
        check (! ok (setState (delay, "lengthMs", "nan")), "the string \"nan\" is refused");
        check (! ok (setState (delay, "lengthMs", true)), "a boolean lengthMs is refused");
        check (! ok (command (ops, "set_plugin_state", object ({ { "trackId", tid }, { "index", delay }, { "key", "lengthMs" } }))),
               "a missing value is refused");
        r = setState (delay, "bogus", 1);
        check (! ok (r) && errorOf (r).contains ("not a state key") && errorOf (r).contains ("lengthMs"),
               "an unknown key is refused and the error names the allowed keys");
        check (! ok (setState (delay, "depthMs", 5)), "a chorus key on a delay is refused");
        check (! ok (setState (at["compressor"], "mode", "lowpass")), "a plugin type with no state keys refuses every key");
        check (! ok (setState (999, "lengthMs", 10)), "set_plugin_state on a missing plugin is refused");
        check ((int) stateValue (ops, tid, delay, "lengthMs") == 150, "refused calls changed nothing");

        r = setState (chorus, "depthMs", 50);
        check (ok (r) && std::abs ((double) stateValue (ops, tid, chorus, "depthMs") - 20.0) < 1.0e-6, "chorus depthMs 50 is clamped to 20");
        check (ok (command (ops, "undo")) && std::abs ((double) stateValue (ops, tid, chorus, "depthMs") - 3.0) < 1.0e-6,
               "undo restores chorus depthMs 3");
        r = setState (chorus, "speedHz", 2.5);
        check (ok (r) && std::abs ((double) stateValue (ops, tid, chorus, "speedHz") - 2.5) < 1.0e-6, "chorus speedHz 2.5 is applied");
        check (ok (command (ops, "undo")) && std::abs ((double) stateValue (ops, tid, chorus, "speedHz") - 1.0) < 1.0e-6,
               "undo restores chorus speedHz 1");
        r = setState (phaser, "feedback", -2.0);
        check (ok (r) && std::abs ((double) stateValue (ops, tid, phaser, "feedback") + 0.95) < 1.0e-6, "phaser feedback -2 is clamped to -0.95");
        check (ok (command (ops, "undo")) && std::abs ((double) stateValue (ops, tid, phaser, "feedback") - 0.7) < 1.0e-6,
               "undo restores phaser feedback 0.7");

        // The filter mode: the reported type flips with it, and undo flips it back.
        r = setState (lowpass, "mode", "highpass");
        const auto flipped = pluginAt (ops, tid, lowpass);
        check (ok (r) && flipped.getProperty ("type", var()).toString() == "highpass"
                   && flipped.getProperty ("name", var()).toString() == "High-Pass"
                   && stateValue (ops, tid, lowpass, "mode").toString() == "highpass",
               "mode highpass turns the lowpass into a reported \"highpass\"");
        {
            auto* lp = dynamic_cast<te::LowPassPlugin*> (livePlugin (eng, tid, lowpass));
            check (lp != nullptr, "the live plugin at the lowpass's index is a te::LowPassPlugin");
            if (lp != nullptr)
                check (! lp->isLowPass(), "the LowPassPlugin is really in high-pass mode");
        }
        check (ok (command (ops, "undo")) && pluginAt (ops, tid, lowpass).getProperty ("type", var()).toString() == "lowpass",
               "undo turns it back into a \"lowpass\"");
        r = setState (highpass, "mode", "lowpass");
        check (ok (r) && pluginAt (ops, tid, highpass).getProperty ("type", var()).toString() == "lowpass",
               "mode lowpass turns a highpass into a reported \"lowpass\"");
        check (ok (command (ops, "undo")) && pluginAt (ops, tid, highpass).getProperty ("type", var()).toString() == "highpass",
               "undo turns it back into a \"highpass\"");
        check (! ok (setState (lowpass, "mode", "bandpass")) && ! ok (setState (lowpass, "mode", 3)),
               "a mode outside its choices is refused");

        // The slope: snapped onto lo + k * 6 (a tie rounds up), clamped to 6..48, undoable,
        // and what the live filter runs at.
        {
            auto liveSlope = [&] (int index)
            {
                auto* m = dynamic_cast<MoshLowPassPlugin*> (livePlugin (eng, tid, index));
                return m != nullptr ? m->getSlope() : -1;
            };
            const struct { double asked; int applied; } snaps[] = { { 25, 24 }, { 27, 30 }, { 100, 48 }, { 0, 6 }, { 33, 36 }, { 47.9, 48 }, { -7, 6 } };
            for (const auto& c : snaps)
            {
                r = setState (lowpass, "slope", c.asked);
                const String asked (c.asked);
                check (ok (r) && (int) dataOf (r).getProperty ("value", -1) == c.applied && dataOf (r).getProperty ("key", var()).toString() == "slope"
                           && (int) stateValue (ops, tid, lowpass, "slope") == c.applied && liveSlope (lowpass) == c.applied,
                       "slope " + asked + " is applied as " + String (c.applied) + " dB/oct (the result, the snapshot and the live filter agree)");
                check (ok (command (ops, "undo")) && (int) stateValue (ops, tid, lowpass, "slope") == 12 && liveSlope (lowpass) == 12,
                       "undo after slope " + asked + " restores 12 dB/oct");
            }
            r = setState (highpass, "slope", 42);
            check (ok (r) && (int) stateValue (ops, tid, highpass, "slope") == 42 && liveSlope (highpass) == 42, "a highpass takes slope 42 dB/oct");
            check (ok (command (ops, "undo")) && liveSlope (highpass) == 12, "undo restores the highpass to 12 dB/oct");

            check (! ok (setState (lowpass, "slope", "abc")) && ! ok (setState (lowpass, "slope", "nan")) && ! ok (setState (lowpass, "slope", true)),
                   "a string, \"nan\" or boolean slope is refused");
            {
                // NaN and infinities cannot ride a JSON command; the validator refuses them.
                const auto* spec = pluginstate::find ("lowpass", "slope");
                var applied;
                String error;
                check (spec != nullptr && ! pluginstate::coerce (*spec, std::numeric_limits<double>::quiet_NaN(), applied, error)
                           && ! pluginstate::coerce (*spec, std::numeric_limits<double>::infinity(), applied, error)
                           && ! pluginstate::coerce (*spec, -std::numeric_limits<double>::infinity(), applied, error),
                       "a NaN or infinite slope is refused by set_plugin_state's validator");
            }
            check ((int) stateValue (ops, tid, lowpass, "slope") == 12 && liveSlope (lowpass) == 12, "the refused slopes changed nothing");

            // The mode and the slope are separate settings: a flip keeps the slope.
            check (ok (setState (lowpass, "slope", 36)), "slope 36 dB/oct on the lowpass");
            check (ok (setState (lowpass, "mode", "highpass")) && pluginAt (ops, tid, lowpass).getProperty ("type", var()).toString() == "highpass"
                       && (int) stateValue (ops, tid, lowpass, "slope") == 36 && liveSlope (lowpass) == 36,
                   "a mode flip keeps the slope: the now-\"highpass\" runs at 36 dB/oct");
            check (ok (command (ops, "undo")) && pluginAt (ops, tid, lowpass).getProperty ("type", var()).toString() == "lowpass"
                       && (int) stateValue (ops, tid, lowpass, "slope") == 36,
                   "undoing the flip keeps it too");
            check (ok (command (ops, "undo")) && (int) stateValue (ops, tid, lowpass, "slope") == 12 && liveSlope (lowpass) == 12,
                   "undo the slope: 12 dB/oct");

            // Without Mosh's subclass there is no slope: a plain te::LowPassPlugin.
            if (auto* live = livePlugin (eng, tid, lowpass))
            {
                auto plain = tracktionTwin<te::LowPassPlugin> (eng, *live);
                const auto* spec = pluginstate::find ("lowpass", "slope");
                const auto described = pluginstate::describe (*plain, "lowpass");
                check (spec != nullptr && dynamic_cast<MoshLowPassPlugin*> (plain.get()) == nullptr
                           && pluginstate::read (*plain, *spec).isVoid() && ! pluginstate::write (*plain, *spec, 24, nullptr)
                           && ! described.hasProperty ("slope") && described.hasProperty ("mode"),
                       "a plain te::LowPassPlugin has no slope: read() is void (set_plugin_state refuses on it), write() refuses, the state omits it and keeps mode");
            }
        }

        // A value equal to the current one is not an edit: ok, logged undoable:false.
        // (Its other effect, not ending an open gesture window, is checked in the gesture
        // section below.)
        check (ok (setState (delay, "lengthMs", 400)), "lengthMs 400");
        check (ok (setState (delay, "lengthMs", 400)), "lengthMs 400 again (no change) is still ok");
        {
            const auto entries = dataOf (command (ops, "get_command_log", object ({ { "limit", 1 } }))).getProperty ("entries", var());
            const auto last = entries.size() > 0 ? entries[0] : var();
            check (last.getProperty ("command", var()).toString() == "set_plugin_state"
                       && last.hasProperty ("undoable") && ! (bool) last.getProperty ("undoable", true),
                   "the no-change call's JSONL line says undoable:false");
        }
        check (ok (command (ops, "undo")) && (int) stateValue (ops, tid, delay, "lengthMs") == 150,
               "one undo after the no-change call restores 150");
    }

    // ── Gesture coalescing ──
    section ("Plugin panels: gesture coalescing (one drag = one undo step)");
    {
        const int eq = at["4bandEq"];
        const double v0 = paramValue (ops, tid, eq, 0);
        auto drag = [&] (const char* gesture, double value)
        {
            return command (ops, "set_plugin_param", object ({ { "trackId", tid }, { "index", eq }, { "paramIndex", 0 },
                                                               { "value", value }, { "gesture", gesture } }));
        };
        auto near = [] (double a, double b) { return std::abs (a - b) < 1.0e-5; };

        check (ok (drag ("drag-1", 0.2)) && ok (drag ("drag-1", 0.3)) && ok (drag ("drag-1", 0.4)), "three calls in one gesture");
        check (near (paramValue (ops, tid, eq, 0), 0.4), "the parameter follows the drag live (0.4)");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0), "ONE undo restores the value before the drag");

        check (ok (drag ("drag-2", 0.25)) && ok (drag ("drag-3", 0.35)), "two gestures, one call each");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), 0.25), "the first undo stops at the end of the first gesture");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0), "the second undo restores the original");

        const double vol0 = (double) trackVar (ops, tid).getProperty ("volumeDb", 0.0);
        check (ok (drag ("drag-4", 0.2)), "a gesture starts");
        check (ok (command (ops, "set_track_volume", object ({ { "trackId", tid }, { "db", -3.0 } }))), "another command lands mid-gesture");
        check (ok (drag ("drag-4", 0.3)), "the same gesture id continues");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), 0.2)
                   && std::abs ((double) trackVar (ops, tid).getProperty ("volumeDb", 0.0) + 3.0) < 0.01,
               "the intervening command split the gesture: undo takes back only its second half");
        check (ok (command (ops, "undo")) && std::abs ((double) trackVar (ops, tid).getProperty ("volumeDb", 0.0) - vol0) < 0.01,
               "the next undo takes back the other command");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0), "and the next the gesture's first half");

        // An undo ends the window. (JUCE's undo() itself ends with beginNewTransaction(),
        // so a joined perform would still land in a fresh set; that set would be JUCE's
        // unnamed one. The window ending means the call opens a normal named step.)
        auto& um = eng.edit().getUndoManager();
        check (ok (command (ops, "set_track_pan", object ({ { "trackId", tid }, { "pan", 0.3 } }))), "an unrelated pan edit");
        check (ok (drag ("drag-5", 0.2)) && ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0),
               "a gesture, then undo");
        check (! ops.gestureWindowOpenForTest(), "the undo closed the gesture window");
        check (ok (drag ("drag-5", 0.3)), "the same gesture id after the undo");
        check (um.getUndoDescription() == "set_plugin_param",
               "after an undo the gesture opened its own named step (undo head: \"" + um.getUndoDescription() + "\")");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0)
                   && std::abs ((double) trackVar (ops, tid).getProperty ("pan", 0.0) - 0.3) < 0.001,
               "undo takes back the post-undo call only, not the pan edit");
        check (ok (command (ops, "undo")) && std::abs ((double) trackVar (ops, tid).getProperty ("pan", 1.0)) < 0.001, "undo the pan edit");

        // Agent batch: unchanged (the batch is the one step), and a gesture call after
        // the batch does not join it.
        check (ok (command (ops, "batch_begin", object ({ { "name", "panel gesture batch" } }))), "batch_begin");
        check (ok (drag ("drag-6", 0.2)) && ok (drag ("drag-6", 0.3)), "a gesture inside the batch");
        check (ok (command (ops, "batch_end")), "batch_end");
        check (ok (drag ("drag-6", 0.5)), "the same gesture id after the batch");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), 0.3), "undo takes back only the post-batch call");
        check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0), "undo takes back the batch as one step");

        // set_plugin_state takes a gesture too.
        auto len = [&] (const char* gesture, int ms)
        {
            return command (ops, "set_plugin_state", object ({ { "trackId", tid }, { "index", at["delay"] }, { "key", "lengthMs" },
                                                               { "value", ms }, { "gesture", gesture } }));
        };
        check (ok (len ("len-1", 200)) && ok (len ("len-1", 250)) && ok (len ("len-1", 300))
                   && (int) stateValue (ops, tid, at["delay"], "lengthMs") == 300,
               "a lengthMs drag of three calls");
        check (ok (command (ops, "undo")) && (int) stateValue (ops, tid, at["delay"], "lengthMs") == 150,
               "ONE undo restores the length before the drag");

        // A no-change set_plugin_state (no gesture) in the middle of a drag is not an edit,
        // so it does not end the drag's window: the drag still undoes as one step. (Were
        // it to open a transaction, the window would end and undo would stop at 200.)
        check (ok (len ("len-2", 200)), "a lengthMs drag starts (200)");
        check (ok (command (ops, "set_plugin_state", object ({ { "trackId", tid }, { "index", at["delay"] }, { "key", "lengthMs" }, { "value", 200 } }))),
               "a no-change, gesture-less set_plugin_state lands mid-drag");
        check (ok (len ("len-2", 300)), "the drag continues (300)");
        check (ok (command (ops, "undo")) && (int) stateValue (ops, tid, at["delay"], "lengthMs") == 150,
               "ONE undo restores 150: the no-change call did not split the drag");

        // A drag held still. Tracktion's Edit::UndoTransactionTimer closes the current step
        // 350 ms after a change unless a JUCE mouse button is down, and the panels' dials
        // are in the WebView, so MoshOps holds an UndoTransactionInhibitor while a gesture
        // window is open. Pumping the message loop lets that timer really run here.
        {
            auto plain = [&] (double value)
            {
                return command (ops, "set_plugin_param", object ({ { "trackId", tid }, { "index", eq }, { "paramIndex", 0 }, { "value", value } }));
            };
            // This is the selftest's first message-loop pump: let the backlog the earlier
            // sections queued drain first, so the pauses below are what the timer sees.
            pump (1000);
            // Control: the timer does run headless, so the checks after it can fail.
            check (ok (plain (0.15)) && um.getNumActionsInCurrentTransaction() > 0, "control: a gesture-less edit leaves its step open");
            pump (1500);
            check (um.getNumActionsInCurrentTransaction() == 0,
                   "control: after a 1.5 s pause Tracktion's timer has closed that step by itself");
            check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0), "undo the control edit");

            check (ok (drag ("drag-hold", 0.2)), "a drag starts");
            check (ops.gestureWindowOpenForTest(), "the open gesture window holds Tracktion's transaction timer");
            pump (1500);
            check (um.getNumActionsInCurrentTransaction() > 0, "after a 1.5 s pause the drag's step is still open");
            check (ok (drag ("drag-hold", 0.3)) && ok (drag ("drag-hold", 0.4)), "the drag resumes");
            check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0),
                   "ONE undo takes back a drag that paused 1.5 s mid-way");
            check (! ops.gestureWindowOpenForTest(), "the undo released the inhibitor");

            // An idle window closes by itself (MoshOps::timerCallback), and the timer then
            // closes the step: the next call of the same id is a new step.
            check (ok (drag ("drag-idle", 0.2)), "a drag starts and goes idle");
            pump ((int) MoshOps::kGestureIdleMsForTest + 900);
            check (! ops.gestureWindowOpenForTest(), "after the idle timeout the window is closed and the inhibitor released");
            check (um.getNumActionsInCurrentTransaction() == 0, "...and Tracktion's timer has closed the step");
            check (ok (drag ("drag-idle", 0.3)), "the same id after the timeout");
            check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), 0.2),
                   "undo takes back only the call after the timeout");
            check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0), "undo the idle drag's first step");
        }

        // A command that opens no transaction of its own (here: stopping the transport,
        // which is how a recorded take lands) ends the drag's window AND closes its step,
        // so a Tracktion-side write after it (the take, written straight through the
        // Edit's UndoManager) is its own step: one undo must not take the drag with it.
        {
            check (ok (drag ("drag-take", 0.2)), "a drag starts");
            check (ok (command (ops, "set_transport", object ({ { "action", "stop" } }))), "stop (no transaction of its own)");
            check (! ops.gestureWindowOpenForTest(), "the stop ended the drag's window");
            eng.edit().state.setProperty ("moshSelftestTakeMark", 1, &um);   // stands in for the take
            check (ok (command (ops, "undo")) && ! eng.edit().state.hasProperty ("moshSelftestTakeMark")
                       && near (paramValue (ops, tid, eq, 0), 0.2),
                   "undo takes back only the write after the stop, not the drag");
            check (ok (command (ops, "undo")) && near (paramValue (ops, tid, eq, 0), v0), "the next undo takes back the drag");
        }

        // A malformed gesture is an error, not silently ignored, and changes nothing.
        check (! ok (drag ("bad gesture", 0.6)), "a gesture with a space is refused");
        check (! ok (drag ("", 0.6)), "an empty gesture is refused");
        check (! ok (drag (String::repeatedString ("a", 65).toRawUTF8(), 0.6)), "a 65-character gesture is refused");
        check (ok (drag (String::repeatedString ("a", 64).toRawUTF8(), 0.6)) && ok (command (ops, "undo")), "a 64-character gesture is accepted");
        check (! ok (command (ops, "set_plugin_param", object ({ { "trackId", tid }, { "index", eq }, { "paramIndex", 0 },
                                                                 { "value", 0.6 }, { "gesture", 7 } }))),
               "a non-string gesture is refused");
        check (! ok (len ("no/slash", 500)), "set_plugin_state refuses a malformed gesture too");
        check (near (paramValue (ops, tid, eq, 0), v0) && (int) stateValue (ops, tid, at["delay"], "lengthMs") == 150,
               "refused gestures changed nothing");
    }

    // ── The plugin_meters rail ──
    section ("Plugin panels: plugin_meters (compressor, soft clip, OTT, X-FDBK)");
    {
        auto setParam = [&] (int index, int paramIndex, double value)
        {
            return ok (command (ops, "set_plugin_param", object ({ { "trackId", tid }, { "index", index }, { "paramIndex", paramIndex }, { "value", value } })));
        };
        (void) ops.pluginMeters();   // drain whatever earlier sections left
        check (ops.pluginMeters().getProperty ("plugins", var()).size() == 0, "nothing is live before any audio is processed");

        const int compIdx = at["compressor"];
        auto* compPlugin = livePlugin (eng, tid, compIdx);
        auto* comp = dynamic_cast<MoshCompressorPlugin*> (compPlugin);
        // Guard on Tracktion's init order (MoshEngine.cpp, autoInitialiseDeviceManager).
        check (comp != nullptr, "a loaded \"compressor\" is a MoshCompressorPlugin (registered before Tracktion's own)");
        if (comp != nullptr)
        {
            // Threshold to its floor (0.01 = -40 dB); 2:1 by the encoding (ratio slope 0.5).
            check (setParam (compIdx, 0, 0.0) && setParam (compIdx, 1, 0.5 / 0.95), "compressor threshold -40 dB, ratio 2:1");
            const double thresh = comp->thresholdGain.getCurrentValue(), rat = comp->ratio.getCurrentValue();
            // A DC level of A on both channels: the detector settles at exactly A, so the
            // static curve is exact: gain = (t + (A - t) * ratio) / A.
            const double A = 0.5;
            const double expectedGr = -db ((thresh + (A - thresh) * rat) / A);
            auto dc = signal (2, 0.5, [A] (int, int) { return (float) A; });
            drive (*comp, dc, 256);
            juce::int64 firstSeq = -1;
            {
                const auto payload = ops.pluginMeters();
                const auto m = meterFor (payload, tid, compIdx);
                check (m.isObject(), "the compressor reports a live meter after processing audio");
                check (m.getProperty ("type", var()).toString() == "compressor"
                           && m.getProperty ("itemId", var()).toString() == pluginAt (ops, tid, compIdx).getProperty ("itemId", var()).toString(),
                       "the meter names its type and the plugin's itemId");
                firstSeq = m.hasProperty ("seq") ? (juce::int64) m.getProperty ("seq", -1) : -1;
                check (firstSeq >= 1, "...and carries a frame counter seq (" + m.getProperty ("seq", var()).toString() + ")");
                const double gr = (double) m.getProperty ("grDb", -1.0);
                check (std::abs (gr - expectedGr) < 0.1,
                       "compressor grDb " + String (gr, 3) + " matches the static curve " + String (expectedGr, 3) + " dB (within 0.1 dB)");
                check (std::abs ((double) m.getProperty ("inDb", 0.0) - db (A)) < 0.05, "compressor inDb is the input peak (-6.02 dBFS)");
                check ((double) m.getProperty ("outDb", 0.0) <= (double) m.getProperty ("inDb", 0.0) + 0.01,
                       "compressor outDb is no louder than its input at 0 dB makeup");
                bool onlyMeteredTypes = true;
                const auto entries = payload.getProperty ("plugins", var());
                for (int i = 0; i < entries.size(); ++i)
                    onlyMeteredTypes = onlyMeteredTypes && entries[i].getProperty ("trackId", var()).toString() == tid
                                       && (int) entries[i].getProperty ("index", -1) == compIdx;
                check (onlyMeteredTypes, "only the plugin that processed audio is on the rail");
            }
            check (! meterFor (ops.pluginMeters(), tid, compIdx).isObject(),
                   "asked again with no new audio, the compressor meter is gone (never stale)");

            // Makeup gain is excluded from gain reduction.
            check (setParam (compIdx, 4, (6.0 + 10.0) / 34.0), "compressor makeup +6 dB");
            auto dc2 = signal (2, 0.5, [A] (int, int) { return (float) A; });
            drive (*comp, dc2, 256);
            {
                const auto m = meterFor (ops.pluginMeters(), tid, compIdx);
                const double gr = (double) m.getProperty ("grDb", -1.0);
                check (std::abs (gr - expectedGr) < 0.1, "with +6 dB makeup grDb is still " + String (gr, 3) + " dB (makeup excluded)");
                check ((juce::int64) m.getProperty ("seq", -1) == firstSeq + 1,
                       "the compressor's next reported frame has seq " + String (firstSeq + 1) + " (an empty take in between does not count)");
            }
            check (ok (command (ops, "undo")), "undo the makeup change");

            // Quiet input never reaches the threshold: no gain reduction.
            auto quiet = signal (2, 0.25, [] (int, int i) { return sine (1000.0, i, 0.005f); });
            drive (*comp, quiet, 256);
            {
                const auto m = meterFor (ops.pluginMeters(), tid, compIdx);
                check (m.isObject() && (double) m.getProperty ("grDb", 99.0) < 0.05, "below threshold the compressor reports ~0 dB of reduction");
                check (std::abs ((double) m.getProperty ("inDb", 0.0) - db (0.005)) < 0.1, "and the quiet input's peak (-46 dBFS)");
            }

            // A transient: the meter MEASURES the gain applied, it does not evaluate the static
            // curve at the input peak. Threshold -6 dB, 2:1, attack 100 ms, 10 ms of DC 0.9:
            // the detector climbs only to about 0.33, under the 0.5 threshold, so nothing is
            // reduced yet, while the static curve at 0.9 would say about 2.2 dB.
            check (setParam (compIdx, 0, (0.5 - 0.01) / 0.99) && setParam (compIdx, 2, (100.0 - 0.3) / 199.7),
                   "compressor threshold -6 dB, attack 100 ms");
            {
                const double t = comp->thresholdGain.getCurrentValue(), r = comp->ratio.getCurrentValue();
                const double peak = 0.9, staticGr = -db ((t + (peak - t) * r) / peak);
                auto burst = signal (2, 0.01, [peak] (int, int) { return (float) peak; });
                drive (*comp, burst, 240);
                const auto m = meterFor (ops.pluginMeters(), tid, compIdx);
                const double gr = (double) m.getProperty ("grDb", 99.0);
                check (staticGr > 1.5, "the static curve at the burst's peak is " + String (staticGr, 2) + " dB (so the case discriminates)");
                check (m.isObject() && gr < 0.1,
                       "a 10 ms burst under a 100 ms attack: grDb " + String (gr, 3) + " (measured ~0, not the static curve's "
                           + String (staticGr, 2) + " dB)");
            }
            check (ok (command (ops, "undo")) && ok (command (ops, "undo")), "undo the attack and threshold changes");

            // The audio is Tracktion's, bit for bit: the same input through a genuine
            // te::CompressorPlugin with the same state.
            {
                auto tree = comp->state.createCopy();
                tree.removeProperty (te::IDs::id, nullptr);
                te::EditItemID::readOrCreateNewID (eng.edit(), tree);
                te::Plugin::Ptr plain (new te::CompressorPlugin (te::PluginCreationInfo (eng.edit(), tree, false)));
                check (dynamic_cast<MoshCompressorPlugin*> (plain.get()) == nullptr, "the reference is Tracktion's own CompressorPlugin");
                auto music = [] (int ch, int i)
                {
                    const float swell = 0.5f + 0.5f * (float) std::sin (juce::MathConstants<double>::twoPi * 1.5 * i / 48000.0);
                    return swell * (sine (220.0 + 3.0 * ch, i, 0.6f) + sine (1760.0, i, 0.2f)) + (i % 4800 < 48 ? 0.4f : 0.0f);
                };
                auto viaMosh = signal (2, 1.0, music), viaTracktion = signal (2, 1.0, music);
                drive (*comp, viaMosh, 256);
                drive (*plain, viaTracktion, 256);
                int differing = 0;
                for (int ch = 0; ch < 2; ++ch)
                    for (int i = 0; i < viaMosh.getNumSamples(); ++i)
                        if (std::memcmp (viaMosh.getReadPointer (ch) + i, viaTracktion.getReadPointer (ch) + i, sizeof (float)) != 0)
                            ++differing;
                check (differing == 0, "MoshCompressorPlugin's output is bit-identical to te::CompressorPlugin ("
                                           + String (differing) + " samples differ)");
                (void) ops.pluginMeters();
            }

            // A bypassed plugin is never on the rail, whatever runs through it.
            check (ok (command (ops, "bypass_plugin", object ({ { "trackId", tid }, { "index", compIdx }, { "bypassed", true } }))), "bypass the compressor");
            auto dc3 = signal (2, 0.25, [A] (int, int) { return (float) A; });
            drive (*comp, dc3, 256);
            check (! meterFor (ops.pluginMeters(), tid, compIdx).isObject(), "a bypassed compressor reports no meter");
            check (ok (command (ops, "undo")), "un-bypass the compressor");


            // An undone removal. Tracktion's PluginCache can hand the undo the SAME plugin
            // object, so blocks it ran before the removal are still unread in its latch;
            // pluginMeters must consume them, not report them as live.
            {
                te::Plugin::Ptr held (comp);
                auto before = signal (2, 0.25, [A] (int, int) { return (float) A; });
                drive (*comp, before, 256);   // published, not taken
                check (ok (command (ops, "remove_plugin", object ({ { "trackId", tid }, { "index", compIdx } }))),
                       "remove the compressor while it holds an unread reading");
                (void) ops.pluginMeters();   // a rail tick while it is out of the chain
                check (ok (command (ops, "undo")), "undo the removal");
                check (livePlugin (eng, tid, compIdx) == comp,
                       "the undone removal brought back the same plugin object (so its latch still held the old reading)");
                check (! meterFor (ops.pluginMeters(), tid, compIdx).isObject(),
                       "the first tick after the undo reports nothing: the pre-removal reading is consumed, not shown");
                auto after = signal (2, 0.25, [A] (int, int) { return (float) A; });
                drive (*comp, after, 256);
                check (meterFor (ops.pluginMeters(), tid, compIdx).isObject(), "audio processed after the undo is reported again");
            }
        }

        // Soft clip: y = c * tanh (g x / c); gain reduction 20 log10 (g |x| / |y|) at the peak.
        {
            const int sc = at["softclip"];
            auto* clip = livePlugin (eng, tid, sc);
            const double g = std::pow (10.0, 6.0 / 20.0), c = std::pow (10.0, -0.5 / 20.0);   // defaults: drive 6 dB, ceiling -0.5 dBFS
            const double peak = 0.9, z = peak * g / c;
            auto loud = signal (2, 0.25, [peak] (int, int i) { return sine (1000.0, i, (float) peak); });
            if (clip != nullptr) drive (*clip, loud, 256);
            const auto m = meterFor (ops.pluginMeters(), tid, sc);
            check (m.isObject() && m.getProperty ("type", var()).toString() == "softclip", "the soft clipper reports a live meter");
            const double gr = (double) m.getProperty ("grDb", -1.0), expected = db (z / std::tanh (z));
            check (std::abs (gr - expected) < 0.05, "softclip grDb " + String (gr, 3) + " matches the tanh curve " + String (expected, 3) + " dB");
            check (std::abs ((double) m.getProperty ("inDb", 0.0) - db (peak)) < 0.05
                       && std::abs ((double) m.getProperty ("outDb", 0.0) - db (c * std::tanh (z))) < 0.05,
                   "softclip inDb/outDb are the input and output peaks");
            auto soft = signal (2, 0.25, [] (int, int i) { return sine (1000.0, i, 0.001f); });
            if (clip != nullptr) drive (*clip, soft, 256);
            check ((double) meterFor (ops.pluginMeters(), tid, sc).getProperty ("grDb", 99.0) < 0.01, "a quiet signal passes the soft clipper with ~0 dB reduction");
        }

        // OTT: a loud low band is cut, a quiet one is lifted.
        {
            const int ott = at["moshOTT"];
            auto* plugin = livePlugin (eng, tid, ott);
            check (setParam (ott, 0, 1.0), "OTT amount 100%");
            auto loud = signal (2, 1.0, [] (int, int i) { return sine (110.0, i, 0.8f); });
            if (plugin != nullptr) drive (*plugin, loud, 256);
            const auto m = meterFor (ops.pluginMeters(), tid, ott);
            const auto bands = m.getProperty ("bands", var());
            check (m.isObject() && bands.size() == 3 && m.getProperty ("clipped", var()).isBool(), "OTT reports three bands and a clip flag");
            check ((double) bands[0].getProperty ("levelDb", -100.0) > -20.0 && (double) bands[0].getProperty ("gainDb", 0.0) < -1.0,
                   "a loud low band: level above -20 dB and a downward cut (" + bands[0].getProperty ("gainDb", 0.0).toString() + " dB)");
            {
                // levelDb is the band envelope's peak: the same signal through an OTTCore
                // with the plugin's time constant must give the same number.
                const auto tp = paramOf (ops, tid, ott, 1);
                const double timeMs = (double) tp.getProperty ("min", 0.0)
                                      + (double) tp.getProperty ("value", 0.0)
                                            * ((double) tp.getProperty ("max", 0.0) - (double) tp.getProperty ("min", 0.0));
                moshfx::OTTSettings reference;
                reference.amount = 1.0f;
                reference.timeMs = (float) timeMs;
                moshfx::OTTCore core;
                core.prepare (48000.0);
                auto mono = signal (1, 1.0, [] (int, int i) { return sine (110.0, i, 0.8f); });
                float peakEnvelope = 0.0f;
                for (int start = 0; start < mono.getNumSamples(); start += 256)
                {
                    core.processBlock (mono.getWritePointer (0, start), juce::jmin (256, mono.getNumSamples() - start), reference);
                    peakEnvelope = juce::jmax (peakEnvelope, core.lastBlockMeter().peakEnvelope[0]);
                }
                const double expectedLevel = MoshLiveMetered::meterDb (peakEnvelope);
                const double level = (double) bands[0].getProperty ("levelDb", 0.0);
                check (std::abs (level - expectedLevel) < 0.01,
                       "the low band's levelDb " + String (level, 3) + " is its envelope peak " + String (expectedLevel, 3) + " dB");
            }
            check (! meterFor (ops.pluginMeters(), tid, ott).isObject(), "a second take with no new audio is empty");
            auto quietLow = signal (2, 1.0, [] (int, int i) { return sine (110.0, i, 0.003f); });
            if (plugin != nullptr) drive (*plugin, quietLow, 256);
            const auto q = meterFor (ops.pluginMeters(), tid, ott).getProperty ("bands", var());
            check (q.size() == 3 && (double) q[0].getProperty ("gainDb", 0.0) > 0.5,
                   "a quiet low band is lifted (" + q[0].getProperty ("gainDb", 0.0).toString() + " dB)");
            check (ok (command (ops, "bypass_plugin", object ({ { "trackId", tid }, { "index", ott }, { "bypassed", true } }))), "bypass OTT");
            auto again = signal (2, 0.25, [] (int, int i) { return sine (110.0, i, 0.8f); });
            if (plugin != nullptr) drive (*plugin, again, 256);
            check (! meterFor (ops.pluginMeters(), tid, ott).isObject(), "a bypassed OTT reports no meter");
            check (ok (command (ops, "undo")), "un-bypass OTT");
        }

        // X-FDBK: a squeal over noise is found and, with auto-suppress, cut.
        {
            const int xf = at["moshXFeedback"];
            auto* plugin = livePlugin (eng, tid, xf);
            check (setParam (xf, 0, 0.85) && setParam (xf, 4, 1.0), "X-FDBK sensitivity 0.85, auto-suppress on");
            juce::Random random (20261005);
            auto squeal = signal (2, 1.0, [&random] (int, int i) { return sine (2600.0, i, 0.35f) + 0.05f * (random.nextFloat() * 2.0f - 1.0f); });
            if (plugin != nullptr) drive (*plugin, squeal, 2048);
            const auto m = meterFor (ops.pluginMeters(), tid, xf);
            const auto candidates = m.getProperty ("candidates", var()), cuts = m.getProperty ("cuts", var());
            check (m.isObject() && candidates.isArray() && cuts.isArray(), "X-FDBK reports candidates and cuts");
            bool foundSqueal = false, cutHasDepth = false;
            for (int i = 0; i < candidates.size(); ++i)
                foundSqueal = foundSqueal || std::abs ((double) candidates[i].getProperty ("hz", 0.0) / 2600.0 - 1.0) < 0.03;
            for (int i = 0; i < cuts.size(); ++i)
            {
                foundSqueal = foundSqueal || std::abs ((double) cuts[i].getProperty ("hz", 0.0) / 2600.0 - 1.0) < 0.03;
                cutHasDepth = cutHasDepth || (double) cuts[i].getProperty ("depthDb", 0.0) > 0.0;
            }
            check (foundSqueal, "the 2.6 kHz squeal is among X-FDBK's live candidates or cuts");
            check (cutHasDepth, "an active cut carries its depth");
            check (! meterFor (ops.pluginMeters(), tid, xf).isObject(), "the X-FDBK frame is not reported twice");
        }

        // AutoTune keeps its own rail: the meters never read (and so never steal) its pitch.
        {
            const int tune = at["moshAutoTune"];
            auto* plugin = livePlugin (eng, tid, tune);
            auto voice = signal (1, 0.5, [] (int, int i)
            {
                double v = 0.0;
                for (int h = 1; h <= 6; ++h)
                    v += std::sin (juce::MathConstants<double>::twoPi * 220.0 * h * i / 48000.0) / h;
                return (float) (0.2 * v);
            });
            if (plugin != nullptr) drive (*plugin, voice, 256);
            check (! meterFor (ops.pluginMeters(), tid, tune).isObject(), "Mosh AutoTune is never on plugin_meters");
            const auto tuners = ops.tunerReadings().getProperty ("tuners", var());
            bool stillThere = false;
            for (int i = 0; i < tuners.size(); ++i)
                stillThere = stillThere || (tuners[i].getProperty ("trackId", var()).toString() == tid
                                            && (int) tuners[i].getProperty ("index", -1) == tune);
            check (stillThere, "...and its pitch reading is still there for the tuner rail afterwards");
        }
    }

    // ── Delay and chorus: lines sized on the message thread, audio unchanged ──
    section ("Plugin panels: delay and chorus lines sized off the audio thread");
    {
        auto* delay = dynamic_cast<MoshDelayPlugin*> (livePlugin (eng, tid, at["delay"]));
        auto* chorus = dynamic_cast<MoshChorusPlugin*> (livePlugin (eng, tid, at["chorus"]));
        // Guards on Tracktion's init order (MoshEngine.cpp, autoInitialiseDeviceManager).
        check (delay != nullptr, "a loaded \"delay\" is a MoshDelayPlugin (registered before Tracktion's own)");
        check (chorus != nullptr, "a loaded \"chorus\" is a MoshChorusPlugin (registered before Tracktion's own)");

        // The sizing each subclass hands its base initialise() covers what the base's
        // applyToBuffer asks for at set_plugin_state's ceiling, at every length it can
        // start from (ensureMaxBufferSize(n) grows only when n exceeds the sized length).
        bool delayCovers = true, chorusCovers = true;
        for (double rate : { 22050.0, 44100.0, 48000.0, 88200.0, 96000.0, 192000.0 })
        {
            const int delayCeiling = (int) (MoshDelayPlugin::kMaxLengthMs * rate / 1000.0);
            for (int lengthMs : { 1, 2, 150, 999, 1999, 2000 })
                delayCovers = delayCovers && (int) (lengthMs * MoshDelayPlugin::sizingRate (rate, lengthMs) / 1000.0) > delayCeiling;
            const int chorusCeiling = juce::roundToInt ((MoshChorusPlugin::lineLengthMs (MoshChorusPlugin::kMaxDepthMs) * rate) / 1000.0);
            for (float depthMs : { 0.1f, 0.5f, 3.0f, 7.5f, 19.9f, 20.0f })
                chorusCovers = chorusCovers
                               && juce::roundToInt ((MoshChorusPlugin::lineLengthMs (depthMs) * MoshChorusPlugin::sizingRate (rate, depthMs)) / 1000.0)
                                      > chorusCeiling;
        }
        check (delayCovers, "MoshDelayPlugin sizes its line for 2000 ms from any starting length (22.05-192 kHz)");
        check (chorusCovers, "MoshChorusPlugin sizes its line for a 20 ms depth from any starting depth (22.05-192 kHz)");
        check (MoshChorusPlugin::lineLengthMs (MoshChorusPlugin::kMaxDepthMs) == 41, "the chorus ceiling line is 1 + round (20 + 20) = 41 ms");

        auto music = [] (int ch, int i)
        {
            const float swell = 0.5f + 0.5f * (float) std::sin (juce::MathConstants<double>::twoPi * 1.5 * i / 48000.0);
            return swell * (sine (220.0 + 3.0 * ch, i, 0.5f) + sine (1760.0, i, 0.2f)) + (i % 4800 < 48 ? 0.3f : 0.0f);
        };
        // Bit-identical to Tracktion's own, including a length that GROWS mid-stream (the
        // case where Tracktion's would reallocate on the audio thread and Mosh's does not).
        if (delay != nullptr)
        {
            auto twin = tracktionTwin<te::DelayPlugin> (eng, *delay);
            check (dynamic_cast<MoshDelayPlugin*> (twin.get()) == nullptr, "the delay reference is Tracktion's own DelayPlugin");
            auto grow = [] (te::Plugin& p) { if (auto* d = dynamic_cast<te::DelayPlugin*> (&p)) d->lengthMs.setValue (1200, nullptr); };
            auto viaMosh = signal (2, 1.0, music), viaTracktion = signal (2, 1.0, music);
            driveWithChange (*delay, viaMosh, 256, grow);
            driveWithChange (*twin, viaTracktion, 256, grow);
            const int differing = samplesDiffering (viaMosh, viaTracktion);
            check (differing == 0, "MoshDelayPlugin's output is bit-identical to te::DelayPlugin, 150 -> 1200 ms mid-stream ("
                                       + String (differing) + " samples differ)");
            float wet = 0.0f;
            for (int i = 0; i < viaMosh.getNumSamples(); ++i)
                wet = juce::jmax (wet, std::abs (viaMosh.getSample (0, i) - music (0, i)));
            check (wet > 0.01f, "...and the delay really processed (its output differs from the dry input)");
            delay->lengthMs.setValue (150, nullptr);
        }
        if (chorus != nullptr)
        {
            auto twin = tracktionTwin<te::ChorusPlugin> (eng, *chorus);
            check (dynamic_cast<MoshChorusPlugin*> (twin.get()) == nullptr, "the chorus reference is Tracktion's own ChorusPlugin");
            auto deepen = [] (te::Plugin& p) { if (auto* c = dynamic_cast<te::ChorusPlugin*> (&p)) c->depthMs.setValue (18.0f, nullptr); };
            auto viaMosh = signal (2, 1.0, music), viaTracktion = signal (2, 1.0, music);
            driveWithChange (*chorus, viaMosh, 256, deepen);
            driveWithChange (*twin, viaTracktion, 256, deepen);
            const int differing = samplesDiffering (viaMosh, viaTracktion);
            check (differing == 0, "MoshChorusPlugin's output is bit-identical to te::ChorusPlugin, depth 3 -> 18 ms mid-stream ("
                                       + String (differing) + " samples differ)");
            chorus->depthMs.setValue (3.0f, nullptr);
        }
    }

    // ── Low/high-pass slope: Tracktion's filter at 12 dB/oct, a Butterworth cascade otherwise ──
    section ("Plugin panels: low/high-pass slope (Tracktion's filter at 12 dB/oct)");
    {
        auto* lowpass = dynamic_cast<MoshLowPassPlugin*> (livePlugin (eng, tid, at["lowpass"]));
        auto* highpass = dynamic_cast<MoshLowPassPlugin*> (livePlugin (eng, tid, at["highpass"]));
        // Guards on Tracktion's init order (MoshEngine.cpp, autoInitialiseDeviceManager).
        check (lowpass != nullptr, "a loaded \"lowpass\" is a MoshLowPassPlugin (registered before Tracktion's own)");
        check (highpass != nullptr, "a loaded \"highpass\" is a MoshLowPassPlugin too");

        if (lowpass != nullptr)
        {
            // Bit-identical to te::LowPassPlugin at 12 dB/oct, through a cutoff change and a
            // mode flip mid-stream. Both are built from the live filter's state (so the
            // session itself is not touched by the changes).
            auto mosh = tracktionTwin<MoshLowPassPlugin> (eng, *lowpass);
            auto plain = tracktionTwin<te::LowPassPlugin> (eng, *lowpass);
            check (dynamic_cast<MoshLowPassPlugin*> (plain.get()) == nullptr && dynamic_cast<MoshLowPassPlugin*> (mosh.get()) != nullptr
                       && dynamic_cast<MoshLowPassPlugin*> (mosh.get())->getSlope() == 12,
                   "the reference is Tracktion's own LowPassPlugin; Mosh's twin runs at 12 dB/oct");
            auto music = [] (int ch, int i)
            {
                const float swell = 0.5f + 0.5f * (float) std::sin (juce::MathConstants<double>::twoPi * 1.5 * i / 48000.0);
                return swell * (sine (220.0 + 3.0 * ch, i, 0.5f) + sine (5200.0, i, 0.2f)) + (i % 4800 < 48 ? 0.3f : 0.0f);
            };
            constexpr int block = 256, cutoffAt = 62 * block, flipAt = 125 * block;
            auto schedule = [] (te::Plugin& p, int start)
            {
                auto* lp = dynamic_cast<te::LowPassPlugin*> (&p);
                if (lp == nullptr) return;
                if (start == cutoffAt) lp->frequency->setParameterWithoutUndo (1500.0f, juce::dontSendNotification);
                if (start == flipAt) lp->mode.setValue ("highpass", nullptr);
            };
            auto viaMosh = signal (2, 1.0, music), viaTracktion = signal (2, 1.0, music);
            driveScheduled (*mosh, viaMosh, block, schedule);
            driveScheduled (*plain, viaTracktion, block, schedule);
            const int differing = samplesDiffering (viaMosh, viaTracktion);
            check (differing == 0, "MoshLowPassPlugin at 12 dB/oct is bit-identical to te::LowPassPlugin, 4 kHz LP -> 1.5 kHz -> high-pass mid-stream ("
                                       + String (differing) + " samples differ)");
            float wet = 0.0f;
            for (int i = 0; i < viaMosh.getNumSamples(); ++i)
                wet = juce::jmax (wet, std::abs (viaMosh.getSample (0, i) - music (0, i)));
            check (wet > 0.05f, "...and the filter really processed (its output differs from the dry input)");

            // Steady-state attenuation per slope: a sine an octave beyond a 1 kHz cutoff
            // (2 kHz for low-pass, 500 Hz for high-pass), measured on the second half,
            // against the Butterworth closed form (MoshFilterDesign.h).
            for (bool lowPassMode : { true, false })
                for (int slopeDb = 6; slopeDb <= 48; slopeDb += 6)
                {
                    auto twin = tracktionTwin<MoshLowPassPlugin> (eng, *lowpass);
                    auto* f = dynamic_cast<MoshLowPassPlugin*> (twin.get());
                    if (f == nullptr) continue;
                    f->mode.setValue (lowPassMode ? "lowpass" : "highpass", nullptr);
                    f->slope.setValue (slopeDb, nullptr);
                    f->frequency->setParameterWithoutUndo (1000.0f, juce::dontSendNotification);
                    const double fc = f->frequency->getCurrentValue(), hz = lowPassMode ? 2000.0 : 500.0;
                    auto tone = signal (1, 1.0, [hz] (int, int i) { return sine (hz, i, 0.5f); });
                    drive (*f, tone, block);
                    double sumOut = 0.0, sumIn = 0.0;
                    for (int i = tone.getNumSamples() / 2; i < tone.getNumSamples(); ++i)
                    {
                        sumOut += (double) tone.getSample (0, i) * tone.getSample (0, i);
                        sumIn += (double) sine (hz, i, 0.5f) * sine (hz, i, 0.5f);
                    }
                    const double measured = 10.0 * std::log10 (sumOut / sumIn);
                    const double expected = moshfx::filterdesign::closedFormDb (lowPassMode, slopeDb / 6, 48000.0, fc, hz);
                    check (f->getSlope() == slopeDb && std::abs (measured - expected) < 0.1,
                           String (lowPassMode ? "LP" : "HP") + " 1 kHz at " + String (slopeDb) + " dB/oct: " + String (hz, 0) + " Hz measured "
                               + String (measured, 3) + " dB vs the closed form " + String (expected, 3) + " dB (within 0.1 dB)");
                }

            // A slope change mid-stream (12 -> 48 at a block boundary) crossfades into the
            // new cascade: every sample finite and within the +-3 clamp, no sample-to-sample
            // jump larger than the dry signal's own largest, and once the fade is over the
            // output converges on a filter that ran at 48 dB/oct throughout.
            {
                auto changed = tracktionTwin<MoshLowPassPlugin> (eng, *lowpass);
                auto steady = tracktionTwin<MoshLowPassPlugin> (eng, *lowpass);
                if (auto* s48 = dynamic_cast<MoshLowPassPlugin*> (steady.get()))
                    s48->slope.setValue (48, nullptr);
                auto out = signal (2, 1.0, music), ref = signal (2, 1.0, music);
                driveWithChange (*changed, out, block, [] (te::Plugin& p)
                {
                    if (auto* m = dynamic_cast<MoshLowPassPlugin*> (&p))
                        m->slope.setValue (48, nullptr);
                });
                drive (*steady, ref, block);
                bool finite = true;
                float peak = 0.0f, maxStep = 0.0f, dryStep = 0.0f, tailDiff = 0.0f;
                for (int ch = 0; ch < 2; ++ch)
                    for (int i = 0; i < out.getNumSamples(); ++i)
                    {
                        const float y = out.getSample (ch, i);
                        finite = finite && std::isfinite (y);
                        peak = juce::jmax (peak, std::abs (y));
                        if (i > 0)
                        {
                            maxStep = juce::jmax (maxStep, std::abs (y - out.getSample (ch, i - 1)));
                            dryStep = juce::jmax (dryStep, std::abs (music (ch, i) - music (ch, i - 1)));
                        }
                        if (i >= out.getNumSamples() - 4800)
                            tailDiff = juce::jmax (tailDiff, std::abs (y - ref.getSample (ch, i)));
                    }
                auto* m = dynamic_cast<MoshLowPassPlugin*> (changed.get());
                check (m != nullptr && m->getSlope() == 48, "the twin now runs at 48 dB/oct");
                check (finite && peak <= 3.0f, "slope 12 -> 48 mid-stream: every sample finite, peak " + String (peak, 3) + " (<= 3)");
                check (maxStep <= dryStep, "...no sample-to-sample jump beyond the dry signal's largest (" + String (maxStep, 4)
                                               + " <= " + String (dryStep, 4) + ")");
                check (tailDiff < 1.0e-4f, "...and the last 0.1 s matches a filter run at 48 dB/oct throughout (max difference "
                                               + String (tailDiff, 7) + ")");
            }
        }
    }

    // ── 4OSC: every parameter with its JUCE range, its state keys, its live keys ──
    section ("Plugin panels: 4OSC parameters, state and live keys");
    {
        // Every other type's parameters are byte-identical to what pluginToVar emitted
        // before the 4OSC work: at most 16, and each object exactly the legacy one (no id,
        // skew, symmetricSkew or step), and no plugin but the 4OSC carries modRoutes.
        {
            const auto plugins = pluginsOf (ops, tid);
            int compared = 0, expectedCount = 0, differing = 0;
            std::set<String> typesCompared;
            bool noModRoutes = true, capped = true;
            String firstDifference;
            for (int k = 0; k < plugins.size(); ++k)
            {
                const int index = (int) plugins[k].getProperty ("index", -1);
                auto* live = livePlugin (eng, tid, index);
                if (live == nullptr || dynamic_cast<te::FourOscPlugin*> (live) != nullptr)
                    continue;
                typesCompared.insert (plugins[k].getProperty ("type", var()).toString());
                expectedCount += juce::jmin (16, live->getNumAutomatableParameters());
                noModRoutes = noModRoutes && ! plugins[k].hasProperty ("modRoutes");
                const auto params = plugins[k].getProperty ("params", var());
                capped = capped && params.size() == juce::jmin (16, live->getNumAutomatableParameters());
                for (int i = 0; i < params.size(); ++i)
                {
                    auto param = live->getAutomatableParameter (i);
                    const std::optional<juce::Range<float>> range = params[i].hasProperty ("min")
                        ? std::optional<juce::Range<float>> (param->getValueRange()) : std::nullopt;
                    const auto expected = juce::JSON::toString (legacyParamVar (*param, i, range), true);
                    const auto actual = juce::JSON::toString (params[i], true);
                    ++compared;
                    if (expected != actual)
                    {
                        ++differing;
                        if (firstDifference.isEmpty())
                            firstDifference = plugins[k].getProperty ("type", var()).toString() + " #" + String (i) + ": " + actual;
                    }
                }
            }
            check (typesCompared.size() >= 12 && compared == expectedCount && compared >= 40 && differing == 0,
                   "every other plugin type's params are byte-identical to the legacy payload (" + String (compared)
                       + " parameter objects over " + String ((int) typesCompared.size()) + " types, " + String (differing) + " differ"
                       + (firstDifference.isEmpty() ? String() : ": " + firstDifference) + ")");
            check (capped, "every other plugin type keeps the 16-parameter cap");
            check (noModRoutes, "no other plugin type carries modRoutes");
        }

        const auto ft = dataOf (command (ops, "create_track", object ({ { "name", "4OSC Panel" } }))).getProperty ("trackId", var()).toString();
        const auto loaded = command (ops, "load_builtin", object ({ { "trackId", ft }, { "type", "4osc" } }));
        const int fo = (int) dataOf (loaded).getProperty ("index", -1);
        check (ft.isNotEmpty() && ok (loaded) && fo >= 0, "load_builtin 4osc on its own track");
        auto* synth = dynamic_cast<MoshFourOscPlugin*> (livePlugin (eng, ft, fo));
        // Guard on Tracktion's init order (MoshEngine.cpp, autoInitialiseDeviceManager).
        check (synth != nullptr, "a loaded \"4osc\" is a MoshFourOscPlugin (registered before Tracktion's own)");
        {
            // The default instrument a MIDI clip brings (ensureDefaultInstrument).
            const auto dt = dataOf (command (ops, "create_track", object ({ { "name", "4OSC Default" } }))).getProperty ("trackId", var()).toString();
            const bool clipOk = ok (command (ops, "add_midi_clip", object ({ { "trackId", dt }, { "length", 1.0 } })));
            bool isMosh = false, sawFourOsc = false;
            for (auto* t : te::getAudioTracks (eng.edit()))
                if (t != nullptr && t->itemID.toString() == dt)
                    for (auto* plugin : t->pluginList.getPlugins())
                        if (plugin != nullptr && plugin->getPluginType() == "4osc")
                        {
                            sawFourOsc = true;
                            isMosh = dynamic_cast<MoshFourOscPlugin*> (plugin) != nullptr;
                        }
            check (clipOk && sawFourOsc && isMosh, "the default instrument a MIDI clip brings is a MoshFourOscPlugin");
            check (ok (command (ops, "remove_track", object ({ { "trackId", dt } }))), "remove the default-instrument track");
        }

        // ── All 68 parameters, with paramIDs and the full JUCE range ──
        {
            const auto params = pluginAt (ops, ft, fo).getProperty ("params", var());
            bool shape = params.size() == 68;
            std::set<String> ids;
            int stepped = 0, symmetric = 0;
            for (int i = 0; i < params.size(); ++i)
            {
                shape = shape && (int) params[i].getProperty ("index", -1) == i && params[i].hasProperty ("id")
                        && params[i].hasProperty ("min") && params[i].hasProperty ("max") && params[i].hasProperty ("display");
                ids.insert (params[i].getProperty ("id", var()).toString());
                stepped += params[i].hasProperty ("step") ? 1 : 0;
                symmetric += params[i].hasProperty ("symmetricSkew") ? 1 : 0;
            }
            check (shape, "4OSC publishes all 68 parameters (indices 0..67), each with id, min, max and display");
            check (ids.size() == 68, "the 68 paramIDs are distinct (the names are not: \"Mix\" x3, \"Width\" x2)");
            auto idAt = [&] (int i) { return params[i].getProperty ("id", var()).toString(); };
            check (idAt (0) == "tune1" && idAt (6) == "pan1" && idAt (27) == "pan4" && idAt (28) == "lfoRate1" && idAt (40) == "ampAttack"
                       && idAt (49) == "filterFreq" && idAt (54) == "distortion" && idAt (58) == "reverbMix" && idAt (61) == "delayMix"
                       && idAt (65) == "chorusMix" && idAt (66) == "legato" && idAt (67) == "masterLevel",
                   "4OSC paramIDs by index: tune1, pan1, pan4, lfoRate1, ampAttack (40), filterFreq (49), distortion (54), the three Mix, legato, masterLevel (67)");
            check (params[58].getProperty ("name", var()).toString() == "Mix" && params[61].getProperty ("name", var()).toString() == "Mix"
                       && params[67].getProperty ("name", var()).toString() == "Level",
                   "...whose names collide (58 and 61 are both \"Mix\", 67 is \"Level\")");
            auto near = [] (const var& v, double expected, double tolerance) { return ! v.isVoid() && std::abs ((double) v - expected) < tolerance; };
            const auto attack = params[40];
            check (near (attack.getProperty ("skew", var()), 0.2, 1.0e-6) && ! attack.hasProperty ("step")
                       && near (attack.getProperty ("min", var()), 0.001, 1.0e-6) && near (attack.getProperty ("max", var()), 60.0, 1.0e-6),
                   "ampAttack: 0.001..60 s, skew 0.2, no step");
            check (near (params[2].getProperty ("skew", var()), 4.0, 1.0e-6) && near (params[67].getProperty ("skew", var()), 4.0, 1.0e-6)
                       && near (params[59].getProperty ("skew", var()), 4.0, 1.0e-6)
                       && near (params[2].getProperty ("min", var()), -100.0, 1.0e-6) && near (params[2].getProperty ("max", var()), 0.0, 1.0e-6),
                   "levels (Level 1, master Level, delay Feedback): -100..0 dB, skew 4");
            check (near (params[28].getProperty ("skew", var()), 0.3, 1.0e-6), "LFO rate: skew 0.3");
            bool tunes = stepped == 4;
            for (int osc = 0; osc < 4; ++osc)
                tunes = tunes && near (params[osc * 7].getProperty ("step", var()), 1.0, 1.0e-9) && ! params[osc * 7].hasProperty ("skew")
                        && near (params[osc * 7].getProperty ("min", var()), -36.0, 1.0e-6) && near (params[osc * 7].getProperty ("max", var()), 36.0, 1.0e-6);
            check (tunes, "Tune 1..4: -36..36 st, step 1, linear; no other parameter has a step");
            check (symmetric == 0, "no 4OSC parameter has a symmetric skew");
            check (! params[1].hasProperty ("skew") && ! params[49].hasProperty ("skew") && ! params[54].hasProperty ("skew"),
                   "linear parameters (Fine Tune 1, Filter Freq, Distortion) carry no skew");
            check (near (params[49].getProperty ("max", var()), 135.076232, 1.0e-4) && near (params[49].getProperty ("min", var()), 0.0, 1.0e-9),
                   "filterFreq: 0..135.076232 (MIDI note numbers)");
            // The first 16 only gained keys: without them each is the legacy object.
            bool firstSixteen = true;
            for (int i = 0; i < 16 && synth != nullptr; ++i)
                firstSixteen = firstSixteen
                               && juce::JSON::toString (withoutKeys (params[i], { "id", "min", "max", "skew", "symmetricSkew", "step" }), true)
                                      == juce::JSON::toString (legacyParamVar (*synth->getAutomatableParameter (i), i, std::nullopt), true);
            check (firstSixteen, "the 4OSC's first 16 parameters are the legacy objects plus id/min/max/skew/step (index, name, value, display, automated unchanged)");
            check (! pluginAt (ops, ft, fo).hasProperty ("modRoutes"), "a 4OSC with no modulation carries no modRoutes");
        }

        // ── The mapping, end to end at v = 0.5: the snapshot's own fields give the engine's value ──
        {
            auto setParam = [&] (int paramIndex, double value)
            {
                return ok (command (ops, "set_plugin_param", object ({ { "trackId", ft }, { "index", fo }, { "paramIndex", paramIndex }, { "value", value } })));
            };
            auto physOf = [] (const var& p)
            {
                const double lo = p["min"], hi = p["max"], v = p["value"];
                const double skew = p.hasProperty ("skew") ? (double) p["skew"] : 1.0;
                return lo + (hi - lo) * std::pow (v, 1.0 / skew);
            };
            auto normOf = [] (const var& p, double phys)
            {
                const double lo = p["min"], hi = p["max"];
                const double skew = p.hasProperty ("skew") ? (double) p["skew"] : 1.0;
                return std::pow ((phys - lo) / (hi - lo), skew);
            };
            const double attackBefore = paramValue (ops, ft, fo, 40), levelBefore = paramValue (ops, ft, fo, 2), tuneBefore = paramValue (ops, ft, fo, 0);
            check (setParam (40, 0.5), "ampAttack to 0.5");
            {
                const auto p = paramOf (ops, ft, fo, 40);
                const double phys = physOf (p);
                const double engine = synth != nullptr ? synth->ampAttack->getCurrentValue() : -1.0;
                check (std::abs (phys - 1.87597) < 1.0e-4 && std::abs (engine - phys) < 1.0e-4 && std::abs (normOf (p, phys) - 0.5) < 1.0e-6,
                       "ampAttack at 0.5: the snapshot's min/max/skew give " + String (phys, 5) + " s, the engine holds " + String (engine, 5)
                           + " s (1.87597), and the inverse returns 0.5; display " + p.getProperty ("display", var()).toString());
            }
            check (setParam (2, 0.5), "Level 1 to 0.5");
            {
                const auto p = paramOf (ops, ft, fo, 2);
                const double phys = physOf (p);
                const double engine = synth != nullptr ? synth->oscParams[0]->level->getCurrentValue() : 1.0;
                check (std::abs (phys + 15.910) < 1.0e-3 && std::abs (engine - phys) < 1.0e-3 && std::abs (normOf (p, phys) - 0.5) < 1.0e-6,
                       "Level 1 at 0.5: " + String (phys, 3) + " dB from the snapshot, " + String (engine, 3) + " dB in the engine (-15.910)");
            }
            check (setParam (0, 0.6), "Tune 1 to 0.6");
            {
                const auto p = paramOf (ops, ft, fo, 0);
                const double phys = physOf (p), step = p["step"], snapped = (double) p["min"] + step * std::round ((phys - (double) p["min"]) / step);
                check (std::abs (snapped - 7.0) < 1.0e-9 && p.getProperty ("display", var()).toString() == "7st",
                       "Tune 1 at 0.6: 7.2 snapped to its step is " + String (snapped, 1) + " st, as the engine shows it (" + p.getProperty ("display", var()).toString() + ")");
            }
            check (ok (command (ops, "undo")) && ok (command (ops, "undo")) && ok (command (ops, "undo"))
                       && std::abs (paramValue (ops, ft, fo, 40) - attackBefore) < 1.0e-6 && std::abs (paramValue (ops, ft, fo, 2) - levelBefore) < 1.0e-6
                       && std::abs (paramValue (ops, ft, fo, 0) - tuneBefore) < 1.0e-6,
                   "undo the three parameter edits (each one step)");
        }

        // ── Mod routes: read-only, from an imported MODMATRIX ──
        if (synth != nullptr)
        {
            auto matrix = synth->state.getChildWithName (te::IDs::MODMATRIX);
            const bool created = ! matrix.isValid();
            if (created)
            {
                matrix = juce::ValueTree (te::IDs::MODMATRIX);
                synth->state.addChild (matrix, -1, nullptr);
            }
            juce::ValueTree item (te::IDs::MODMATRIXITEM);
            item.setProperty (te::IDs::modParam, "filterFreq", nullptr);
            item.setProperty (te::IDs::modItem, "lfo1", nullptr);
            item.setProperty (te::IDs::modDepth, 0.25f, nullptr);
            matrix.addChild (item, -1, nullptr);   // FourOsc reloads its matrix on an AsyncUpdate
            pump (150);
            const auto routes = pluginAt (ops, ft, fo).getProperty ("modRoutes", var());
            check (routes.size() == 1 && (int) routes[0].getProperty ("paramIndex", -1) == 49
                       && routes[0].getProperty ("id", var()).toString() == "filterFreq"
                       && routes[0].getProperty ("source", var()).toString() == "lfo1"
                       && std::abs ((double) routes[0].getProperty ("depth", 0.0) - 0.25) < 1.0e-6,
                   "an imported LFO 1 -> Filter Freq route shows as modRoutes [{paramIndex 49, id filterFreq, source lfo1, depth 0.25}]");
            if (created)
                synth->state.removeChild (matrix, nullptr);
            else
                matrix.removeChild (item, nullptr);
            pump (150);
            check (! pluginAt (ops, ft, fo).hasProperty ("modRoutes"), "with the route gone, modRoutes is absent again");
        }

        // ── pluginToVar's cost for one 4OSC (measured and logged, not asserted) ──
        {
            constexpr int runs = 200;
            auto timeIt = [&] (const String& trackId, int index, int& params)
            {
                const double t0 = juce::Time::getMillisecondCounterHiRes();
                for (int r = 0; r < runs; ++r)
                    params = ops.pluginVarForSelfTest (trackId, index).getProperty ("params", var()).size();
                return (juce::Time::getMillisecondCounterHiRes() - t0) * 1000.0 / runs;
            };
            int fourOscParams = 0, eqParams = 0;
            const double fourOscUs = timeIt (ft, fo, fourOscParams), eqUs = timeIt (tid, at["4bandEq"], eqParams);
            check (fourOscParams == 68 && eqParams == 12,
                   "pluginToVar for one 4OSC (68 params): " + String (fourOscUs, 1) + " us per call; a 4bandEq (12 params): "
                       + String (eqUs, 1) + " us (mean of " + String (runs) + " calls; logged, not asserted)");
        }

        // ── State: every key, its default, writes, undo, refusals ──
        {
            const char* keys[] = { "waveShape1", "waveShape2", "waveShape3", "waveShape4", "voices1", "voices2", "voices3", "voices4",
                                   "filterType", "filterSlope", "distortionOn", "reverbOn", "delayOn", "chorusOn", "delayBeats",
                                   "voiceMode", "ampAnalog" };
            {
                const auto state = pluginAt (ops, ft, fo).getProperty ("state", var());
                bool inOrder = state.getDynamicObject() != nullptr && state.getDynamicObject()->getProperties().size() == (int) std::size (keys);
                for (int k = 0; inOrder && k < (int) std::size (keys); ++k)
                    inOrder = state.getDynamicObject()->getProperties().getName (k).toString() == keys[k];
                check (inOrder, "4OSC state carries the 17 keys in table order (waveShape1..4, voices1..4, filterType, filterSlope, the 4 FX switches, delayBeats, voiceMode, ampAnalog)");
            }
            auto entry = [&] (const char* key) { return stateEntry (ops, ft, fo, key); };
            auto valueOf = [&] (const char* key) { return stateValue (ops, ft, fo, key); };
            auto choicesAre = [&] (const char* key, std::initializer_list<const char*> expected)
            {
                const auto choices = entry (key).getProperty ("choices", var());
                bool same = choices.size() == (int) expected.size() && ! entry (key).hasProperty ("min");
                int i = 0;
                for (auto* c : expected)
                    same = same && choices[i++].toString() == c;
                return same;
            };
            bool waves = valueOf ("waveShape1").toString() == "sine";
            for (auto* key : { "waveShape1", "waveShape2", "waveShape3", "waveShape4" })
                waves = waves && choicesAre (key, { "off", "sine", "square", "saw", "triangle", "noise" })
                        && (String (key) == "waveShape1" || valueOf (key).toString() == "off");
            check (waves, "waveShape1..4: choices off, sine, square, saw, triangle, noise; osc 1 sine, the others off");
            bool voices = true;
            for (auto* key : { "voices1", "voices2", "voices3", "voices4" })
                voices = voices && (int) valueOf (key) == 1 && (int) entry (key).getProperty ("min", -1) == 1
                         && (int) entry (key).getProperty ("max", -1) == 8 && (int) entry (key).getProperty ("step", -1) == 1 && ! entry (key).hasProperty ("unit");
            check (voices, "voices1..4: 1, 1..8, step 1");
            check (choicesAre ("filterType", { "off", "lowpass", "highpass", "bandpass", "notch" }) && valueOf ("filterType").toString() == "off",
                   "filterType: off (Tracktion's default), choices off, lowpass, highpass, bandpass, notch");
            check ((int) valueOf ("filterSlope") == 12 && (int) entry ("filterSlope").getProperty ("min", -1) == 12
                       && (int) entry ("filterSlope").getProperty ("max", -1) == 24 && (int) entry ("filterSlope").getProperty ("step", -1) == 12
                       && entry ("filterSlope").getProperty ("unit", var()).toString() == "dB/oct",
                   "filterSlope: 12 dB/oct, 12..24, step 12");
            bool switches = true;
            for (auto* key : { "distortionOn", "reverbOn", "delayOn", "chorusOn" })
                switches = switches && choicesAre (key, { "off", "on" }) && valueOf (key).toString() == "off";
            check (switches, "distortionOn, reverbOn, delayOn, chorusOn: off (choices off, on)");
            check (std::abs ((double) valueOf ("delayBeats") - 1.0) < 1.0e-9 && std::abs ((double) entry ("delayBeats").getProperty ("min", 0.0) - 0.0625) < 1.0e-9
                       && std::abs ((double) entry ("delayBeats").getProperty ("max", 0.0) - 4.0) < 1.0e-9
                       && entry ("delayBeats").getProperty ("unit", var()).toString() == "beats" && ! entry ("delayBeats").hasProperty ("step"),
                   "delayBeats: 1 beat, 0.0625..4, unit beats, no step");
            check (choicesAre ("voiceMode", { "mono", "legato", "poly" }) && valueOf ("voiceMode").toString() == "poly",
                   "voiceMode: poly (choices mono, legato, poly)");
            check (choicesAre ("ampAnalog", { "off", "on" }) && valueOf ("ampAnalog").toString() == "on", "ampAnalog: on");

            auto setState = [&] (const char* key, var value)
            {
                return command (ops, "set_plugin_state", object ({ { "trackId", ft }, { "index", fo }, { "key", key }, { "value", value } }));
            };
            auto undoOk = [&] { return ok (command (ops, "undo")); };

            if (synth != nullptr)
            {
                auto& osc = *synth;
                // Waves: every choice lands as its enum int; undo restores sine.
                const char* waveIds[] = { "off", "sine", "square", "saw", "triangle", "noise" };
                for (int w = 0; w < 6; ++w)
                {
                    if (w == 1) continue;   // sine is the current value: a no-change call
                    const auto r = setState ("waveShape1", waveIds[w]);
                    check (ok (r) && dataOf (r).getProperty ("value", var()).toString() == waveIds[w] && valueOf ("waveShape1").toString() == waveIds[w]
                               && osc.oscParams[0]->waveShapeValue.get() == w,
                           String ("waveShape1 \"") + waveIds[w] + "\" is stored as Tracktion's wave " + String (w));
                    check (undoOk() && valueOf ("waveShape1").toString() == "sine" && osc.oscParams[0]->waveShapeValue.get() == 1,
                           String ("undo after \"") + waveIds[w] + "\" restores sine (1)");
                }
                bool otherOscs = true;
                for (int o = 1; o < 4; ++o)
                {
                    const auto key = "waveShape" + String (o + 1);
                    otherOscs = otherOscs && ok (setState (key.toRawUTF8(), "saw")) && osc.oscParams[o]->waveShapeValue.get() == 3
                                && valueOf (key.toRawUTF8()).toString() == "saw" && undoOk() && osc.oscParams[o]->waveShapeValue.get() == 0;
                }
                check (otherOscs, "waveShape2..4 \"saw\" each store 3 on their own oscillator; undo restores off");

                // Unison voices: rounded and clamped to 1..8.
                const struct { double asked; int applied; } voiceCases[] = { { 5, 5 }, { 2.6, 3 }, { 9, 8 }, { 0, 1 }, { -4, 1 } };
                for (const auto& c : voiceCases)
                {
                    const auto r = setState ("voices3", c.asked);
                    const bool edit = c.applied != 1;
                    check (ok (r) && (int) dataOf (r).getProperty ("value", -1) == c.applied && (int) valueOf ("voices3") == c.applied
                               && osc.oscParams[2]->voicesValue.get() == c.applied,
                           "voices3 " + String (c.asked) + " is applied as " + String (c.applied));
                    if (edit)
                        check (undoOk() && osc.oscParams[2]->voicesValue.get() == 1, "undo after voices3 " + String (c.asked) + " restores 1");
                }

                // Filter type: every choice is its enum int; undo restores off (0).
                const char* filterIds[] = { "off", "lowpass", "highpass", "bandpass", "notch" };
                for (int f = 1; f < 5; ++f)
                {
                    check (ok (setState ("filterType", filterIds[f])) && valueOf ("filterType").toString() == filterIds[f] && osc.filterTypeValue.get() == f,
                           String ("filterType \"") + filterIds[f] + "\" is stored as " + String (f));
                    check (undoOk() && osc.filterTypeValue.get() == 0 && valueOf ("filterType").toString() == "off",
                           String ("undo after filterType \"") + filterIds[f] + "\" restores off (0)");
                }

                // Filter slope: snapped onto 12 or 24.
                const struct { double asked; int applied; } slopeCases[] = { { 24, 24 }, { 18, 24 }, { 17, 12 }, { 100, 24 }, { 0, 12 } };
                for (const auto& c : slopeCases)
                {
                    const auto r = setState ("filterSlope", c.asked);
                    check (ok (r) && (int) dataOf (r).getProperty ("value", -1) == c.applied && osc.filterSlopeValue.get() == c.applied,
                           "filterSlope " + String (c.asked) + " is applied as " + String (c.applied) + " dB/oct");
                    if (c.applied == 24)
                        check (undoOk() && osc.filterSlopeValue.get() == 12, "undo after filterSlope " + String (c.asked) + " restores 12");
                }

                // The FX switches and analog envelopes.
                struct Flag { const char* key; juce::CachedValue<bool>* value; bool initial; };
                Flag flags[] = { { "distortionOn", &osc.distortionOnValue, false }, { "reverbOn", &osc.reverbOnValue, false },
                                 { "delayOn", &osc.delayOnValue, false }, { "chorusOn", &osc.chorusOnValue, false },
                                 { "ampAnalog", &osc.ampAnalogValue, true } };
                for (auto& f : flags)
                {
                    const char* flipped = f.initial ? "off" : "on";
                    check (ok (setState (f.key, flipped)) && valueOf (f.key).toString() == flipped && f.value->get() == ! f.initial,
                           String (f.key) + " \"" + flipped + "\" sets the engine's switch " + (f.initial ? "false" : "true"));
                    check (undoOk() && f.value->get() == f.initial, String ("undo restores ") + f.key);
                }

                // Delay length in beats: clamped to 0.0625..4.
                const struct { double asked; double applied; } beatCases[] = { { 0.5, 0.5 }, { 10.0, 4.0 }, { 0.0, 0.0625 }, { 1.5, 1.5 } };
                for (const auto& c : beatCases)
                {
                    const auto r = setState ("delayBeats", c.asked);
                    check (ok (r) && std::abs ((double) dataOf (r).getProperty ("value", -1.0) - c.applied) < 1.0e-6
                               && std::abs ((double) osc.delayValue.get() - c.applied) < 1.0e-6,
                           "delayBeats " + String (c.asked) + " is applied as " + String (c.applied) + " beats (Tracktion's \"delay\")");
                    check (undoOk() && std::abs ((double) osc.delayValue.get() - 1.0) < 1.0e-9, "undo after delayBeats " + String (c.asked) + " restores 1 beat");
                }

                // Voice mode.
                const char* modeIds[] = { "mono", "legato", "poly" };
                for (int m = 0; m < 2; ++m)
                {
                    check (ok (setState ("voiceMode", modeIds[m])) && valueOf ("voiceMode").toString() == modeIds[m] && osc.voiceModeValue.get() == m,
                           String ("voiceMode \"") + modeIds[m] + "\" is stored as " + String (m));
                    check (undoOk() && osc.voiceModeValue.get() == 2 && valueOf ("voiceMode").toString() == "poly",
                           String ("undo after voiceMode \"") + modeIds[m] + "\" restores poly (2)");
                }

                // Refusals: ids are exact lowercase strings, numbers must be numbers.
                const auto before = juce::JSON::toString (pluginAt (ops, ft, fo).getProperty ("state", var()), true);
                check (! ok (setState ("waveShape1", "Saw")) && ! ok (setState ("waveShape1", 3)) && ! ok (setState ("waveShape1", "pulse")),
                       "a wave that is not one of the ids (\"Saw\", 3, \"pulse\") is refused");
                check (! ok (setState ("filterType", "lowshelf")) && ! ok (setState ("filterType", 1)), "a filter type outside its ids is refused");
                check (! ok (setState ("voiceMode", 2)) && ! ok (setState ("distortionOn", true)) && ! ok (setState ("ampAnalog", "yes")),
                       "voiceMode 2, distortionOn true and ampAnalog \"yes\" are refused (choices are ids)");
                check (! ok (setState ("voices1", "abc")) && ! ok (setState ("filterSlope", "24")) && ! ok (setState ("delayBeats", true)),
                       "non-numeric voices / filterSlope / delayBeats are refused");
                {
                    const auto r = setState ("polyphony", 4);
                    check (! ok (r) && errorOf (r).contains ("not a state key") && errorOf (r).contains ("waveShape1") && errorOf (r).contains ("ampAnalog"),
                           "an excluded key (polyphony) is refused and the error names the 4OSC's keys");
                    check (! ok (setState ("lfoBeat1", 0)) && ! ok (setState ("mpe", 1)) && ! ok (setState ("voices", 8)),
                           "lfoBeat1, mpe and the global voices are not state keys");
                }
                check (juce::JSON::toString (pluginAt (ops, ft, fo).getProperty ("state", var()), true) == before
                           && osc.oscParams[0]->waveShapeValue.get() == 1 && osc.filterTypeValue.get() == 0,
                       "the refused calls changed nothing");

                // Out-of-range stored ints (a hand-edited or foreign session) read as what the
                // synth does with them; picking the shown value still repairs the store.
                osc.state.setProperty ("waveShape3", 9, nullptr);
                osc.state.setProperty (te::IDs::filterType, 7, nullptr);
                osc.state.setProperty (te::IDs::filterSlope, 18, nullptr);
                osc.state.setProperty ("voices2", 20, nullptr);
                osc.state.setProperty ("voices4", 0, nullptr);
                osc.state.setProperty (te::IDs::voiceMode, 5, nullptr);
                check (valueOf ("waveShape3").toString() == "off" && valueOf ("filterType").toString() == "off" && (int) valueOf ("filterSlope") == 12
                           && (int) valueOf ("voices2") == 8 && (int) valueOf ("voices4") == 1 && valueOf ("voiceMode").toString() == "mono",
                       "stored wave 9 / filter 7 / slope 18 / voices 20 and 0 / voice mode 5 read off / off / 12 / 8 and 1 / mono");
                {
                    // Filter type 7 silences the voice (zeroed coefficients), so "off" must write 0.
                    const auto r = setState ("filterType", "off");
                    check (ok (r) && osc.filterTypeValue.get() == 0, "choosing the shown \"off\" over a stored filter type 7 really writes 0");
                    check (undoOk() && osc.filterTypeValue.get() == 7, "...as one undoable edit (undo puts the 7 back)");
                    check (ok (setState ("voices4", 1)) && osc.oscParams[3]->voicesValue.get() == 1 && undoOk(),
                           "choosing the shown 1 over stored unison voices 0 writes 1 (undone)");
                }
                for (const auto& id : { juce::Identifier ("waveShape3"), te::IDs::filterType, te::IDs::filterSlope,
                                        juce::Identifier ("voices2"), juce::Identifier ("voices4"), te::IDs::voiceMode })
                    osc.state.removeProperty (id, nullptr);
                check (osc.oscParams[2]->waveShapeValue.get() == 0 && osc.filterTypeValue.get() == 0 && osc.filterSlopeValue.get() == 12
                           && osc.voiceModeValue.get() == 2 && osc.oscParams[1]->voicesValue.get() == 1,
                       "the out-of-range fixture is cleared (Tracktion's defaults again)");

                // A no-change write is not an edit (the stored value already equals it).
                check (ok (setState ("waveShape1", "sine")), "waveShape1 \"sine\" again (no change) is still ok");
                {
                    const auto entries = dataOf (command (ops, "get_command_log", object ({ { "limit", 1 } }))).getProperty ("entries", var());
                    const auto last = entries.size() > 0 ? entries[0] : var();
                    check (last.getProperty ("command", var()).toString() == "set_plugin_state" && ! (bool) last.getProperty ("undoable", true),
                           "...and logged undoable:false");
                }
            }
        }

        // ── The live rail: output peak, held keys, struck notes ──
        if (synth != nullptr)
        {
            auto noteOn = [] (int note) { return juce::MidiMessage::noteOn (1, note, (juce::uint8) 100); };
            auto noteOff = [] (int note) { return juce::MidiMessage::noteOff (1, note); };
            auto meter = [&] { return meterFor (ops.pluginMeters(), ft, fo); };

            (void) ops.pluginMeters();   // the 4OSC is now in the chain the rail last saw
            {
                LiveInstrument live (*synth, 256);
                live.play (0.25);
                check (! meter().isObject(), "a 4OSC that played nothing is not on the rail (idle)");

                live.play (0.25, { { 0, noteOn (60) } });
                const auto first = meter();
                check (first.isObject() && first.getProperty ("type", var()).toString() == "4osc"
                           && first.getProperty ("itemId", var()).toString() == pluginAt (ops, ft, fo).getProperty ("itemId", var()).toString(),
                       "after a note-on the 4OSC is on the rail, with its type and itemId");
                check (notesIn (first.getProperty ("held", var())) == std::vector<int> { 60 } && notesIn (first.getProperty ("struck", var())) == std::vector<int> { 60 },
                       "held [60] and struck [60]");
                check ((double) first.getProperty ("outDb", -100.0) > -100.0,
                       "outDb " + first.getProperty ("outDb", var()).toString() + " dBFS is the synth's output peak (> -100)");
                check (! meter().isObject(), "asked again with no new audio, the entry is gone (never stale)");

                live.play (0.1);
                const auto holding = meter();
                check (holding.isObject() && notesIn (holding.getProperty ("held", var())) == std::vector<int> { 60 }
                           && holding.getProperty ("struck", var()).size() == 0 && (double) holding.getProperty ("outDb", -100.0) > -100.0,
                       "the key still down: held [60], nothing struck again, still sounding (outDb " + holding.getProperty ("outDb", var()).toString() + ")");
                check (first.hasProperty ("seq") && (juce::int64) holding.getProperty ("seq", 0) == (juce::int64) first.getProperty ("seq", 0) + 1,
                       "seq " + holding.getProperty ("seq", var()).toString() + " follows " + first.getProperty ("seq", var()).toString() + " (a new frame is told from a held one)");

                live.play (0.05, { { 100, noteOff (60) } });
                const auto released = meter();
                check (released.isObject() && released.getProperty ("held", var()).size() == 0 && released.getProperty ("struck", var()).size() == 0
                           && (double) released.getProperty ("outDb", -100.0) > -100.0,
                       "a note-off clears held; the release tail keeps it on the rail (outDb " + released.getProperty ("outDb", var()).toString() + ")");

                live.play (3.0);   // the release dies away
                (void) ops.pluginMeters();
                live.play (0.25);
                check (! meter().isObject(), "once the release has died away the idle 4OSC drops off the rail");

                // Several keys in one block, ascending; a velocity-0 note-on is a note-off.
                live.play (0.1, { { 10, noteOn (67) }, { 10, noteOn (60) }, { 20, noteOn (64) } });
                const auto chord = meter();
                check (notesIn (chord.getProperty ("held", var())) == std::vector<int> { 60, 64, 67 }
                           && notesIn (chord.getProperty ("struck", var())) == std::vector<int> { 60, 64, 67 },
                       "a chord: held and struck [60, 64, 67], ascending");
                live.play (0.05, { { 0, juce::MidiMessage::noteOn (1, 64, (juce::uint8) 0) } });
                check (notesIn (meter().getProperty ("held", var())) == std::vector<int> { 60, 67 }, "a velocity-0 note-on releases 64: held [60, 67]");
                synth->midiPanic();
                live.play (0.05, { { 0, noteOn (72) } });
                check (notesIn (meter().getProperty ("held", var())) == std::vector<int> { 72 }, "midiPanic() drops the held keys: after it only the new key 72 is held");
                // As in the synth (JUCE's MPEInstrument, legacy mode), an all-notes-off acts on
                // its own channel only.
                live.play (0.05, { { 0, juce::MidiMessage::allNotesOff (2) } });
                check (notesIn (meter().getProperty ("held", var())) == std::vector<int> { 72 }, "an all-notes-off on channel 2 leaves channel 1's key 72 held");
                live.play (0.05, { { 0, juce::MidiMessage::allNotesOff (1) } });
                const auto allOff = meter();
                check (! allOff.isObject() || allOff.getProperty ("held", var()).size() == 0, "an all-notes-off on channel 1 releases it: held []");
                synth->midiPanic();
                live.play (3.0);
                (void) ops.pluginMeters();

                // FourOsc's own in-block filter: a message whose timestamp falls outside the
                // block it was handed in is ignored by the synth, and by the rail.
                live.play (0.1, {}, false, { { 300, noteOn (62) } });
                check (! meter().isObject(), "a note-on timestamped past its block is ignored, as FourOsc ignores it (nothing held, struck or heard)");

                // Offline renders and a bypassed synth never reach the rail.
                live.play (0.25, { { 0, noteOn (60) } }, /*rendering*/ true);
                check (! meter().isObject(), "a note played while rendering offline (export/bounce) is not on the rail");
                synth->midiPanic();
                live.play (3.0);
                (void) ops.pluginMeters();
                check (ok (command (ops, "bypass_plugin", object ({ { "trackId", ft }, { "index", fo }, { "bypassed", true } }))), "bypass the 4OSC");
                live.play (0.25, { { 0, noteOn (60) } });
                check (! meter().isObject(), "a bypassed 4OSC reports nothing, whatever it is handed");
                check (ok (command (ops, "undo")), "un-bypass the 4OSC");
                synth->midiPanic();
                live.play (3.0);
                (void) ops.pluginMeters();
                live.play (0.25);
                check (! meter().isObject(), "back on and idle: still nothing on the rail (no held key survived the bypass)");

                // A key still down when playback stops and restarts: FourOsc's initialise turns
                // every voice off and its MPEInstrument releases the note, so it is not held.
                live.play (0.1, { { 0, noteOn (65) } });
                check (notesIn (meter().getProperty ("held", var())) == std::vector<int> { 65 }, "key 65 down before playback stops");
            }
            {
                LiveInstrument restarted (*synth, 256);
                restarted.play (0.25);
                check (! meter().isObject(), "after a restart (initialise) the key the synth released is not held, and nothing sounds: off the rail");
            }
        }

        check (ok (command (ops, "remove_track", object ({ { "trackId", ft } }))), "4OSC fixture track removed");
    }

    check (ok (command (ops, "remove_track", object ({ { "trackId", tid } }))), "plugin panels fixture track removed");

    // ── The render-layer cache key covers what set_plugin_state and the pad commands change ──
    // render_layer keys a MIDI/drum clip's render on a signature of its notes and its
    // track's plugins (MoshOps.Generative.cpp, stableSourceSig). It used to hash only names,
    // bypass and parameters, so a state-only edit (filter slope or mode, delay length,
    // chorus, phaser) or any sampler pad edit served the stale render. SelfTest.cpp's MIDI
    // render section proves it end to end through render_layer (a slope edit MISSes, an
    // identical re-render HITs).
    section ("Plugin panels: render source signature covers plugin state and sampler sounds");
    {
        const auto st = dataOf (command (ops, "create_track", object ({ { "name", "Signature" } }))).getProperty ("trackId", var()).toString();
        const auto clip = dataOf (command (ops, "add_midi_clip", object ({ { "trackId", st }, { "length", 2.0 } })))
                              .getProperty ("clipId", var()).toString();
        check (st.isNotEmpty() && clip.isNotEmpty(), "a MIDI clip on its own track (the default instrument loads with it)");
        std::map<String, int> fx;
        for (auto* type : { "lowpass", "delay", "chorus", "phaser" })
        {
            const auto r = command (ops, "load_builtin", object ({ { "trackId", st }, { "type", type } }));
            fx[type] = (int) dataOf (r).getProperty ("index", -1);
            check (ok (r) && fx[type] >= 0, String ("load_builtin ") + type + " on the signature track");
        }
        auto sig = [&] (const String& clipId) { return ops.renderSourceSignatureForSelfTest (clipId); };
        auto setOn = [&] (const String& trackId, int index, const char* key, var value)
        {
            return ok (command (ops, "set_plugin_state", object ({ { "trackId", trackId }, { "index", index }, { "key", key }, { "value", value } })));
        };
        const auto s0 = sig (clip);
        check (s0.isNotEmpty() && sig (clip) == s0, "the signature is stable across reads");
        pump (200);
        check (sig (clip) == s0, "...and across a message-loop pump (nothing asynchronous writes into it)");
        check (setOn (st, fx["lowpass"], "slope", 12) && sig (clip) == s0, "a no-change set_plugin_state leaves it alone");
        check (ok (command (ops, "rename_track", object ({ { "trackId", st }, { "name", "Signature 2" } }))) && sig (clip) == s0,
               "renaming the track leaves it alone");
        check (ok (command (ops, "undo")), "undo the rename");

        struct StateEdit { const char* type; const char* key; var value; const char* what; };
        const StateEdit edits[] = {
            { "lowpass", "slope", 24, "the filter slope (12 -> 24 dB/oct)" },
            { "lowpass", "mode", "highpass", "the filter mode (both modes are named \"LPF/HPF\")" },
            { "delay", "lengthMs", 300, "the delay length" },
            { "chorus", "depthMs", 7.0, "the chorus depth" },
            { "phaser", "rate", 2.0, "the phaser rate" },
        };
        for (const auto& e : edits)
        {
            check (setOn (st, fx[e.type], e.key, e.value) && sig (clip) != s0, String ("a set_plugin_state edit of ") + e.what + " changes it");
            check (ok (command (ops, "undo")) && sig (clip) == s0,
                   String ("undoing it restores the signature exactly (") + e.what + "): the key is the state, not the history");
        }
        {
            // The default instrument is a 4OSC: its state keys reach the signature too.
            int synthIndex = -1;
            const auto plugins = pluginsOf (ops, st);
            for (int i = 0; i < plugins.size(); ++i)
                if (plugins[i].getProperty ("type", var()).toString() == "4osc")
                    synthIndex = (int) plugins[i].getProperty ("index", -1);
            check (synthIndex >= 0 && setOn (st, synthIndex, "waveShape2", "saw") && sig (clip) != s0,
                   "a 4OSC state edit (osc 2 wave off -> saw) changes it");
            check (ok (command (ops, "undo")) && sig (clip) == s0, "undoing the 4OSC wave edit restores it exactly");
        }

        // A drum track: the sampler has no parameters; its sounds are SOUND children.
        const auto dt = dataOf (command (ops, "create_track", object ({ { "name", "Signature Drums" }, { "type", "drum" } })))
                            .getProperty ("trackId", var()).toString();
        const auto drumClip = dataOf (command (ops, "add_midi_clip", object ({ { "trackId", dt }, { "length", 2.0 } })))
                                  .getProperty ("clipId", var()).toString();
        check (dt.isNotEmpty() && drumClip.isNotEmpty(), "a clip on a drum track (sampler + kit)");
        pump (200);   // the sampler loads its kit on an AsyncUpdate
        const auto d0 = sig (drumClip);
        pump (200);
        check (d0.isNotEmpty() && sig (drumClip) == d0, "the drum clip's signature is stable, also across a pump");
        check (ok (command (ops, "set_drum_pad", object ({ { "trackId", dt }, { "note", 38 }, { "gainDb", -6.0 } }))) && sig (drumClip) != d0,
               "a pad level edit (set_drum_pad gainDb) changes it");
        check (ok (command (ops, "undo")) && sig (drumClip) == d0, "undoing it restores the signature exactly");
        check (ok (command (ops, "set_drum_pad", object ({ { "trackId", dt }, { "note", 38 }, { "pan", 0.5 } }))) && sig (drumClip) != d0,
               "a pad pan edit changes it");
        check (ok (command (ops, "undo")) && sig (drumClip) == d0, "undoing the pan edit restores it");
        check (ok (command (ops, "set_drum_lane", object ({ { "trackId", dt }, { "note", 36 }, { "mute", true } }))) && sig (drumClip) != d0,
               "a drum lane mute (the pad's gain is parked) changes it");
        check (ok (command (ops, "undo")) && sig (drumClip) == d0, "undoing the lane mute restores it");

        check (ok (command (ops, "remove_track", object ({ { "trackId", dt } }))) && ok (command (ops, "remove_track", object ({ { "trackId", st } }))),
               "signature fixture tracks removed");
    }
}
}
