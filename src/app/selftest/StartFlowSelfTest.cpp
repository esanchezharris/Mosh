// The V3 Start page's recipe, engine-linked (docs/LAUNCH-PAGE-BRIEF-2026-10-30.md §6).
// Every step goes through MoshOps::execute with the JSON the UI sends, in the order the
// UI sends it, so a regression here is a regression a first-time singer would hit:
//
//   START-FLOW      template -> beat on Backing -> BPM -> tempo + loop -> loop_setup ->
//                   Clean Lead on both lanes -> Clean->Tuned as ONE undo step ->
//                   the import_clip fallback beatImport.ts undoes.
//   START-RELAUNCH  Tuned Lead survives a save and a cold load exactly once per lane.
//
// Arming is hardware-gated (TPL-001 in SelfTest.cpp): headless the arm is issued but
// never takes, so arming is asserted only under eng.hasAudio(). None of this is a
// listening test.
#include "StartFlowSelfTest.h"
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
    value->setProperty ("args", args.isVoid() ? var (new juce::DynamicObject()) : args);
    return ops.execute (var (value));
}

bool ok (const var& result)        { return (bool) result.getProperty ("ok", false); }
var dataOf (const var& result)     { return result.getProperty ("data", var()); }
String errorOf (const var& result) { return result.getProperty ("error", var()).toString(); }
String why (const var& result)     { return ok (result) ? String() : " -- " + errorOf (result); }

const String kCleanId ("mosh.clean-lead");
const String kTunedId ("mosh.tuned-lead");

// A minor, as the Start page's key picker writes it: AutoTune Key "A" is index 9 of 12,
// Scale "Minor" is index 2 of 3 (vocalSetup.ts AUTOTUNE_KEY_LABELS / AUTOTUNE_SCALE_LABELS),
// sent normalised exactly as vocalSetup.ts's norm() does.
constexpr int kKeyIndex = 9, kKeyCount = 12;
constexpr int kScaleIndex = 2, kScaleCount = 3;

var trackVar (MoshOps& ops, const String& id)
{
    const auto tracks = ops.snapshot().getProperty ("tracks", var());
    if (auto* arr = tracks.getArray())
        for (auto& t : *arr)
            if (t.getProperty ("id", var()).toString() == id)
                return t;
    return {};
}

String trackIdNamed (MoshOps& ops, const String& name)
{
    const auto tracks = ops.snapshot().getProperty ("tracks", var());
    if (auto* arr = tracks.getArray())
        for (auto& t : *arr)
            if (t.getProperty ("name", var()).toString() == name)
                return t.getProperty ("id", var()).toString();
    return {};
}

int clipCount (MoshOps& ops, const String& trackId)
{
    return trackVar (ops, trackId).getProperty ("clips", var()).size();
}

/** The rack plugins (snapshot `plugins`) on a lane tagged with `presetId`. */
int presetStages (MoshOps& ops, const String& trackId, const String& presetId)
{
    int n = 0;
    const auto plugins = trackVar (ops, trackId).getProperty ("plugins", var());
    if (auto* arr = plugins.getArray())
        for (auto& p : *arr)
            if (p.getProperty ("preset", var()).getProperty ("id", var()).toString() == presetId)
                ++n;
    return n;
}

int rackPlugins (MoshOps& ops, const String& trackId)
{
    return trackVar (ops, trackId).getProperty ("plugins", var()).size();
}

int pluginsOfType (MoshOps& ops, const String& trackId, const String& type)
{
    int n = 0;
    const auto plugins = trackVar (ops, trackId).getProperty ("plugins", var());
    if (auto* arr = plugins.getArray())
        for (auto& p : *arr)
            if (p.getProperty ("type", var()).toString() == type)
                ++n;
    return n;
}

/** vocalSetup.ts vocalPresetStageIndices: every bundled-vocal-preset stage, highest first. */
std::vector<int> vocalPresetStageIndices (MoshOps& ops, const String& trackId)
{
    std::vector<int> indices;
    const auto plugins = trackVar (ops, trackId).getProperty ("plugins", var());
    if (auto* arr = plugins.getArray())
        for (auto& p : *arr)
        {
            const auto id = p.getProperty ("preset", var()).getProperty ("id", var()).toString();
            if (id == kCleanId || id == kTunedId)
                indices.push_back ((int) p.getProperty ("index", -1));
        }
    std::sort (indices.begin(), indices.end(), std::greater<int>());
    return indices;
}

/** The live Mosh AutoTune objects on a lane (not the snapshot: the real plugin). */
std::vector<MoshAutoTunePlugin*> liveAutoTunes (te::Edit& edit, const String& trackId)
{
    std::vector<MoshAutoTunePlugin*> found;
    if (auto* track = te::findAudioTrackForID (edit, te::EditItemID::fromString (trackId)))
        for (auto* p : track->pluginList.getPlugins())
            if (auto* tuner = dynamic_cast<MoshAutoTunePlugin*> (p))
                found.push_back (tuner);
    return found;
}

/** <PLUGIN type="moshAutoTune"> children in a lane's state, whether or not Tracktion built
    a plugin for them: an unknown type is dropped with a log line and its node left behind,
    so "one node, zero plugins" is exactly the relaunch bug PR #794 fixed. */
int autoTuneNodes (te::Edit& edit, const String& trackId)
{
    int n = 0;
    if (auto* track = te::findAudioTrackForID (edit, te::EditItemID::fromString (trackId)))
        for (int i = 0; i < track->state.getNumChildren(); ++i)
        {
            auto child = track->state.getChild (i);
            if (child.hasType (te::IDs::PLUGIN)
                && child.getProperty (te::IDs::type).toString() == String (MoshAutoTunePlugin::xmlTypeName))
                ++n;
        }
    return n;
}

/** An accented 4/4 click: 8 bars at `bpm`, exactly 32 beats long, written under `dir`. */
juce::File writeClickBeat (const juce::File& dir, double bpm)
{
    constexpr double sr = 44100.0;
    const int beats = 32;
    const auto n = (int) std::llround (sr * beats * 60.0 / bpm);
    juce::AudioBuffer<float> buf (2, n);
    buf.clear();
    const int clickLen = (int) (sr * 0.012);
    for (int beat = 0; beat < beats; ++beat)
    {
        const auto s0 = (int) std::llround (beat * 60.0 / bpm * sr);
        const float gain = beat % 4 == 0 ? 0.9f : 0.5f;
        for (int i = 0; i < clickLen && s0 + i < n; ++i)
        {
            const float env = 1.0f - (float) i / (float) clickLen;
            const float v = gain * env * std::sin ((float) i * (beat % 4 == 0 ? 0.6f : 0.9f));
            buf.setSample (0, s0 + i, v);
            buf.setSample (1, s0 + i, v);
        }
    }
    dir.createDirectory();
    // No tempo in the name: insertWaveClip reads a BPM out of a file name and would warp it.
    auto file = dir.getChildFile ("start-flow-beat.wav");
    file.deleteFile();
    juce::WavAudioFormat format;
    auto stream = file.createOutputStream();
    if (stream == nullptr) return {};
    std::unique_ptr<juce::AudioFormatWriter> writer (format.createWriterFor (stream.get(), sr, 2u, 16, {}, 0));
    if (writer == nullptr) return {};
    stream.release();   // the writer owns it now
    const bool written = writer->writeFromAudioSampleBuffer (buf, 0, n);
    writer.reset();     // flush and close before anyone reads it
    return written ? file : juce::File();
}

/** findPresetFile (vocalSetup.ts): list_presets names file stems. */
String presetFileNamed (MoshOps& ops, const String& stem)
{
    const auto listed = command (ops, "list_presets", object ({ { "plugin", trackpreset::kLibraryKey } }));
    const auto presets = dataOf (listed).getProperty ("presets", var());   // hold the var: its array outlives the loop
    if (auto* arr = presets.getArray())
        for (auto& p : *arr)
            if (p.getProperty ("name", var()).toString() == stem)
                return p.getProperty ("file", var()).toString();
    return {};
}

/** switchVocalPreset (vocalSetup.ts) to Tuned Lead in A minor, command for command:
    batch_begin {name}, remove every bundled-preset stage highest index first, apply the
    tuned preset, set the AutoTune Key and Scale, batch_end. Empty on success. */
String switchToTuned (MoshOps& ops, const String& leadId, const String& takesId, const String& tunedFile)
{
    const auto begun = command (ops, "batch_begin", object ({ { "name", "Tuned Lead" } }));
    if (! ok (begun)) return "batch_begin: " + errorOf (begun);
    auto fail = [&ops] (const String& error) { command (ops, "batch_end"); return error; };

    for (const auto& laneId : { leadId, takesId })
    {
        for (const int index : vocalPresetStageIndices (ops, laneId))
            if (const auto removed = command (ops, "remove_plugin", object ({ { "trackId", laneId }, { "index", index } })); ! ok (removed))
                return fail ("remove_plugin: " + errorOf (removed));
        if (const auto applied = command (ops, "apply_track_preset", object ({ { "trackId", laneId }, { "file", tunedFile } })); ! ok (applied))
            return fail ("apply_track_preset: " + errorOf (applied));

        int tunerIndex = -1;
        const auto plugins = trackVar (ops, laneId).getProperty ("plugins", var());
        if (auto* arr = plugins.getArray())
            for (auto& p : *arr)
                if (p.getProperty ("type", var()).toString() == "moshAutoTune")
                {
                    tunerIndex = (int) p.getProperty ("index", -1);
                    break;
                }
        if (tunerIndex < 0) return fail ("the tuner did not load");
        const double keyNorm   = (double) kKeyIndex / (double) (kKeyCount - 1);
        const double scaleNorm = (double) kScaleIndex / (double) (kScaleCount - 1);
        for (const auto& [paramIndex, value] : { std::pair<int, double> { 0, keyNorm }, std::pair<int, double> { 1, scaleNorm } })
            if (const auto set = command (ops, "set_plugin_param", object ({ { "trackId", laneId }, { "index", tunerIndex },
                                                                             { "paramIndex", paramIndex }, { "value", value } }));
                ! ok (set))
                return fail ("set_plugin_param: " + errorOf (set));
    }
    const auto ended = command (ops, "batch_end");
    return ok (ended) ? String() : "batch_end: " + errorOf (ended);
}

using Lane = std::pair<String, const char*>;
} // namespace

void runStartFlowSelfTest (MoshEngine& eng, MoshOps& ops, const VocalPresetSelfTestCallbacks& cb)
{
    auto section = [&cb] (const char* name)                  { cb.section (String (juce::CharPointer_UTF8 (name))); };
    auto check = [&cb] (bool condition, const String& message) { cb.check (condition, message); };

    String backing, vocal, takes, cleanFile, tunedFile;

    // ── START-FLOW ───────────────────────────────────────────────────────────────────
    section ("START-FLOW: template, beat on Backing, tempo, loop, Clean Lead, Clean->Tuned in one undo");
    {
        // startVocalProject (menuActions.ts): exactly { template: "vocal" }.
        const auto made = command (ops, "new_project", object ({ { "template", "vocal" } }));
        check (ok (made), "new_project {template:'vocal'} ok" + why (made));
        backing = dataOf (made).getProperty ("backingTrackId", var()).toString();
        vocal   = dataOf (made).getProperty ("vocalTrackId", var()).toString();
        check (backing.isNotEmpty() && backing == trackIdNamed (ops, "Backing"),
               "the template made a Backing track and the result names it");
        check (vocal.isNotEmpty() && vocal == trackIdNamed (ops, "Vocal") && vocal != backing,
               "the template made a Vocal track and the result names it");
        if (backing.isEmpty() || vocal.isEmpty())
            return;

        // importBeat (beatImport.ts): a path import onto Backing at bar 1.
        const auto beat = writeClickBeat (eng.sessionDir().getChildFile ("start-flow"), 88.0);
        check (beat.existsAsFile(), "an 88 BPM, 8-bar click WAV was written under the session dir");
        const auto imported = command (ops, "import_clip", object ({ { "file", beat.getFullPathName() },
                                                                     { "trackId", backing }, { "startSeconds", 0 } }));
        check (ok (imported), "import_clip onto Backing ok" + why (imported));
        const auto clipId = dataOf (imported).getProperty ("clipId", var()).toString();
        check (dataOf (imported).getProperty ("trackId", var()).toString() == backing,
               "import_clip's data.trackId is the Backing track's id");
        check (clipCount (ops, backing) == 1 && clipCount (ops, vocal) == 0,
               "the beat is on Backing and NOT on Vocal (" + String (clipCount (ops, backing)) + " on Backing, "
                   + String (clipCount (ops, vocal)) + " on Vocal)");
        {
            const auto clips = trackVar (ops, backing).getProperty ("clips", var());
            const auto clip = clips[0];
            check (clip.getProperty ("id", var()).toString() == clipId
                       && std::abs ((double) clip.getProperty ("start", -1.0)) < 1.0e-6,
                   "the beat starts at 0 s");
        }

        // detectBpm (beatImport.ts): read-only, and it may hear the double.
        const auto detected = command (ops, "detect_clip_bpm", object ({ { "clipId", clipId } }));
        const double bpm = (double) dataOf (detected).getProperty ("bpm", 0.0);
        check (ok (detected) && ((bpm >= 86.0 && bpm <= 90.0) || (bpm >= 172.0 && bpm <= 180.0)),
               "detect_clip_bpm hears 88 BPM or its octave (" + String (bpm, 2) + ")" + why (detected));

        // confirmTempo (beatImport.ts): the tempo, then the loop to the clip as the snapshot has it.
        const auto tempo = command (ops, "set_tempo", object ({ { "bpm", 88 } }));
        check (ok (tempo), "set_tempo 88 ok" + why (tempo));
        const double sessionTempo = (double) ops.snapshot().getProperty ("session", var()).getProperty ("tempo", 0.0);
        check (std::abs (sessionTempo - 88.0) < 1.0e-3, "the snapshot's session tempo is 88 (" + String (sessionTempo, 3) + ")");
        double clipStart = 0.0, clipLen = 0.0;
        {
            const auto clips = trackVar (ops, backing).getProperty ("clips", var());
            clipStart = (double) clips[0].getProperty ("start", 0.0);
            clipLen   = (double) clips[0].getProperty ("length", 0.0);
        }
        check (std::abs (clipLen - 32.0 * 60.0 / 88.0) < 0.01, "the beat is 8 bars of 88 BPM long (" + String (clipLen, 3) + " s)");
        const auto looped = command (ops, "set_transport", object ({ { "loop", true }, { "loopStart", clipStart },
                                                                     { "loopEnd", clipStart + clipLen } }));
        check (ok (looped), "set_transport loop to the beat ok" + why (looped));
        {
            const auto transport = ops.snapshot().getProperty ("transport", var());
            check ((bool) transport.getProperty ("looping", false)
                       && std::abs ((double) transport.getProperty ("loopStart", -1.0) - clipStart) < 1.0e-6
                       && std::abs ((double) transport.getProperty ("loopEnd", -1.0) - (clipStart + clipLen)) < 1.0e-3,
                   "the snapshot transport loops 0 .. the beat's end (" + transport.getProperty ("loopStart", var()).toString()
                       + " .. " + transport.getProperty ("loopEnd", var()).toString() + ")");
        }

        // setupVocalLoop (vocalSetup.ts): loop_setup on Vocal.
        const auto setup = command (ops, "loop_setup", object ({ { "trackId", vocal } }));
        check (ok (setup), "loop_setup on Vocal ok" + why (setup));
        takes = dataOf (setup).getProperty ("takesTrackId", var()).toString();
        check (takes.isNotEmpty() && takes != vocal && takes != backing && trackVar (ops, takes).isObject(),
               "loop_setup made a distinct Takes lane");
        {
            const auto loop = ops.snapshot().getProperty ("loop", var());
            check ((bool) loop.getProperty ("engaged", false)
                       && loop.getProperty ("leadTrackId", var()).toString() == vocal
                       && loop.getProperty ("takesTrackId", var()).toString() == takes,
                   "the snapshot loop is engaged with Lead = Vocal and the new Takes lane");
        }
        if (eng.hasAudio())
        {
            check ((bool) dataOf (setup).getProperty ("armed", false), "loop_setup armed the Takes lane (audio device present)");
            check ((bool) trackVar (ops, takes).getProperty ("armed", false), "the snapshot shows Takes armed");
        }
        if (takes.isEmpty())
            return;

        // addDefaultChain (vocalSetup.ts): only on lanes with no plugins, Lead then Takes.
        cleanFile = presetFileNamed (ops, "mosh-clean-lead-v0");
        tunedFile = presetFileNamed (ops, "mosh-tuned-lead-v0");
        check (cleanFile.isNotEmpty(), "list_presets {plugin:'track-chain'} lists mosh-clean-lead-v0");
        check (tunedFile.isNotEmpty(), "list_presets {plugin:'track-chain'} lists mosh-tuned-lead-v0");
        if (cleanFile.isEmpty() || tunedFile.isEmpty())
            return;
        check (rackPlugins (ops, vocal) == 0 && rackPlugins (ops, takes) == 0,
               "Lead and Takes start with no rack plugins, so the default chain applies to both");
        for (const auto& lane : { vocal, takes })
        {
            const auto applied = command (ops, "apply_track_preset", object ({ { "trackId", lane }, { "file", cleanFile } }));
            check (ok (applied), "apply_track_preset Clean Lead ok" + why (applied));
        }
        const Lane lanes[] = { { vocal, "Lead" }, { takes, "Takes" } };
        for (const auto& [lane, label] : lanes)
            check (presetStages (ops, lane, kCleanId) == 2 && rackPlugins (ops, lane) == 2,
                   String (label) + " carries exactly 2 mosh.clean-lead stages and nothing else (found "
                       + String (presetStages (ops, lane, kCleanId)) + " of " + String (rackPlugins (ops, lane)) + ")");

        // The switch.
        const auto switched = switchToTuned (ops, vocal, takes, tunedFile);
        check (switched.isEmpty(), "the Clean->Tuned switch ran" + (switched.isEmpty() ? String() : " -- " + switched));
        for (const auto& [lane, label] : lanes)
        {
            check (presetStages (ops, lane, kTunedId) == 3 && presetStages (ops, lane, kCleanId) == 0 && rackPlugins (ops, lane) == 3,
                   String (label) + " carries exactly 3 mosh.tuned-lead stages and no clean stage (tuned "
                       + String (presetStages (ops, lane, kTunedId)) + ", clean " + String (presetStages (ops, lane, kCleanId))
                       + ", rack " + String (rackPlugins (ops, lane)) + ")");
            check (pluginsOfType (ops, lane, "moshAutoTune") == 1,
                   String (label) + " has exactly one Mosh AutoTune (found " + String (pluginsOfType (ops, lane, "moshAutoTune")) + ")");
            const auto tuners = liveAutoTunes (eng.edit(), lane);
            if (tuners.size() == 1)
            {
                const float key   = tuners[0]->getAutomatableParameter (0)->getCurrentValue();
                const float scale = tuners[0]->getAutomatableParameter (1)->getCurrentValue();
                check (std::abs (key - (float) kKeyIndex) < 1.0e-3 && std::abs (scale - (float) kScaleIndex) < 1.0e-3,
                       String (label) + "'s AutoTune reads back A minor: Key " + String (key, 3) + " (want 9), Scale "
                           + String (scale, 3) + " (want 2)");
            }
            else
                check (false, String (label) + " has one live MoshAutoTunePlugin to read Key/Scale from (found "
                                  + String ((int) tuners.size()) + ")");
        }

        const auto undone = command (ops, "undo");
        check (ok (undone), "undo after the switch ok" + why (undone));
        for (const auto& [lane, label] : lanes)
            check (presetStages (ops, lane, kCleanId) == 2 && presetStages (ops, lane, kTunedId) == 0
                       && pluginsOfType (ops, lane, "moshAutoTune") == 0 && rackPlugins (ops, lane) == 2,
                   "ONE undo puts " + String (label) + " back to exactly 2 clean stages and no AutoTune (clean "
                       + String (presetStages (ops, lane, kCleanId)) + ", tuned " + String (presetStages (ops, lane, kTunedId))
                       + ", AutoTune " + String (pluginsOfType (ops, lane, "moshAutoTune")) + ")");

        // The fallback beatImport.ts undoes: a trackId that does not resolve is not an error,
        // the clip lands on the first audio track, and data.trackId says which.
        String firstAudio;
        if (auto* track = te::getAudioTracks (eng.edit()).getFirst())
            firstAudio = track->itemID.toString();
        const int before = clipCount (ops, firstAudio);
        const auto stray = command (ops, "import_clip", object ({ { "file", beat.getFullPathName() },
                                                                  { "trackId", "no-such-track" }, { "startSeconds", 0 } }));
        check (ok (stray), "import_clip with an unresolvable trackId still succeeds (the fallback)" + why (stray));
        check (firstAudio.isNotEmpty() && dataOf (stray).getProperty ("trackId", var()).toString() == firstAudio
                   && clipCount (ops, firstAudio) == before + 1,
               "...it lands on the first audio track and data.trackId names that track ("
                   + dataOf (stray).getProperty ("trackId", var()).toString() + ")");
        check (ok (command (ops, "undo")) && clipCount (ops, firstAudio) == before,
               "...and one undo takes the stray clip back off, as beatImport.ts does");
    }

    // ── START-RELAUNCH ───────────────────────────────────────────────────────────────
    section ("START-RELAUNCH: Tuned Lead survives a save and a cold load, one AutoTune per lane");
    {
        if (tunedFile.isEmpty() || takes.isEmpty())
        {
            check (false, "START-FLOW left a Lead, a Takes lane and the tuned preset to save");
            return;
        }
        const auto switched = switchToTuned (ops, vocal, takes, tunedFile);
        check (switched.isEmpty(), "the switch to Tuned Lead ran again" + (switched.isEmpty() ? String() : " -- " + switched));
        check (pluginsOfType (ops, vocal, "moshAutoTune") == 1 && pluginsOfType (ops, takes, "moshAutoTune") == 1,
               "before saving, each lane has one AutoTune");
        const auto saved = command (ops, "save");
        check (ok (saved), "save ok" + why (saved));
        const auto savedFile = eng.editFile();
        {
            const auto text = savedFile.loadFileAsString();
            int nodes = 0;
            for (int at = 0; (at = text.indexOf (at, "type=\"moshAutoTune\"")) >= 0; ++at) ++nodes;
            check (nodes == 2, "the saved project holds exactly two moshAutoTune nodes (found " + String (nodes) + ")");
        }

        // How the cold engine opens it. A nested MoshEngine with NO MoshOps is the state the
        // launch ctor loads the last project in (SelfTest.cpp's "Mosh plugin types are known
        // before the first project load", PR #794). The ctor itself cannot be pointed at
        // this file: freshSession wipes the nested engine's session dir and its leaf is
        // unique per engine, so there is nowhere to seed a session.mosh first, and the ctor
        // takes no path. MoshEngine::openProject is the supported way to put a saved file
        // into a live engine, and it goes through the same bracketed loader and format gate
        // as the cold start (loadEditBracketed + migrateOrRefuse) with only the engine-level
        // plugin types registered -- which is the property under test. It opens a COPY in
        // the cold engine's own session dir: openProject save()s the Edit it adopts and must
        // not rewrite the outer engine's live project. The copy's audio does not resolve;
        // nothing here plays it.
        MoshEngine coldEng (false, true, "session-start-relaunch-cold", /*nestedEngine=*/true);
        const auto copy = coldEng.sessionDir().getChildFile ("projects").getChildFile (savedFile.getFileName());
        copy.getParentDirectory().createDirectory();
        check (savedFile.copyFileTo (copy), "the saved project copied for the cold engine");
        const auto openError = coldEng.openProject (copy);
        check (openError.isEmpty(), "a cold engine with no MoshOps opens the saved project"
                                        + (openError.isEmpty() ? String() : " -- " + openError));
        const Lane lanes[] = { { vocal, "Lead" }, { takes, "Takes" } };
        for (const auto& [lane, label] : lanes)
        {
            const auto real = (int) liveAutoTunes (coldEng.edit(), lane).size();
            const int nodes = autoTuneNodes (coldEng.edit(), lane);
            check (real == 1 && nodes == 1,
                   String (label) + " reopens with exactly ONE real Mosh AutoTune and no orphaned node ("
                       + String (real) + " plugin, " + String (nodes) + " node)");
            int tuned = 0;
            if (auto* track = te::findAudioTrackForID (coldEng.edit(), te::EditItemID::fromString (lane)))
                for (auto* p : track->pluginList.getPlugins())
                    if (p != nullptr && trackpreset::isOwnedBy (*p, kTunedId))
                        ++tuned;
            check (tuned == 3, String (label) + " reopens with all 3 tuned-lead stages (found " + String (tuned) + ")");
        }
    }
}
} // namespace mosh
