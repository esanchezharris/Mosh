// "Mosh Tuned Lead v0" — the engine-linked proof that Mosh AutoTune works as a
// track-chain preset stage. VocalPresetSelfTest.cpp proves the preset mechanism itself
// (transactions, ownership, failure, persistence) on "Mosh Clean Lead v0"; this file
// only adds what a third processor and a second bundled preset need:
//
//   TABLE   the pinned moshAutoTune row in TrackPreset.h matches the linked plugin.
//   APPLY   the bundled preset lands as AutoTune -> high-pass -> compressor, reads back
//           in the file's own units, is one undo step, and does not duplicate.
//
// The AutoTune DSP itself is covered by tests/test_retune_*.cpp and by SelfTest.cpp's
// "Mosh AutoTune: pitch correction through the plugin" section. None of this is a
// listening test.
#include "TunedLeadPresetSelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "moshops/TrackPresetEngine.h"
#include "plugins/moshfx/MoshFxPlugins.h"

namespace mosh
{
namespace
{
using juce::String;
using juce::var;
using namespace trackpreset;

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

std::vector<te::Plugin*> ownedPlugins (MoshEngine& eng, const String& trackId, const String& presetId)
{
    std::vector<te::Plugin*> owned;
    if (auto* track = te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (trackId)))
        for (auto* p : track->pluginList.getPlugins())
            if (p != nullptr && isOwnedBy (*p, presetId))
                owned.push_back (p);
    return owned;
}

/** Empty when the live owned group on the track is exactly the preset, in order. */
String liveGroupMismatch (MoshEngine& eng, const String& trackId, const TrackPreset& preset)
{
    const auto owned = ownedPlugins (eng, trackId, preset.id);
    if (owned.size() != preset.stages.size())
        return "owned plugin count is " + String ((int) owned.size());
    for (size_t i = 0; i < owned.size(); ++i)
        if (auto why = stageMismatch (*owned[i], preset.stages[i]); why.isNotEmpty())
            return "stage " + String ((int) i) + ": " + why;
    return {};
}

// Every AutoTune parameter away from its default, so a value that silently stayed at the
// default cannot pass.
const char* const kAutoTuneProbeJson = R"json({
  "kind": "mosh.track-chain", "schema": 1,
  "id": "selftest.autotune-probe", "revision": 3, "name": "AutoTune Probe",
  "provenance": { "origin": "selftest" }, "validation": { "listening": "not-run" },
  "target": { "trackType": "audio" },
  "stages": [
    { "processor": "moshAutoTune", "state": {}, "bypassed": false,
      "params": {
        "root":      { "value": 9,   "unit": "semitones above C" },
        "scale":     { "value": 2,   "unit": "scale index" },
        "retune":    { "value": 12,  "unit": "ms" },
        "amount":    { "value": 75,  "unit": "%" },
        "range":     { "value": 200, "unit": "cents" },
        "mix":       { "value": 50,  "unit": "%" },
        "output":    { "value": -3,  "unit": "dB" },
        "glide":     { "value": 25,  "unit": "%" },
        "lookahead": { "value": 6,   "unit": "ms" } } }
  ] })json";
} // namespace

void runTunedLeadPresetSelfTest (MoshEngine& eng, MoshOps& ops, const VocalPresetSelfTestCallbacks& cb)
{
    auto section = [&cb] (const char* name)                  { cb.section (String (juce::CharPointer_UTF8 (name))); };
    auto check = [&cb] (bool condition, const String& message) { cb.check (condition, message); };

    // ── TABLE ────────────────────────────────────────────────────────────────────────
    section ("TUNED-PRESET TABLE: the pinned AutoTune row matches the linked plugin");
    {
        const auto probe = parseTrackPresetText (kAutoTuneProbeJson);
        check (probe.ok, "the all-non-default AutoTune probe parses" + (probe.ok ? String() : " — " + probe.error));
        if (probe.ok)
        {
            const auto& stage = probe.preset.stages[0];
            const bool remap = eng.engine().getEngineBehaviour().arePluginsRemappedWhenTempoChanges();
            auto& um = eng.edit().getUndoManager();
            const int actionsBefore = um.getNumActionsInCurrentTransaction();
            auto plugin = eng.edit().getPluginCache().createNewPlugin (makeStageState (probe.preset, 0, remap));
            check (plugin != nullptr, "moshAutoTune instantiates from preset state");
            if (plugin != nullptr)
            {
                check (um.getNumActionsInCurrentTransaction() == actionsBefore,
                       "moshAutoTune is created without a single undoable action");
                check (dynamic_cast<MoshAutoTunePlugin*> (plugin.get()) != nullptr, "the stage is the real Mosh AutoTune plugin");
                check (plugin->getNumAutomatableParameters() == stage.processor->numParams,
                       "moshAutoTune has exactly the " + String (stage.processor->numParams) + " parameters the table pins (found "
                           + String (plugin->getNumAutomatableParameters()) + ")");
                for (int i = 0; i < juce::jmin (stage.processor->numParams, plugin->getNumAutomatableParameters()); ++i)
                {
                    const auto& spec = stage.processor->params[i];
                    auto param = plugin->getAutomatableParameter (i);
                    const auto range = param->getValueRange();
                    check (param->paramID == spec.id,
                           "moshAutoTune parameter " + String (i) + " id is '" + spec.id + "' (plugin: '" + param->paramID + "')");
                    check (range.getStart() == spec.nativeMin && range.getEnd() == spec.nativeMax,
                           String ("moshAutoTune '") + spec.id + "' range is " + String (spec.nativeMin) + ".." + String (spec.nativeMax)
                               + " (plugin: " + String (range.getStart()) + ".." + String (range.getEnd()) + ")");
                    check (plugin->state.hasProperty (juce::Identifier (spec.stateProp)),
                           String ("moshAutoTune '") + spec.id + "' is saved under '" + spec.stateProp + "'");
                }
                const auto why = stageMismatch (*plugin, stage);
                check (why.isEmpty(), "moshAutoTune created from preset state reads back every probe value"
                                          + (why.isEmpty() ? String() : " — " + why));
            }
        }
    }

    // ── APPLY ────────────────────────────────────────────────────────────────────────
    section ("TUNED-PRESET APPLY: AutoTune, high-pass, compressor as one undoable chain");
    {
        String presetFile;
        {
            const auto listed = command (ops, "list_presets", object ({ { "plugin", kLibraryKey } }));
            const auto presets = dataOf (listed).getProperty ("presets", var()); // hold the var: its array must outlive the loop
            if (auto* arr = presets.getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("name", var()).toString() == "mosh-tuned-lead-v0"
                        && p.getProperty ("source", var()).toString() == "bundled")
                        presetFile = p.getProperty ("file", var()).toString();
        }
        check (presetFile.isNotEmpty(), "the bundled track-chain library lists mosh-tuned-lead-v0");
        const auto parsed = parseTrackPresetText (juce::File (presetFile).loadFileAsString());
        check (parsed.ok, "the bundled tuned preset passes schema validation" + (parsed.ok ? String() : " — " + parsed.error));
        if (presetFile.isEmpty() || ! parsed.ok)
            return;
        const auto& preset = parsed.preset;

        const auto created = command (ops, "create_track", object ({ { "name", "Tuned Vox" } }));
        const auto vox = dataOf (created).getProperty ("trackId", var()).toString();
        check (ok (created) && vox.isNotEmpty(), "audio track for the tuned preset created");

        auto apply = [&] { return command (ops, "apply_track_preset", object ({ { "trackId", vox }, { "file", presetFile } })); };
        const auto applied = apply();
        check (ok (applied), "apply_track_preset (tuned lead) ok" + (ok (applied) ? String() : " — " + errorOf (applied)));
        check ((bool) dataOf (applied).getProperty ("changed", false), "first application reports changed:true");

        // Order, straight from the live plugin list.
        const auto owned = ownedPlugins (eng, vox, preset.id);
        check (owned.size() == 3, "the preset owns three plugins on the track (found " + String ((int) owned.size()) + ")");
        if (owned.size() == 3)
        {
            check (owned[0]->getPluginType() == "moshAutoTune", "stage 1 is Mosh AutoTune (it hears the voice first)");
            check (owned[1]->getPluginType() == "lowpass", "stage 2 is the high-pass filter");
            check (owned[2]->getPluginType() == "compressor", "stage 3 is the compressor");
        }
        const auto mismatch = liveGroupMismatch (eng, vox, preset);
        check (mismatch.isEmpty(), "every live parameter holds the preset's value" + (mismatch.isEmpty() ? String() : " — " + mismatch));

        // Readback in the file's own units: a percentage comes back as a percentage.
        {
            const auto stages = dataOf (applied).getProperty ("stages", var());
            double amount = -1.0, lookahead = -1.0;
            String amountUnit;
            if (stages.size() == 3)
            {
                const auto params = stages[0].getProperty ("params", var());
                if (auto* arr = params.getArray())
                    for (auto& p : *arr)
                    {
                        const auto id = p.getProperty ("id", var()).toString();
                        if (id == "amount")
                        {
                            amount = (double) p.getProperty ("value", -1.0);
                            amountUnit = p.getProperty ("unit", var()).toString();
                        }
                        if (id == "lookahead")
                            lookahead = (double) p.getProperty ("value", -1.0);
                    }
            }
            check (std::abs (amount - 100.0) < 1.0e-3 && amountUnit == "%", "AutoTune amount reads back as 100 %");
            check (std::abs (lookahead) < 1.0e-6, "AutoTune look-ahead reads back as 0 ms (safe to sing through)");
        }

        const auto again = apply();
        check (ok (again) && ! (bool) dataOf (again).getProperty ("changed", true),
               "re-applying the untouched preset is a no-op");
        check (ownedPlugins (eng, vox, preset.id).size() == 3, "re-applying does not duplicate the chain");

        check (ok (command (ops, "undo")), "undo ok");
        check (ownedPlugins (eng, vox, preset.id).empty(), "ONE undo removes all three stages");
        check (ok (command (ops, "redo")), "redo ok");
        const auto afterRedo = liveGroupMismatch (eng, vox, preset);
        check (afterRedo.isEmpty(), "redo restores the chain with its values" + (afterRedo.isEmpty() ? String() : " — " + afterRedo));
    }
}
} // namespace mosh
