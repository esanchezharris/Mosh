// The native plugin panels' engine seam, proven against the live engine.
//
//   SNAPSHOT   every plugin carries a stable itemId; the built-ins whose parameters are
//              plain linear ranges publish physical min/max (the compressor's threshold
//              and ratio deliberately do not); delay/chorus/phaser/low-/high-pass publish
//              their CachedValue-only settings as `state`.
//   COMMAND    set_plugin_state validates, clamps, rounds, flips the filter mode, and
//              undoes; a `gesture` id makes a whole drag ONE undo step and nothing else.
//   METERS     MoshOps::pluginMeters (the 30 Hz "plugin_meters" rail): measured gain
//              reduction that matches the compressor's static curve in steady state and
//              departs from it on a transient, staleness, bypass, an undone removal, and
//              the compressor's audio bit-identical to Tracktion's own.
//   DELAY LINE Mosh's delay and chorus (lines pre-sized off the audio thread) are what
//              "delay"/"chorus" load as, and their audio is Tracktion's bit for bit.
//
// A headless run has no audio thread, so the plugins are driven block by block the way
// the playback graph's PluginNode drives them (as the AutoTune section does).
#include "PluginPanelsSelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "plugins/moshfx/MoshFxPlugins.h"
#include "plugins/moshfx/MoshCompressorPlugin.h"
#include "plugins/moshfx/MoshDelayLinePlugins.h"
#include <cmath>
#include <cstring>
#include <functional>
#include <map>
#include <set>

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
        auto entryIs = [&] (int index, const char* key, double value, double lo, double hi, const char* unit, bool stepped)
        {
            const auto e = stateEntry (ops, tid, index, key);
            const bool unitOk = String (unit).isEmpty() ? ! e.hasProperty ("unit") : e.getProperty ("unit", var()).toString() == unit;
            const bool stepOk = stepped ? (int) e.getProperty ("step", 0) == 1 : ! e.hasProperty ("step");
            return std::abs ((double) e.getProperty ("value", -999.0) - value) < 1.0e-4
                && std::abs ((double) e.getProperty ("min", -999.0) - lo) < 1.0e-6
                && std::abs ((double) e.getProperty ("max", -999.0) - hi) < 1.0e-6
                && unitOk && stepOk;
        };
        check (entryIs (delay, "lengthMs", 150.0, 1.0, 2000.0, "ms", true), "delay state.lengthMs = 150 ms, 1..2000, step 1");
        check (entryIs (chorus, "depthMs", 3.0, 0.1, 20.0, "ms", false) && entryIs (chorus, "speedHz", 1.0, 0.1, 10.0, "Hz", false)
                   && entryIs (chorus, "width", 0.5, 0.0, 1.0, "", false) && entryIs (chorus, "mix", 0.5, 0.0, 1.0, "", false),
               "chorus state: depthMs, speedHz, width, mix with their defaults and ranges");
        check (entryIs (phaser, "depth", 5.0, 0.0, 8.0, "oct", false) && entryIs (phaser, "rate", 0.4, 0.05, 10.0, "Hz", false)
                   && entryIs (phaser, "feedback", 0.7, -0.95, 0.95, "", false),
               "phaser state: depth, rate, feedback with their defaults and ranges");
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
            {
                const auto payload = ops.pluginMeters();
                const auto m = meterFor (payload, tid, compIdx);
                check (m.isObject(), "the compressor reports a live meter after processing audio");
                check (m.getProperty ("type", var()).toString() == "compressor"
                           && m.getProperty ("itemId", var()).toString() == pluginAt (ops, tid, compIdx).getProperty ("itemId", var()).toString(),
                       "the meter names its type and the plugin's itemId");
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

    check (ok (command (ops, "remove_track", object ({ { "trackId", tid } }))), "plugin panels fixture track removed");
}
}
