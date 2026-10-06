// RFC 001 (A-PR3) — MoshOps partial-class split: the plugin-domain command
// bodies (list/load/remove/reorder/param/bypass + the master-bus plugin lane,
// built-in palette + Mosh FX, DRM-001 drum-kit loading/sample assignment +
// set_track_type, plugin scan + blocklist, Wave-7 parameter automation, and
// the native editor pop-outs), moved VERBATIM from MoshOps.cpp. Same class,
// same member functions — only the translation unit changed. The dispatch
// if-chain and all transaction/log/result/emit plumbing stay in MoshOps.cpp
// (one mutation path, by construction). Cross-TU helpers (BuiltinSpec/
// kBuiltins/findBuiltin, addExternalPluginMetadata — also used by the
// snapshot serializers that stay behind) live in MoshOpsInternal.h; the two
// helpers whose ONLY consumers moved here (SetPluginParamValueAction,
// DrumPad/kDefaultKit) moved into this TU's anonymous namespace, verbatim.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "AutomationMode.h"
#include "AutomationCurveWrite.h"
#include "PluginScanPlan.h"
#include "TrackPresetEngine.h"
#include "PluginState.h"
#include "plugins/moshfx/MoshDelayLinePlugins.h"
#include "ScanProgress.h"
#include "state/Ids.h"
#include "files/ImportCopy.h"
#include <cmath>
#include <limits>

// The delay/chorus lines are sized for set_plugin_state's ceilings (see
// MoshDelayLinePlugins.h); raising a ceiling in PluginState.h without them would put the
// reallocation back on the audio thread.
static_assert ((int) mosh::pluginstate::maxOf ("delay", "lengthMs") == mosh::MoshDelayPlugin::kMaxLengthMs,
               "MoshDelayPlugin pre-sizes for the lengthMs ceiling");
static_assert ((int) (mosh::pluginstate::maxOf ("chorus", "depthMs") * 1000.0)
                   == (int) (mosh::MoshChorusPlugin::kMaxDepthMs * 1000.0f),
               "MoshChorusPlugin pre-sizes for the depthMs ceiling");
// The low/high-pass slope grid IS the filter's: MoshLowPassPlugin's cascade has
// kMaxSections sections, enough for the steepest slope the command can set, and its
// order is slope / 6, so the grid must start at 6 and step by 6.
static_assert ((int) mosh::pluginstate::maxOf ("lowpass", "slope") == mosh::MoshLowPassPlugin::kMaxSlopeDbPerOct
                   && (int) mosh::pluginstate::maxOf ("highpass", "slope") == mosh::MoshLowPassPlugin::kMaxSlopeDbPerOct,
               "set_plugin_state's slope ceiling is the cascade's");
static_assert (mosh::moshfx::filterdesign::numSections ((int) mosh::pluginstate::maxOf ("lowpass", "slope")
                                                         / mosh::moshfx::filterdesign::kSlopeStep)
                   <= mosh::moshfx::filterdesign::kMaxSections,
               "the steepest slope fits MoshLowPassPlugin's sections");
static_assert ((int) mosh::pluginstate::minOf ("lowpass", "slope") == mosh::moshfx::filterdesign::kMinSlope
                   && mosh::pluginstate::stepOf ("lowpass", "slope") == mosh::moshfx::filterdesign::kSlopeStep
                   && (int) mosh::pluginstate::minOf ("highpass", "slope") == mosh::moshfx::filterdesign::kMinSlope
                   && mosh::pluginstate::stepOf ("highpass", "slope") == mosh::moshfx::filterdesign::kSlopeStep,
               "set_plugin_state snaps the slope onto the filter's own 6 dB/oct grid");

namespace mosh
{
using namespace juce;

namespace
{
    // Native editor mirrors listen to the same Tracktion parameters that the ordinary
    // set_plugin_param undo action replays. Suppress the listener only while that action
    // applies/undoes/redoes, otherwise Undo would be mistaken for a fresh editor gesture.
    thread_local int pluginParamReplayDepth = 0;
    struct ScopedPluginParamReplay
    {
        ScopedPluginParamReplay()  { ++pluginParamReplayDepth; }
        ~ScopedPluginParamReplay() { --pluginParamReplayDepth; }
    };

    // G10 — generalizes SetFaderValueAction (above) to ANY te::AutomatableParameter,
    // not just a VolumeAndPanPlugin's vol/pan pair. cmdSetPluginParam previously called
    // param->setParameter() directly, which is the SAME undo-broken path SetFaderValueAction
    // was built to fix: setParameter() -> setParameterValue(value, false, useUndoManager=true)
    // sets the ATOMIC currentValue member unconditionally, then separately writes the backing
    // ValueTree property through a real UndoManager (attachedValue->setValue). On undo, that
    // ValueTree-backed write correctly reverts the persisted property, but
    // AutomatableParameter::valueTreePropertyChanged deliberately does NOT resync currentValue
    // from it (the engine's own comment: "we shouldn't call attachedValue->updateParameterFromValue
    // here as this will set the base value of the parameter") — so getCurrentValue() /
    // getCurrentNormalisedValue() (what the snapshot's params[].value reads) stays STALE at the
    // pre-undo value. Replaying via setParameterWithoutUndo on both perform() and undo() (same as
    // SetFaderValueAction) keeps the atomic mirror and the persisted property in lockstep both
    // ways, with THIS action — not JUCE's built-in property-undo — owning the transaction.
    //
    // ADVERSARIAL-REVIEW FIX (use-after-free, blocking) — an earlier version of this action
    // held a raw `te::AutomatableParameter&` captured at construction, mirroring
    // SetFaderValueAction above. Unlike SetFaderValueAction's target (the track's own
    // VolumeAndPanPlugin, which nothing can ever remove), THIS action's target is any plugin
    // in track->pluginList — remove_plugin-reachable. Repro: set_plugin_param (pushes this
    // action, holding a live param reference) -> remove_plugin (plugin->deleteFromParent()
    // detaches it from the track; te::PluginCache's 1s timer purges the underlying C++
    // Plugin/AutomatableParameter once the cache is its last owner, refcount==1) -> undo
    // (Tracktion's built-in undo restores the removed ValueTree node, which carries the SAME
    // te::EditItemID; PluginList::valueTreeChildAdded -> getOrCreatePluginFor(v) instantiates
    // a NEW Plugin object at a NEW address for it) -> undo again: JUCE invokes THIS action's
    // now-stale undo(), dereferencing the freed original AutomatableParameter&. An ordinary
    // "tweak a knob, delete the plugin, undo twice" workflow.
    //
    // Fixed by never holding the reference across a perform()/undo() boundary. Instead this
    // stores STABLE identifiers — the owning plugin's te::EditItemID (via
    // AutomatableParameter::getOwnerID(), which survives remove+undo re-creation exactly
    // because the restored ValueTree node keeps its id) plus the parameter's index within
    // that plugin (the same (trackId,pluginIndex,paramIndex) addressing findParam() already
    // uses for the automation-curve commands below) — and RE-RESOLVES the live
    // AutomatableParameter* via the Edit's PluginCache on every perform()/undo() call. If the
    // plugin can't be resolved (genuinely removed, cache-purged, no undo pending), apply() is
    // a safe no-op rather than a dereference.
    struct SetPluginParamValueAction final : public juce::UndoableAction
    {
        SetPluginParamValueAction (te::AutomatableParameter& p, int paramIdx, float newValue)
            : edit (p.getEdit()), pluginItemId (p.getOwnerID()), paramIndex (paramIdx),
              valueAfter (newValue), valueBefore (p.getCurrentValue()) {}

        bool perform() override        { apply (valueAfter);  return true; }
        bool undo() override           { apply (valueBefore); return true; }
        int  getSizeInUnits() override { return (int) sizeof (*this); }

        // Looks up the live parameter fresh every call — never caches a pointer/reference
        // across calls, so a remove_plugin (+ eventual PluginCache purge) in between just
        // makes this resolve to nullptr instead of dereferencing freed memory. Mirrors
        // MoshOps::findParam's (trackId,pluginIndex,paramIndex) addressing, but keyed by the
        // plugin's stable EditItemID rather than its (reorder_plugin-mutable) list position.
        te::AutomatableParameter* resolve() const
        {
            auto plugin = edit.getPluginCache().getPluginFor (pluginItemId);
            if (plugin == nullptr) return nullptr;
            if (paramIndex < 0 || paramIndex >= plugin->getNumAutomatableParameters()) return nullptr;
            return plugin->getAutomatableParameter (paramIndex).get();
        }

        void apply (float v)
        {
            if (auto* param = resolve())
            {
                ScopedPluginParamReplay replay;
                param->setParameterWithoutUndo (param->getValueRange().clipValue (v), juce::sendNotification);
            }
            // else: plugin unresolvable right now (removed, cache-purged, no matching undo
            // pending) — safe no-op instead of a use-after-free.
        }

        te::Edit& edit;
        const te::EditItemID pluginItemId;
        const int paramIndex;
        const float valueAfter;
        const float valueBefore;
    };

    int indexOfParameter (te::Plugin& plugin, te::AutomatableParameter& parameter)
    {
        for (int i = 0; i < plugin.getNumAutomatableParameters(); ++i)
            if (plugin.getAutomatableParameter (i).get() == &parameter)
                return i;
        return -1;
    }

    // DRM-001 — the bundled default drum kit. Each pad is a synthesised one-shot
    // (resources/drumkits/mosh-kit, generated by generate_kit.py) mapped to the GM
    // percussion pitch the UI drum sequencer uses (ui/src/ui/drumGrid.ts →
    // DRUM_LANES). The pitches here MUST mirror DRUM_LANES exactly.
    struct DrumPad { const char* file; const char* name; int pitch; };
    // Row order mirrors DRUM_LANES exactly (so the indices line up 1:1, not just the
    // pitch set); the sampler still maps each pad by pitch, so order is cosmetic here.
    // The folder name of the bundled kit — also the id list_drum_kits reports.
    static constexpr const char* kDefaultKitId = "mosh-kit";

    static const DrumPad kDefaultKit[] = {
        { "kick.wav",       "Kick",       36 },
        { "snare.wav",      "Snare",      38 },
        { "clap.wav",       "Clap",       39 },
        { "hat_closed.wav", "Closed Hat", 42 },
        { "hat_open.wav",   "Open Hat",   46 },
        { "tom_low.wav",    "Low Tom",    45 },
        { "tom_mid.wav",    "Mid Tom",    47 },
        { "crash.wav",      "Crash",      49 },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — VST3 hosting + MIDI
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdListPlugins (const juce::var&)
{
    juce::Array<var> plugins;
    int nVst3 = 0, nAu = 0;
    for (auto& d : pluginHost.available())
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", PluginHost::idFor (d));
        o->setProperty ("name", d.name);
        o->setProperty ("format", d.pluginFormatName);   // "VST3" / "AudioUnit"
        o->setProperty ("manufacturer", d.manufacturerName);
        o->setProperty ("isInstrument", d.isInstrument);
        plugins.add (var (o));

        if (d.pluginFormatName == "AudioUnit") ++nAu;
        else if (d.pluginFormatName == "VST3") ++nVst3;
    }
    // Per-format counts for the manager UI (INS-005). Plain numbers, not Tracktion
    // concepts — VST3/AudioUnit are standard plugin formats.
    auto* counts = new DynamicObject();
    counts->setProperty ("vst3", nVst3);
    counts->setProperty ("au", nAu);
    counts->setProperty ("total", plugins.size());

    auto* data = new DynamicObject();
    data->setProperty ("plugins", plugins);
    data->setProperty ("counts", var (counts));
    return okResult ("list_plugins", var (data));
}

juce::var MoshOps::cmdListBuiltins (const juce::var&)
{
    // The engine's compiled-in plugin palette (instruments + effects). Static —
    // no scan needed; the UI groups these by category alongside scanned VST3/AUs.
    juce::Array<var> plugins;
    for (auto& b : kBuiltins)
    {
        auto* o = new DynamicObject();
        o->setProperty ("type", b.type);
        o->setProperty ("name", b.name);
        o->setProperty ("category", b.category);
        o->setProperty ("isInstrument", b.isInstrument);
        o->setProperty ("builtin", true);
        plugins.add (var (o));
    }
    auto* data = new DynamicObject();
    data->setProperty ("plugins", plugins);
    return okResult ("list_builtins", var (data));
}

juce::var MoshOps::cmdLoadBuiltin (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (recovery point if instantiation crashes)
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_builtin", "no track");

    const auto type = args.getProperty ("type", var()).toString();
    const auto* spec = findBuiltin (type);
    if (spec == nullptr) return errResult ("load_builtin", "unknown builtin: " + type);

    beginTxn ("load_builtin");
    // Same cache path as load_plugin — the inserted plugin IS the one we hold.
    // "highpass" isn't its own Tracktion xmlTypeName — createNewPlugin dispatches on
    // "lowpass", and the mode flip below turns the freshly-created LowPassPlugin into
    // the high-pass built-in (see builtinCreationXmlType's comment).
    auto plugin = eng.edit().getPluginCache().createNewPlugin (builtinCreationXmlType (type), {});
    if (plugin == nullptr) return errResult ("load_builtin", "create failed: " + type);
    if (type == "highpass")
    {
        if (auto* lp = dynamic_cast<te::LowPassPlugin*> (plugin.get()))
        {
            // Assigning through the CachedValue writes via the edit's UndoManager
            // (referTo'd in LowPassPlugin's ctor), so this lands inside the same
            // transaction beginTxn opened above — one undo removes the whole insert.
            lp->mode = "highpass";
            lp->frequencyValue = 180.0f;
            // The filter reads the AutomatableParameter (updateFilters() →
            // frequency->getCurrentValue()), NOT the CachedValue, and the attached
            // parameter did not follow the CachedValue write: round 3 (2026-09-02)
            // shipped every "180 Hz" highpass at Tracktion's 4000 Hz default (probed:
            // normalised 0.1814 = 4 kHz). setParameter writes the parameter AND its
            // attached CachedValue (same undo transaction).
            lp->frequency->setParameter (180.0f, juce::sendNotification);
        }
    }

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();   // append
    track->pluginList.insertPlugin (plugin, index, nullptr);
    synchronisePlaybackGraph();

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", effectiveBuiltinName (*plugin));
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", spec->isInstrument);
    logLine ("load_builtin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — instrument/FX change → re-bounce
    return okResult ("load_builtin", var (data));
}

// DRM-001 — flip a track between "audio" and "drum". The type is a plain property
// on the track's own state tree (serialised in the snapshot, saved with the edit).
// A drum track auto-loads the working sampler + bundled kit so its MIDI notes are
// audible immediately. Written WITH the undo manager inside the transaction, so a
// single undo restores the prior type AND removes the auto-loaded instrument.
juce::var MoshOps::cmdSetTrackType (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_type", "no track");

    const auto type = args.getProperty ("type", "audio").toString();
    if (type != "audio" && type != "drum")
        return errResult ("set_track_type", "type must be 'audio' or 'drum'");

    beginTxn ("set_track_type");
    track->state.setProperty (ids::trackType, type, &undoManager());
    if (type == "drum")
        ensureDefaultInstrument (*track, true);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", trackHasInstrument (*track));
    logLine ("set_track_type", args, true, {}, true);
    emitSnapshotInvalidated();
    // A drum track's sampler and kit are the instrument a MIDI layer's render bounces through.
    if (type == "drum")
        reactiveTouchTrack (track->itemID.toString());
    return okResult ("set_track_type", var (data));
}

// DRM-001 — (re)load the bundled default drum kit onto a track's sampler (creating
// the sampler if absent). The command form lets the UI offer "load a kit" and lets
// a re-load reset edited pads.
juce::var MoshOps::cmdLoadDrumKit (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_drum_kit", "no track");

    // Which kit — omit for the bundled default. Validate BEFORE opening a transaction or
    // inserting a sampler, so an unknown kit is a clean error with no partial mutation.
    const auto kitId = args.getProperty ("kit", var()).toString();
    if (kitId.isNotEmpty() && ! drumKitDir (kitId).isDirectory())
        return errResult ("load_drum_kit", "no kit: " + kitId);
    if (! drumKitAvailable (kitId))
        return errResult ("load_drum_kit", "no kit samples found (is the kit bundled?)");

    beginTxn ("load_drum_kit");
    auto* sampler = ensureSampler (*track);
    if (sampler == nullptr) return errResult ("load_drum_kit", "could not create sampler");
    const int pads = loadDrumKitInto (*sampler, kitId);
    // Record which kit is on the track so the picker can show it.
    track->state.setProperty (ids::drumKitId, kitId.isNotEmpty() ? kitId : juce::String (kDefaultKitId), &undoManager());
    if (pads == 0) return errResult ("load_drum_kit", "no kit samples found (is the kit bundled?)");
    applyDrumLaneGains (*track);  // re-loaded pads land at 0 dB — re-silence muted lanes

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("index", track->pluginList.indexOf (sampler));
    data->setProperty ("pads", pads);
    data->setProperty ("kit", kitId.isNotEmpty() ? kitId : juce::String (kDefaultKitId));
    logLine ("load_drum_kit", args, true, {}, true);
    emitSnapshotInvalidated();
    // Every pad changed: an applied drum layer re-renders, as after set_drum_pad.
    reactiveTouchTrack (track->itemID.toString());
    return okResult ("load_drum_kit", var (data));
}

// Defined further down, beside applyDrumLaneGains which is its other consumer.
static juce::ValueTree soundTreeAt (te::SamplerPlugin& sampler, int index);

// "The pad at this note" — the NARROWEST sound covering it, or -1.
//
// Narrowest, not first, because a sample assigned in melodic mode spans the whole
// keyboard (min 0, max 127) and would otherwise shadow every pad on the track: a pad
// command aimed at the snare would silently retune the 808 instead. A melodic sound is a
// pitched instrument played across the keys, not a pad, so it only ever wins when nothing
// more specific covers the note.
//
// The rule itself, over each sound's [minNote, maxNote] in sound-index order (the first of
// equally narrow sounds wins). Shared with samplerToVar's addressNote, so the note the
// snapshot says reaches a sound is the note these commands resolve to it.
static int narrowestSoundCovering (const std::vector<std::pair<int, int>>& ranges, int note)
{
    int best = -1, bestSpan = std::numeric_limits<int>::max();
    for (int i = 0; i < (int) ranges.size(); ++i)
    {
        const int lo = ranges[(size_t) i].first, hi = ranges[(size_t) i].second;
        if (lo > note || hi < note) continue;
        const int span = hi - lo;
        if (span < bestSpan) { bestSpan = span; best = i; }
    }
    return best;
}

static int padIndexForNote (te::SamplerPlugin& sampler, int note)
{
    std::vector<std::pair<int, int>> ranges;
    for (int i = 0; i < sampler.getNumSounds(); ++i)
        ranges.emplace_back (sampler.getMinKey (i), sampler.getMaxKey (i));
    return narrowestSoundCovering (ranges, note);
}

// ── Drum pads ────────────────────────────────────────────────────────────────────────
// Per-pad mixer + identity, so the pad grid can behave like an instrument rather than a
// row of file paths. Everything here addresses a pad by the NOTE that triggers it, which
// is the only handle stable across a kit reload — the sampler's own sound index is not.
juce::var MoshOps::cmdSetDrumPad (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_drum_pad", "no track");
    auto* sampler = findSampler (*track);
    if (sampler == nullptr) return errResult ("set_drum_pad", "track has no sampler");

    const int note = juce::jlimit (0, 127, (int) args.getProperty ("note", -1));
    const int idx = padIndexForNote (*sampler, note);
    if (idx < 0) return errResult ("set_drum_pad", "no pad at note " + juce::String (note));

    beginTxn ("set_drum_pad");
    auto sound = soundTreeAt (*sampler, idx);

    if (args.hasProperty ("gainDb") || args.hasProperty ("pan"))
    {
        // While a pad is SILENCED (its lane muted, or another lane soloed) its live gain is
        // the mute floor and the producer's real gain is parked (see applyDrumLaneGains).
        // Writing the live gain here would be overwritten by the next unmute, so the parked
        // copy is the one to update, and the one an edit that sends no gainDb (a pan-only
        // edit) keeps: defaulting to the LIVE gain there wrote the -48 dB floor over the
        // parked level, and unmuting then restored -48 (the pad stayed silent).
        const bool parked = sound.isValid() && sound.hasProperty (ids::moshPadGainDb);
        const float userGain = parked ? (float) (double) sound.getProperty (ids::moshPadGainDb)
                                      : sampler->getSoundGainDb (idx);
        const float gain = (float) (double) args.getProperty ("gainDb", userGain);
        const float pan  = (float) (double) args.getProperty ("pan",    sampler->getSoundPan (idx));
        if (parked)
        {
            // The engine's own gain clamp (setSoundGains), so the parked level is one the
            // pad can be restored to. An unchanged value writes nothing (no undo action).
            sound.setProperty (ids::moshPadGainDb, juce::jlimit (-48.0f, 48.0f, gain), &undoManager());
            sampler->setSoundGains (idx, sampler->getSoundGainDb (idx), pan);
        }
        else
        {
            sampler->setSoundGains (idx, gain, pan);
        }
    }
    if (args.hasProperty ("name"))
        sampler->setSoundName (idx, args.getProperty ("name", var()).toString());
    if (args.hasProperty ("chokeGroup") && sound.isValid())
    {
        const int group = juce::jlimit (0, 16, (int) args.getProperty ("chokeGroup", 0));
        if (group > 0) sound.setProperty (ids::moshChokeGroup, group, &undoManager());
        else           sound.removeProperty (ids::moshChokeGroup, &undoManager());
        // A choked pad must be note-GATED, or nothing can ever cut it off: an open-ended
        // voice ignores note-off by design.
        sampler->setSoundOpenEnded (idx, group == 0);
    }

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("note", note);
    data->setProperty ("padIndex", idx);
    logLine ("set_drum_pad", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());
    return okResult ("set_drum_pad", var (data));
}

// The inverse of assign_sample, which can only ever REPLACE a pad. Without this there is
// no way to empty a slot.
juce::var MoshOps::cmdClearDrumPad (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("clear_drum_pad", "no track");
    auto* sampler = findSampler (*track);
    if (sampler == nullptr) return errResult ("clear_drum_pad", "track has no sampler");

    const int note = juce::jlimit (0, 127, (int) args.getProperty ("note", -1));
    // Exactly ONE pad — the narrowest match. Removing every sound covering the note would
    // also delete a melodic instrument that merely spans it, which is not what "empty this
    // pad" means.
    const int idx = padIndexForNote (*sampler, note);
    if (idx < 0) return errResult ("clear_drum_pad", "no pad at note " + juce::String (note));

    beginTxn ("clear_drum_pad");
    sampler->removeSound (idx);
    const int removed = 1;

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("note", note);
    data->setProperty ("removed", removed);
    logLine ("clear_drum_pad", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());
    return okResult ("clear_drum_pad", var (data));
}

// The kit LIBRARY. One folder per kit under drumkits/; a kit is "available" when at least
// one of its pads actually resolves on disk, so a half-staged bundle shows as unavailable
// rather than erroring at load time.
juce::var MoshOps::cmdListDrumKits (const juce::var&)
{
    Array<var> kits;
    juce::StringArray seen;
    auto scanRoot = [&] (const juce::File& root, const char* source)
    {
        if (! root.isDirectory()) return;
        for (auto& d : juce::RangedDirectoryIterator (root, false, "*", juce::File::findDirectories))
        {
            const auto id = d.getFile().getFileName();
            if (seen.contains (id)) continue;   // user kit shadows a same-id bundled kit
            seen.add (id);
            int pads = 0;
            for (auto& pad : kDefaultKit)
                if (d.getFile().getChildFile (pad.file).existsAsFile()) ++pads;
            // A kit folder with none of the expected pad files is not a kit — most likely
            // a stray directory — so it is listed as unavailable rather than hidden, which
            // would leave a puzzled producer with no explanation.
            auto* o = new DynamicObject();
            o->setProperty ("id", id);
            o->setProperty ("name", id.replaceCharacter ('-', ' '));
            o->setProperty ("pads", pads);
            o->setProperty ("path", d.getFile().getFullPathName());
            o->setProperty ("available", pads > 0);
            o->setProperty ("source", source);
            kits.add (var (o));
        }
    };
    // User first so a same-id user kit wins the listing, matching drumKitDir's
    // resolution order — the picker must never show a kit load_drum_kit would
    // then resolve differently.
    scanRoot (drumKitsUserRoot(), "user");
    scanRoot (drumKitsRoot(), "bundled");
    auto* data = new DynamicObject();
    data->setProperty ("kits", kits);
    data->setProperty ("defaultKit", kDefaultKitId);
    return okResult ("list_drum_kits", var (data));   // read-only: no txn, no log, no event
}

// W2.2 (produce lane, quality-pivot 2026-09) — a read-only scan of the palette-v2
// manifest: the measured sample library (docs/palette-generation-method.md) the drum/808
// picker (ui/src/agent/loop/drumPalette.ts) draws from. Resolution mirrors drumKitsUserRoot:
// an explicit {manifest} arg wins, then MOSH_PALETTE_MANIFEST (harness override — JUCE
// ignores $HOME, so a test must never depend on the real user library), then the real
// default. The manifest's own item shape (path/role_guess/root_note/root_source/
// content_hash/kind) is a generation artifact, not a command contract — this projects only
// {path, role, rootNote?}. An item whose file no longer exists on disk is DROPPED rather
// than erroring, so a half-synced palette directory degrades to "fewer choices" for the
// picker instead of a hard failure; a missing or malformed manifest itself IS an error
// (there is nothing to degrade to).
juce::var MoshOps::cmdListPalette (const juce::var& args)
{
    using juce::File;

    File manifestFile;
    const auto argManifest = args.getProperty ("manifest", var()).toString();
    if (argManifest.isNotEmpty())
    {
        manifestFile = File (argManifest);
    }
    else
    {
        const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_PALETTE_MANIFEST", {});
        manifestFile = env.isNotEmpty()
            ? File (env)
            : File::getSpecialLocation (File::userHomeDirectory)
                  .getChildFile ("Library/Mosh/palette-v2/manifest.json");
    }

    if (! manifestFile.existsAsFile())
        return errResult ("list_palette", "manifest not found: " + manifestFile.getFullPathName());

    juce::var parsed;
    if (juce::JSON::parse (manifestFile.loadFileAsString(), parsed).failed() || ! parsed.isObject())
        return errResult ("list_palette", "manifest is not valid JSON: " + manifestFile.getFullPathName());

    Array<var> out;
    if (auto* items = parsed.getProperty ("items", var()).getArray())
    {
        for (auto& it : *items)
        {
            const auto path = it.getProperty ("path", var()).toString();
            if (path.isEmpty() || ! File (path).existsAsFile()) continue;   // dropped, not fatal
            auto* o = new DynamicObject();
            o->setProperty ("path", path);
            o->setProperty ("role", it.getProperty ("role_guess", var()).toString());
            if (it.hasProperty ("root_note"))
                o->setProperty ("rootNote", it.getProperty ("root_note", var()));
            out.add (var (o));
        }
    }

    auto* data = new DynamicObject();
    data->setProperty ("items", var (out));
    return okResult ("list_palette", var (data));   // read-only: no txn, no log, no event
}

// Bake choke groups into a clip's NOTE LENGTHS, so playback and export obey them.
//
// This exists because nothing chokes LIVE. During playback the MIDI comes from the
// engine's own MidiNode; MoshOps is not in that path and cannot inject a note-off between
// two clip notes at render time, and audition_note does not choke either. A sampler
// subclass could (it sees the block's MIDI before the voices do), and one now exists
// without changing the on-disk format (MoshSamplerPlugin shadows the same "sampler" type),
// but it only meters: live choke is NOT implemented.
//
// Baking is the honest alternative rather than a hack: the notes really do get shorter,
// which means you can SEE it in the piano roll, it survives export because the render path
// reads the same MIDI, undo puts it back, and it is provable offline. The cost — it is a
// destructive edit rather than a live setting — is why it is an explicit command with its
// own undo step, never a silent side effect of adding a note.
juce::var MoshOps::cmdApplyChoke (const juce::var& args)
{
    auto* clip = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (clip == nullptr) return errResult ("apply_choke", "no midi clip");
    auto* track = dynamic_cast<te::AudioTrack*> (clip->getTrack());
    if (track == nullptr) return errResult ("apply_choke", "clip has no track");
    auto* sampler = findSampler (*track);
    if (sampler == nullptr) return errResult ("apply_choke", "track has no sampler");

    // pitch → choke group, for every pad that has one.
    std::map<int, int> groupOfPitch;
    for (int i = 0; i < sampler->getNumSounds(); ++i)
    {
        auto sound = soundTreeAt (*sampler, i);
        const int g = sound.isValid() ? (int) sound.getProperty (ids::moshChokeGroup, 0) : 0;
        if (g > 0)
            for (int n = sampler->getMinKey (i); n <= sampler->getMaxKey (i); ++n)
                groupOfPitch[n] = g;
    }
    if (groupOfPitch.empty())
        return okResult ("apply_choke", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clip->itemID.toString());
            o->setProperty ("truncated", 0); o->setProperty ("groups", 0); return var (o); }());

    auto& seq = clip->getSequence();
    // Snapshot the pointers BEFORE mutating: setStartAndLength triggers tracktion's
    // synchronous re-sort of the live MidiList, so walking it live would skip notes that
    // moved past an already-visited index (the same hazard cmdQuantizeNotes documents).
    std::vector<te::MidiNote*> notes;
    for (int i = 0; i < seq.getNumNotes(); ++i)
        if (auto* n = seq.getNote (i)) notes.push_back (n);

    beginTxn ("apply_choke");
    int truncated = 0;
    std::set<int> groupsSeen;
    for (auto* n : notes)
    {
        auto it = groupOfPitch.find (n->getNoteNumber());
        if (it == groupOfPitch.end()) continue;
        const int group = it->second;
        groupsSeen.insert (group);

        // The next note IN THE SAME GROUP that starts after this one — a closed hat cuts
        // an open hat, but a kick never cuts a snare.
        const double start = n->getStartBeat().inBeats();
        double nextStart = std::numeric_limits<double>::max();
        for (auto* other : notes)
        {
            if (other == n) continue;
            auto o = groupOfPitch.find (other->getNoteNumber());
            if (o == groupOfPitch.end() || o->second != group) continue;
            const double os = other->getStartBeat().inBeats();
            if (os > start && os < nextStart) nextStart = os;
        }
        if (nextStart == std::numeric_limits<double>::max()) continue;

        const double length = n->getLengthBeats().inBeats();
        const double capped = nextStart - start;
        if (capped >= length || capped <= 0.0) continue;
        n->setStartAndLength (tracktion::BeatPosition::fromBeats (start),
                              tracktion::BeatDuration::fromBeats (capped), &undoManager());
        ++truncated;
    }

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("truncated", truncated);
    data->setProperty ("groups", (int) groupsSeen.size());
    logLine ("apply_choke", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());
    return okResult ("apply_choke", var (data));
}

// DRM-001 — assign a sample file to a single pad/note on a track's sampler. Maps
// the sound to exactly that note (keyNote==minNote==maxNote, unity pitch) and
// REPLACES any pad already covering the note, so it doubles as "swap this pad".
juce::var MoshOps::cmdAssignSample (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("assign_sample", "no track");

    const int note = juce::jlimit (0, 127, (int) args.getProperty ("note", 60));
    const auto mode = args.getProperty ("mode", "drum").toString();   // "drum" (default, one-shot pad) | "melodic" (pitched 808/bass)
    const auto path = args.getProperty ("file", var()).toString();
    const juce::File source (path);
    if (path.isEmpty() || ! source.existsAsFile())
        return errResult ("assign_sample", "file not found: " + path);

    const auto copied = copyIntoImports (
        source, eng.sessionDir().getChildFile ("imports"));
    if (copied.error.isNotEmpty())
        return errResult ("assign_sample", copied.error);
    const auto f = copied.file;

    const auto name  = args.getProperty ("name", f.getFileNameWithoutExtension()).toString();
    const float gain = (float) (double) args.getProperty ("gainDb", 0.0);

    // One undo step: the sampler insert and every SOUND edit below go through the Edit's
    // UndoManager inside this transaction (Tracktion's addSound, removeSound,
    // setSoundParams and setSoundOpenEnded all write with getUndoManager()); --selftest
    // ("Plugin panels: the Sampler") proves the one step on an existing sampler.
    beginTxn ("assign_sample");
    auto* sampler = ensureSampler (*track);
    if (sampler == nullptr) return errResult ("assign_sample", "could not create sampler");

    // Replace any existing pad covering this note (descending so indices stay valid).
    // getMinKey/getMaxKey index the SOUND children while removeSound uses the raw child
    // index; these coincide because a Mosh sampler's state holds ONLY addSound-created
    // SOUND children (we never add macros/modifiers as children to it).
    for (int i = sampler->getNumSounds(); --i >= 0;)
        if (sampler->getMinKey (i) <= note && sampler->getMaxKey (i) >= note)
            sampler->removeSound (i);

    const int idx = sampler->getNumSounds();
    const auto err = sampler->addSound (f.getFullPathName(), name, 0.0, 0.0 /*whole file*/, gain);
    if (err.isNotEmpty())
    {
        if (copied.copied)
            f.deleteFile();
        return errResult ("assign_sample", err);
    }
    if (mode == "melodic")
    {
        // "Regular 808 functionality": ONE one-shot played across the WHOLE keyboard,
        // repitched per MIDI note off `note` as the root (playback-rate resample — no
        // time-stretch), and NOTE-GATED (openEnded=false) so the MIDI note length cuts
        // the sample off (short note = short hit, long note = sustained 808). Monophonic
        // self-non-overlap is the caller's job (author the bass MIDI non-overlapping).
        sampler->setSoundParams (idx, note, 0, 127);
        sampler->setSoundOpenEnded (idx, false);
    }
    else
    {
        sampler->setSoundParams (idx, note, note, note);
        sampler->setSoundOpenEnded (idx, true);   // one-shot drum pad: a short note rings the whole sample
    }
    applyDrumLaneGains (*track);               // keep a muted lane silent after a pad swap
    // The sampler loads its sample file on an AsyncUpdate (valueTreeChanged). Headless
    // there is no GUI dispatch between commands, so drain it now — the sound's audio
    // data must be resident before an export/render reads it (mirrors createAudioTrack).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (5);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("index", track->pluginList.indexOf (sampler));
    data->setProperty ("note", note);
    data->setProperty ("name", name);
    data->setProperty ("mode", mode);
    data->setProperty ("file", f.getFullPathName());
    data->setProperty ("sounds", sampler->getNumSounds());
    logLine ("assign_sample", args, true, {}, true);
    emitSnapshotInvalidated();
    // The pad's sound changed: an applied drum layer re-renders, as after set_drum_pad.
    reactiveTouchTrack (track->itemID.toString());
    return okResult ("assign_sample", var (data));
}

juce::var MoshOps::cmdLoadPlugin (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_plugin", "no track");

    const auto pluginId = args.getProperty ("pluginId", var()).toString();
    juce::PluginDescription desc;
    if (! pluginHost.findDescription (pluginId, desc))
        return errResult ("load_plugin", "unknown plugin: " + pluginId);

    // An instrument on a track that HOLDS AUDIO CLIPS is silent-by-construction:
    // a front-of-chain instrument clears the track buffer, so the wave clips stop
    // sounding and the stack reads as a broken load (the owner's Serum×4-on-the-
    // audio-track bug). Empty or MIDI-only "audio" tracks stay loadable — that IS
    // how an instrument track starts (⇧⌘T creates one; there is no separate midi
    // track type). Drum/group tracks are unaffected. load_builtin is deliberately
    // NOT guarded here (the default-instrument paths drive it on purpose).
    if (desc.isInstrument
        && track->state.getProperty (ids::trackType, "audio").toString() == "audio")
    {
        bool hasWaveClips = false;
        for (auto* c : track->getClips())
            if (dynamic_cast<te::WaveAudioClip*> (c)) { hasWaveClips = true; break; }
        if (hasWaveClips)
            return errResult ("load_plugin",
                desc.name
                + " is an instrument — instruments go on instrument tracks (⇧⌘T), not audio tracks");
    }

    // A2 — persist any unsaved work BEFORE an op that can crash the process in-place
    // (hosting a third-party VST3/AU is the #1 in-process-teardown crash). The on-disk save
    // becomes the recovery point, making the crash near-lossless without the full replay.
    eng.saveIfDirty();

    // Live's hot-swap: replaceInstrument:true + an INCOMING instrument + an instrument
    // already in the chain ⇒ the new one takes the old one's slot, in THIS transaction
    // (one undo restores the previous instrument). Effects never swap — a chain of
    // effects is legal. Default (flag absent) keeps the agent/chain append semantics.
    int swapIndex = -1;
    te::Plugin* swapOut = nullptr;
    if ((bool) args.getProperty ("replaceInstrument", false) && desc.isInstrument)
    {
        auto plugins = track->pluginList.getPlugins();
        for (int i = 0; i < plugins.size(); ++i)
        {
            auto* p = plugins[i].get();
            if (p == nullptr) continue;
            bool isInst = false;
            if (auto* ext = dynamic_cast<te::ExternalPlugin*> (p)) isInst = ext->isSynth();
            else if (const auto* bspec = findBuiltin (p->getPluginType())) isInst = bspec->isInstrument;
            if (isInst) { swapIndex = i; swapOut = p; break; }
        }
    }

    beginTxn ("load_plugin");
    // MUST use the Edit's PluginCache so the inserted plugin IS the one we hold
    // (PluginManager::createNewPlugin yields a different instance → insertPlugin
    // re-creates from state, indexOf fails, and it asserts — engine's own note).
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, desc);
    if (plugin == nullptr) return errResult ("load_plugin", "create failed");

    // The swap removes AFTER the new instance exists — a create failure leaves the
    // old instrument untouched.
    juce::String replacedName;
    if (swapOut != nullptr)
    {
        replacedName = swapOut->getName();
        pluginHost.closeEditor (*swapOut);
        swapOut->deleteFromParent();
    }

    int index = (int) args.getProperty ("index", -1);
    if (swapOut != nullptr) index = swapIndex;   // the swap fills the slot the old one left
    if (index < 0) index = track->pluginList.getPlugins().size();   // append (−1 does not append)
    track->pluginList.insertPlugin (plugin, index, nullptr);
    synchronisePlaybackGraph();

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
    if (swapOut != nullptr)
    {
        data->setProperty ("replaced", true);
        data->setProperty ("replacedName", replacedName);
    }
    if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin.get()))
        addExternalPluginMetadata (*data, *ext);
    logLine ("load_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — FX change → re-bounce
    return okResult ("load_plugin", var (data));
}

juce::var MoshOps::cmdRemovePlugin (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (plugin teardown can crash in-process)
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("remove_plugin", "no plugin");
    // CAP-AUT-006 — the mute gate is not a rack plugin: it is hidden from `plugins`, so
    // no mouse can reach this, but an agent addressing raw pluginList indices could
    // delete it — and with it the track's mute CURVE, which lives on its state. The next
    // ensureTrackMuteGate would then quietly add a fresh, empty one. Refuse instead.
    // (Deliberately narrow: the metering tap and the fader have always been removable
    // this way and neither carries user data that cannot be rebuilt.)
    if (dynamic_cast<TrackMutePlugin*> (plugin) != nullptr)
        return errResult ("remove_plugin", "the track's mute gate is a fixed mixer element and cannot be removed");
    pluginHost.closeEditor (*plugin);
    beginTxn ("remove_plugin");
    plugin->deleteFromParent();
    synchronisePlaybackGraph();
    logLine ("remove_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3
    return okResult ("remove_plugin");
}

juce::var MoshOps::cmdReorderPlugin (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("reorder_plugin", "no track");
    const int from = (int) args.getProperty ("index", -1);
    const int to   = (int) args.getProperty ("toIndex", -1);
    auto plugins = track->pluginList.getPlugins();
    if (from < 0 || from >= plugins.size()) return errResult ("reorder_plugin", "bad index");

    te::Plugin::Ptr p = plugins[from];
    beginTxn ("reorder_plugin");
    p->removeFromParent();
    track->pluginList.insertPlugin (p, to, nullptr);
    synchronisePlaybackGraph();
    logLine ("reorder_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3
    return okResult ("reorder_plugin");
}

// ── Gesture coalescing ────────────────────────────────────────────────────────
// See MoshOps.h (joinGestureTxn). A join performs WITHOUT beginNewTransaction, and JUCE
// adds such a perform to whatever action set is current, so the join must be sure that
// set is still the gesture's own. The hazard is a set some OTHER command opened and
// performed into after the gesture's last call (set_track_volume mid-drag, say):
// joining would append the drag to that command's step. The serial (no other
// beginUndoTransaction) and the depth/name checks rule that out. Undo and redo are a
// lesser hazard (JUCE's undo()/redo() already end with beginNewTransaction(), so a
// perform after them starts a fresh set either way), but they still end the window
// here, through editRevision_, so the step a gesture opens after an undo is a normal
// named "set_plugin_param" step and not JUCE's unnamed one.
juce::String MoshOps::gestureArgError (const juce::var& args)
{
    if (! args.hasProperty ("gesture"))
        return {};
    const auto g = args.getProperty ("gesture", var());
    const auto text = g.toString();
    bool okChars = g.isString() && text.length() >= 1 && text.length() <= 64;
    for (int i = 0; okChars && i < text.length(); ++i)
    {
        const auto c = text[i];
        okChars = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                  || c == '_' || c == '.' || c == ':' || c == '-';
    }
    return okChars ? juce::String()
                   : juce::String ("bad gesture: must be a string of 1-64 characters from [A-Za-z0-9_.:-]");
}

bool MoshOps::joinGestureTxn (const juce::String& gesture)
{
    auto& um = undoManager();
    const bool join = gesture.isNotEmpty() && ! inBatch
                      && gesture == gestureId_
                      && gestureTxnSerial_ == undoTxnSerial_          // no other transaction opened
                      && gestureRevision_ == editRevision_            // no other mutation, undo, redo or jump
                      && gestureUndoDepth_ == um.getUndoDescriptions().size()
                      && ! um.canRedo()
                      && um.getNumActionsInCurrentTransaction() > 0   // the set exists and is current
                      && um.getCurrentTransactionName() == gestureTxnName_;
    if (! join)
    {
        // Not this gesture's window any more (or never was): close it, so a stale
        // inhibitor never outlives the gesture that took it.
        if (gesture != gestureId_ || inBatch)
            endGestureWindow();
        return false;
    }
    // Joining: the same bookkeeping beginTxn does, minus opening a transaction.
    eng.markDirty();
    ++editRevision_;
    return true;
}

void MoshOps::noteGestureTxn (const juce::String& gesture)
{
    if (gesture.isEmpty() || inBatch)
    {
        endGestureWindow();
        return;
    }
    auto& um = undoManager();
    gestureId_ = gesture;
    gestureTxnSerial_ = undoTxnSerial_;
    gestureRevision_ = editRevision_;
    gestureUndoDepth_ = um.getUndoDescriptions().size();
    gestureTxnName_ = um.getCurrentTransactionName();
    gestureLastCallMs_ = juce::Time::getMillisecondCounter();
    auto& edit = eng.edit();
    if (gestureInhibitor_ == nullptr || gestureInhibitedEdit_ != &edit)
    {
        gestureInhibitor_.reset();
        gestureInhibitor_ = std::make_unique<te::Edit::UndoTransactionInhibitor> (edit);
        gestureInhibitedEdit_ = &edit;
    }
}

void MoshOps::endGestureWindow (bool closeStep)
{
    const bool held = gestureInhibitor_ != nullptr && gestureInhibitedEdit_ == &eng.edit();
    gestureId_.clear();
    gestureInhibitor_.reset();
    gestureInhibitedEdit_ = nullptr;
    if (closeStep && held)
    {
        // An unnamed new set, as Edit::UndoTransactionTimer would start. JUCE creates the
        // set lazily, so this leaves no empty step behind if nothing follows.
        undoManager().beginNewTransaction();
        ++undoTxnSerial_;
    }
}

void MoshOps::expireGestureWindow()
{
    if (gestureInhibitor_ == nullptr)
        return;
    const bool idle = juce::Time::getMillisecondCounter() - gestureLastCallMs_ > kGestureIdleMs;
    const bool invalidated = gestureRevision_ != editRevision_ || gestureTxnSerial_ != undoTxnSerial_
                             || gestureInhibitedEdit_ != &eng.edit();
    if (idle || invalidated)
        endGestureWindow (idle);
}

juce::var MoshOps::cmdSetPluginParam (const juce::var& args)
{
    if (const auto gestureError = gestureArgError (args); gestureError.isNotEmpty())
        return errResult ("set_plugin_param", gestureError);
    const auto gesture = args.getProperty ("gesture", var()).toString();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* plugin = findPlugin (trackId, (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("set_plugin_param", "no plugin");
    const int pi = (int) args.getProperty ("paramIndex", -1);
    if (pi < 0 || pi >= plugin->getNumAutomatableParameters())
        return errResult ("set_plugin_param", "bad paramIndex");

    auto param = plugin->getAutomatableParameter (pi);
    const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) args.getProperty ("value", 0.0));
    const float raw  = param->valueRange.convertFrom0to1 (norm);
    auto* track = findTrack (trackId);   // resolved once — also gates G10 write-mode capture below

    // A drag that carries one `gesture` id joins the transaction its first call opened
    // (one undo step for the whole drag); without a gesture this is beginTxn.
    if (! joinGestureTxn (gesture))
        beginTxn ("set_plugin_param");
    // G14-class fix — see SetPluginParamValueAction's comment. param->setParameter() directly
    // left AutomatableParameter::currentValue (and thus the snapshot's params[].value) stale
    // after undo; replaying through a custom UndoableAction keeps it correct both ways.
    // The action re-resolves the parameter by (pluginItemId,paramIndex) at apply time rather
    // than holding this reference — see its comment for the remove_plugin UAF this avoids.
    undoManager().perform (new SetPluginParamValueAction (*param, pi, raw));
    // G10 — parameter automation RECORDING (v0): when the owning track is armed `write`,
    // capture a point at the current transport position in the SAME transaction, so one
    // undo reverts the value AND the point together. Deliberately gated on automationMode
    // alone, NOT transport.isPlaying() — see docs/superpowers/specs/2026-07-17-
    // g10-automation-record.md §1 for why (headless --selftest never opens an audio device,
    // so a playing-transport gate would be untestable there). touch/latch are accepted by
    // set_track_automation_mode but inert here in v0 (Phase 2).
    if (track != nullptr && track->automationMode.get() == te::AutomationMode::write)
    {
        const auto posSec = eng.edit().getTransport().getPosition().inSeconds();
        param->getCurve().addPoint (tracktion::TimePosition::fromSeconds (posSec), raw, 0.0f, &undoManager());
    }
    noteGestureTxn (gesture);
    logLine ("set_plugin_param", args, true, {}, true);
    // Scoped — param tweaks are the other rapid-fire case. A param that changes plugin
    // LATENCY leaves the session PDC readout briefly stale (self-corrects on the next
    // structural edit); the arrangement is unaffected. Group-track plugins → full.
    if (track != nullptr) emitTrackPatch (*track);
    else emitSnapshotInvalidated();
    reactiveTouchTrack (trackId);   // Phase 3 — param change → re-bounce
    return okResult ("set_plugin_param");
}

juce::var MoshOps::cmdSetPluginState (const juce::var& args)
{
    static const juce::String name ("set_plugin_state");
    if (const auto gestureError = gestureArgError (args); gestureError.isNotEmpty())
        return errResult (name, gestureError);
    const auto gesture = args.getProperty ("gesture", var()).toString();
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* plugin = findPlugin (trackId, (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult (name, "no plugin");

    const auto type = effectiveBuiltinType (*plugin);
    const auto key = args.getProperty ("key", var()).toString();
    const auto* spec = pluginstate::find (type, key);
    if (spec == nullptr)
    {
        const auto keys = pluginstate::keysFor (type);
        return errResult (name, "key '" + key + "' is not a state key of " + type
                                    + (keys.isEmpty() ? juce::String (" (it has none)")
                                                      : " (allowed: " + keys.joinIntoString (", ") + ")"));
    }
    // A key of the type that THIS plugin object cannot hold: the low/high-pass slope on a
    // plain te::LowPassPlugin (Mosh's subclass was not registered first). The snapshot
    // omits it there too (describe skips a void read).
    if (pluginstate::read (*plugin, *spec).isVoid())
        return errResult (name, "this " + type + " cannot set '" + key + "'");
    if (! args.hasProperty ("value"))
        return errResult (name, "missing value");
    var applied;
    juce::String error;
    if (! pluginstate::coerce (*spec, args.getProperty ("value", var()), applied, error))
        return errResult (name, error);

    // Same value as now: nothing to change, so this is not an edit. No transaction is
    // opened, so an open gesture window (another call's drag) is NOT ended by it; the
    // JSONL line says undoable:false; nothing is re-bounced. (An empty transaction would
    // be harmless to undo itself: JUCE's beginNewTransaction is lazy and CachedValue
    // performs nothing for an equal value.)
    const bool same = pluginstate::isNoChange (*plugin, *spec, applied);
    auto* track = findTrack (trackId);
    // A no-change call of the open drag (the UI keeps sending a value clamped at the end of
    // the range) still counts as activity: it keeps the window from going idle.
    if (same && gesture.isNotEmpty() && gesture == gestureId_ && gestureInhibitor_ != nullptr)
        gestureLastCallMs_ = juce::Time::getMillisecondCounter();
    if (! same)
    {
        if (! joinGestureTxn (gesture))
            beginTxn ("set_plugin_state");
        // Through the Edit's UndoManager: a ValueTree property action, which undo/redo
        // replays and the CachedValue follows (these keys drive no parameter).
        pluginstate::write (*plugin, *spec, applied, &undoManager());
        noteGestureTxn (gesture);
    }
    logLine (name, args, true, {}, ! same);
    if (track != nullptr) emitTrackPatch (*track);
    else emitSnapshotInvalidated();
    if (! same)
        reactiveTouchTrack (trackId);   // a state change alters the bounce like a param does

    auto* data = new DynamicObject();
    data->setProperty ("key", key);
    data->setProperty ("value", pluginstate::read (*plugin, *spec));
    return okResult (name, var (data));
}

juce::var MoshOps::cmdBypassPlugin (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("bypass_plugin", "no plugin");
    const bool bypassed = (bool) args.getProperty ("bypassed", false);
    beginTxn ("bypass_plugin");
    plugin->setEnabled (! bypassed);          // enabled == not bypassed
    logLine ("bypass_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — bypass changes the bounce
    return okResult ("bypass_plugin");
}

// ─────────────────────────────────────────────────────────────────────────────
// Master-bus plugins — hosts plugins (limiter, bus EQ, …) on the master output via
// getMasterPluginList(), mirroring the per-track commands above one level up (no
// trackId; findMasterPlugin()/masterVisibleBoundary() stand in for findPlugin() +
// the track's pluginList). See docs/02_MOSHOPS_CONTRACT.md for the full contract.

juce::var MoshOps::cmdLoadMasterPlugin (const juce::var& args)
{
    // A2 — persist any unsaved work BEFORE an op that can crash the process in-place
    // (hosting a third-party VST3/AU is the #1 in-process-teardown crash), same as
    // cmdLoadPlugin.
    eng.saveIfDirty();
    const auto pluginId = args.getProperty ("pluginId", var()).toString();
    juce::PluginDescription desc;
    if (! pluginHost.findDescription (pluginId, desc))
        return errResult ("load_master_plugin", "unknown plugin: " + pluginId);

    beginTxn ("load_master_plugin");
    // Same PluginCache path as cmdLoadPlugin — the inserted plugin IS the one we hold.
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, desc);
    if (plugin == nullptr) return errResult ("load_master_plugin", "create failed");

    auto& list = eng.edit().getMasterPluginList();
    const int boundary = masterVisibleBoundary();
    int index = (int) args.getProperty ("index", -1);
    if (index < 0 || index > boundary) index = boundary;   // append before any internal tap
    list.insertPlugin (plugin, index, nullptr);

    // PluginList::insertPlugin SILENTLY no-ops (returns without inserting, no
    // exception) once te::EditLimits::maxNumMasterPlugins is hit — the internal
    // spectral tap (see MoshEngineBehaviour::getEditLimits()'s comment) counts
    // against that same cap, so this can legitimately trip even though it never
    // could before the tap existed. Report it as a clean error instead of an "ok"
    // result describing a plugin that was never actually added (indexOf would be -1).
    if (list.indexOf (plugin.get()) < 0)
        return errResult ("load_master_plugin", "master bus is full");

    auto* data = new DynamicObject();
    data->setProperty ("index", list.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
    if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin.get()))
        addExternalPluginMetadata (*data, *ext);
    logLine ("load_master_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("load_master_plugin", var (data));
}

juce::var MoshOps::cmdLoadMasterBuiltin (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (recovery point if instantiation crashes)
    const auto type = args.getProperty ("type", var()).toString();
    const auto* spec = findBuiltin (type);
    if (spec == nullptr) return errResult ("load_master_builtin", "unknown builtin: " + type);

    beginTxn ("load_master_builtin");
    // Same cache path as cmdLoadMasterPlugin/cmdLoadBuiltin. See cmdLoadBuiltin's
    // comment — "highpass" creates as "lowpass" and is then flipped into high-pass mode.
    auto plugin = eng.edit().getPluginCache().createNewPlugin (builtinCreationXmlType (type), {});
    if (plugin == nullptr) return errResult ("load_master_builtin", "create failed: " + type);
    if (type == "highpass")
    {
        if (auto* lp = dynamic_cast<te::LowPassPlugin*> (plugin.get()))
        {
            // Same in-transaction CachedValue assignment as cmdLoadBuiltin — and the
            // same parameter write, for the same reason (the filter reads the parameter).
            lp->mode = "highpass";
            lp->frequencyValue = 180.0f;
            lp->frequency->setParameter (180.0f, juce::sendNotification);
        }
    }

    auto& list = eng.edit().getMasterPluginList();
    const int boundary = masterVisibleBoundary();
    int index = (int) args.getProperty ("index", -1);
    if (index < 0 || index > boundary) index = boundary;   // append before any internal tap
    list.insertPlugin (plugin, index, nullptr);

    // See the identical guard + comment in cmdLoadMasterPlugin — insertPlugin can
    // silently no-op once maxNumMasterPlugins is hit (the internal tap counts against
    // it too); turn that into a clean error rather than a bogus "ok".
    if (list.indexOf (plugin.get()) < 0)
        return errResult ("load_master_builtin", "master bus is full");

    auto* data = new DynamicObject();
    data->setProperty ("index", list.indexOf (plugin.get()));
    data->setProperty ("name", effectiveBuiltinName (*plugin));
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", spec->isInstrument);
    logLine ("load_master_builtin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("load_master_builtin", var (data));
}

juce::var MoshOps::cmdRemoveMasterPlugin (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (plugin teardown can crash in-process)
    auto* plugin = findMasterPlugin ((int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("remove_master_plugin", "no plugin");
    pluginHost.closeEditor (*plugin);
    beginTxn ("remove_master_plugin");
    plugin->deleteFromParent();
    logLine ("remove_master_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_master_plugin");
}

juce::var MoshOps::cmdReorderMasterPlugin (const juce::var& args)
{
    const int from = (int) args.getProperty ("index", -1);
    const int to   = (int) args.getProperty ("toIndex", -1);
    auto& list = eng.edit().getMasterPluginList();
    auto plugins = list.getPlugins();
    if (from < 0 || from >= masterVisibleBoundary()) return errResult ("reorder_master_plugin", "bad index");

    te::Plugin::Ptr p = plugins[from];
    beginTxn ("reorder_master_plugin");
    p->removeFromParent();
    // Recomputed post-removal (one fewer visible plugin) — clamp INSIDE the visible
    // prefix so an out-of-range toIndex lands before any internal tap, never after it
    // (unlike cmdReorderPlugin, we can't rely on insertPlugin's raw out-of-range clamp:
    // that would append past the tap and break its "sees the final output" invariant).
    // Negative clamps to the FRONT (0), too-large clamps to the END (boundary) — e.g. a
    // "move earlier" UI action on the first plugin sends toIndex -1 and should land it
    // back at 0, not wrap it to the end.
    const int boundary = masterVisibleBoundary();
    const int dest = to < 0 ? 0 : (to > boundary ? boundary : to);
    list.insertPlugin (p, dest, nullptr);
    logLine ("reorder_master_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("reorder_master_plugin");
}

juce::var MoshOps::cmdSetMasterPluginParam (const juce::var& args)
{
    auto* plugin = findMasterPlugin ((int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("set_master_plugin_param", "no plugin");
    const int pi = (int) args.getProperty ("paramIndex", -1);
    if (pi < 0 || pi >= plugin->getNumAutomatableParameters())
        return errResult ("set_master_plugin_param", "bad paramIndex");

    auto param = plugin->getAutomatableParameter (pi);
    const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) args.getProperty ("value", 0.0));
    const float raw  = param->valueRange.convertFrom0to1 (norm);

    beginTxn ("set_master_plugin_param");
    // Same undo-correct replay action cmdSetPluginParam uses — resolve() keys off the
    // plugin's stable EditItemID via the Edit's PluginCache, not a track, so it works
    // unchanged for a master-bus plugin (see the action's comment above for why).
    undoManager().perform (new SetPluginParamValueAction (*param, pi, raw));
    logLine ("set_master_plugin_param", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_plugin_param");
}

juce::var MoshOps::cmdBypassMasterPlugin (const juce::var& args)
{
    auto* plugin = findMasterPlugin ((int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("bypass_master_plugin", "no plugin");
    const bool bypassed = (bool) args.getProperty ("bypassed", false);
    beginTxn ("bypass_master_plugin");
    plugin->setEnabled (! bypassed);          // enabled == not bypassed
    logLine ("bypass_master_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bypass_master_plugin");
}

juce::var MoshOps::cmdOpenMasterPluginEditor (const juce::var& args)
{
    auto* plugin = findMasterPlugin ((int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("open_master_plugin_editor", "no plugin");
    const bool contextActiveBefore = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    if (eng.hasAudio())
        eng.ensurePlaybackContext();
    const bool contextActiveAfter = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    pluginHost.openEditor (*plugin,
        [this] (te::AutomatableParameter& parameter, float before, float after)
        {
            return mirrorMasterEditorParameter (parameter, before, after);
        }); // opening is not undoable; parameter changes traverse set_master_plugin_param
    logLine ("open_master_plugin_editor", args, true, {}, false);
    auto* data = new DynamicObject();
    data->setProperty ("audioEnabled", eng.hasAudio());
    data->setProperty ("playbackContextActiveBefore", contextActiveBefore);
    data->setProperty ("playbackContextActive", contextActiveAfter);
    data->setProperty ("plugin", plugin->getName());
    return okResult ("open_master_plugin_editor", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// INS-005 — plugin scan & management. These mutate the plugin CATALOG, not the
// Edit, so they are NON-undoable (no Tracktion transaction); get_plugin_blocklist
// is read-only (no log). The catalog is a query (list_plugins) outside snapshot()
// — scan progress rides on transient 'plugin_scan_progress' events, never the
// snapshot (swappable-seam discipline).
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdRescanPlugins (const juce::var& args)
{
    // SCAN GUARD (tier wall): plugin scanning must NEVER reach the generative service.
    // This handler drives ONLY pluginHost.rescan (VST3/AU cataloging via the JUCE
    // PluginManager) — it never calls jobManager.ensureServiceRunning, so a rescan can
    // never spawn or warm the SA3 service (the service is lazy: only cmdRenderLayer /
    // cmdListColors start it). If a deep-scan CLI entry is ever added, it must early-
    // return before MoshOps is constructed and force MOSH_ENABLE_SA3=0 for that process.
    const auto format = args.getProperty ("format", "all").toString();   // "vst3" | "au" | "all"
    const bool clearFirst = (bool) args.getProperty ("clearFirst", false);
    const bool includeVST3 = (format == "vst3" || format == "all");
    // AU is the slow/risky path: only when requested AND opted in (so --selftest,
    // which never sets MOSH_SCAN_AU, performs no AU sweep). VST3-only rescans are
    // always allowed.
    //
    // AUD-SCAN — `allowAU` is the per-call opt-in the UI passes when the user ticks
    // "Include Audio Units". Before it existed, MOSH_SCAN_AU was the ONLY way in and it
    // is set in exactly one place in the tree (Main.cpp, for --scan-plugins-deep), so a
    // user running the shipped app could never catalog an AudioUnit: no button, setting,
    // or command reached this branch. On a Mac — where a large share of instruments are
    // AU-only — that reads as "Mosh can't see my plugins".
    // Hermeticity is preserved by construction: --selftest passes format:"vst3"
    // explicitly and never passes allowAU, so it still performs no AU sweep.
    // Cold-start (PluginHost::initialise) stays env-only on purpose — first launch must
    // remain fast and safe; the user opts in afterwards from the plugin browser.
    const bool auOptedIn = (bool) args.getProperty ("allowAU", false)
                        || SystemStats::getEnvironmentVariable ("MOSH_SCAN_AU", {}) == "1";
    const bool includeAU = (format == "au" || format == "all") && auOptedIn;

    // Never answer an explicit AU request with a silent success. The old code fell into
    // the VST3-only branch below and returned status:"done" with a count, so a caller
    // that asked for AU was told it had scanned — the failure mode that hid this gap.
    if (format == "au" && ! includeAU)
        return errResult ("rescan_plugins",
                          "Audio Unit scanning is off — pass allowAU:true (or set MOSH_SCAN_AU=1)");

    // wait:true keeps the legacy cheap VST3 pre-pass for an AU sweep. deepVst3:true
    // instead keeps module loading in the isolated worker, even when AU stays off.
    // AU cataloging ALWAYS runs on a background thread because
    // JUCE's AudioPluginFormat::createInstanceFromDescription marshals component
    // instantiation back to the message thread — a hanging AU stalls the UI with no
    // per-component timeout.  Only CRASHes are recovered via the dead-mans-pedal;
    // a HANG requires a forced app restart.  Never call the AU sweep synchronously
    // on the message thread.
    const bool wait = (bool) args.getProperty ("wait", false);
    const bool deepVST3 = (bool) args.getProperty ("deepVst3", false);
    const auto scanPlan = planPluginScan (clearFirst, includeVST3, includeAU, wait, deepVST3);
    if (scanPlan.runSynchronously)
    {
        // VST3-only (or no formats): fast + safe, run synchronously.
        const int total = pluginHost.rescan (clearFirst, includeVST3, false);
        logLine ("rescan_plugins", args, true, {}, false);   // non-undoable catalog op
        emitSnapshotInvalidated();
        auto* d = new DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("count", total);
        return okResult ("rescan_plugins", var (d));
    }
    if (scanPlan.preScanVST3)
    {
        // wait:true with AU requested: do the VST3 part inline, THEN kick off the
        // AU sweep on a background thread and return "scanning" to the caller.
        // (Keeping the message-thread VST3 result gives the caller a useful count
        // while the AU sweep is in progress.)
        pluginHost.rescan (clearFirst, true, false);
    }

    // Async deep VST3 and/or AU rescan — mirror cmdRenderLayer: do the slow work on
    // a background std::thread, marshal the result back to the message thread.
    //
    // FIT-003 — arm the live progress sampler BEFORE spawning the scan thread (message
    // thread only; see timerCallback()) so the UI gets periodic running-count events
    // for the whole sweep, not just this start/done pair.
    scanSampling_  = true;
    scanFormat_    = format;
    scanStartMs_   = Time::getMillisecondCounterHiRes();
    lastScanCount_ = -1;
    emit ("plugin_scan_progress", makeScanProgressPayload (format, /*count=*/0, /*done=*/false, 0));
    // The pure plan keeps an optional legacy VST3 pre-pass and the async format flags
    // mutually consistent. In particular, Pro Tools' deep VST3 request reaches this
    // worker with asyncIncludeAU=false.
    std::thread ([this, scanPlan, format]
    {
        // slowVST3=true: this is the deep, module-loading sweep on a BACKGROUND thread
        // (never the message thread) — engage Tracktion's out-of-process scanner + the
        // hang watchdog so a plugin that hangs the child (e.g. a WaveShell on the user's
        // conflicting Waves install) gets killed → blocklisted → skipped, and the catalog
        // is checkpointed mid-sweep so a kill keeps the progress so far.
        const auto blocklistBefore = pluginHost.blocklist();
        const int total = pluginHost.rescan (scanPlan.asyncClearFirst,
                                             scanPlan.asyncIncludeVST3,
                                             scanPlan.asyncIncludeAU,
                                             scanPlan.asyncSlowVST3);
        const auto quarantined = newlyQuarantinedPluginNames (blocklistBefore,
                                                               pluginHost.blocklist());
        juce::MessageManager::callAsync ([this, total, format, quarantined]
        {
            const int elapsed = (int) (Time::getMillisecondCounterHiRes() - scanStartMs_);
            scanSampling_ = false;   // stop the timerCallback() sampler before the terminal emit
            emit ("plugin_scan_progress", makeScanProgressPayload (
                format, total, /*done=*/true, elapsed, quarantined));
            emitSnapshotInvalidated();
        });
    }).detach();

    logLine ("rescan_plugins", args, true, {}, false);
    auto* d = new DynamicObject();
    d->setProperty ("status", "scanning");
    return okResult ("rescan_plugins", var (d));
}

juce::var MoshOps::cmdGetPluginBlocklist (const juce::var&)
{
    // READ-ONLY (no log/transaction) — modelled on cmdListAudioDevices.
    // The blacklist stores fileOrIdentifier strings (file paths for VST3,
    // "AudioUnit:..." for AU).  For each entry we try to present the UI-facing
    // idFor() form if the entry is still resolvable via the catalog; otherwise we
    // fall back to the raw fileOrIdentifier so the caller can see what was blocked.
    juce::Array<var> entries;
    auto rawIds = pluginHost.blocklist();
    // Use the unfiltered type list for the reverse-mapping: available() now filters
    // blocked entries, so blocked plugins would be invisible to the lookup.
    const auto allTypes = eng.engine().getPluginManager().knownPluginList.getTypes();

    for (auto& rawId : rawIds)
    {
        // Try to find a matching description in the full type catalog (including
        // blocked entries) to map rawId -> UI-facing idFor() form.
        String uiId = rawId;   // default: show the raw key
        for (auto& d : allTypes)
        {
            if (d.fileOrIdentifier == rawId)
            {
                uiId = PluginHost::idFor (d);
                break;
            }
        }
        auto* o = new DynamicObject();
        o->setProperty ("id",    uiId);
        o->setProperty ("rawId", rawId);   // the actual blacklist key, for debugging
        // FIT-003 — PluginHost now records WHY each entry was blocked: "crash_or_hang"
        // for a dead-mans-pedal auto-quarantine (the scan crashed or hung loading it),
        // "manual" for an explicit block_plugin call. Entries blocked before this
        // tracking existed (or a fresh manual block missing the tag) default to
        // "manual" — the safe assumption absent contrary evidence.
        const auto reason = pluginHost.blockReasonFor (rawId);
        o->setProperty ("reason", reason.isNotEmpty() ? reason : juce::String ("manual"));
        entries.add (var (o));
    }
    auto* data = new DynamicObject();
    data->setProperty ("blocklist", entries);
    return okResult ("get_plugin_blocklist", var (data));
}

juce::var MoshOps::cmdClearPluginBlocklist (const juce::var& args)
{
    pluginHost.clearBlocklist();
    logLine ("clear_plugin_blocklist", args, true, {}, false);   // catalog op, not undoable
    emitSnapshotInvalidated();
    return okResult ("clear_plugin_blocklist");
}

juce::var MoshOps::cmdUnblockPlugin (const juce::var& args)
{
    const auto id = args.getProperty ("pluginId", var()).toString();
    if (id.isEmpty())
        return errResult ("unblock_plugin", "missing pluginId");
    if (! pluginHost.unblockPlugin (id))
        return errResult ("unblock_plugin", "plugin is not quarantined");

    logLine ("unblock_plugin", args, true, {}, false);   // catalog op, not undoable
    emitSnapshotInvalidated();
    return okResult ("unblock_plugin");
}

juce::var MoshOps::cmdBlockPlugin (const juce::var& args)
{
    const auto id = args.getProperty ("pluginId", var()).toString();
    if (id.isEmpty()) return errResult ("block_plugin", "missing pluginId");

    // The incoming pluginId is the UI-facing identifier (e.g. "VST3-Serum") produced
    // by idFor()/te::createIdentifierString.  The JUCE blacklist is keyed on
    // PluginDescription.fileOrIdentifier (a file path for VST3, an "AudioUnit:..."
    // string for AU).  We must resolve the UI id -> fileOrIdentifier before blocking,
    // otherwise the key is wrong and the block has no effect on future scans.
    juce::PluginDescription desc;
    if (pluginHost.findDescription (id, desc))
    {
        // Found in the live catalog: block by the format-native key (fileOrIdentifier).
        // available() filters blocked entries, so this plugin disappears from
        // list_plugins immediately without needing to remove it from the type list
        // (the type list is the persistent catalog; the blacklist is the gate).
        pluginHost.blockPlugin (desc.fileOrIdentifier);
    }
    else
    {
        // Not in the catalog. The caller may be passing a raw fileOrIdentifier or
        // an "AudioUnit:..." id directly.  Accept it as-is so AU crash-recovery and
        // pre-emptive blocks still work, but a bogus id is harmless (empty blacklist
        // entries do nothing).
        if (id.contains ("/") || id.startsWith ("AudioUnit:") || id.startsWith ("VST3:"))
            pluginHost.blockPlugin (id);
        else
            return errResult ("block_plugin", "pluginId not found in catalog and does not look like a raw identifier");
    }

    logLine ("block_plugin", args, true, {}, false);             // catalog op, not undoable
    emitSnapshotInvalidated();
    return okResult ("block_plugin");
}

juce::var MoshOps::cmdAddAutomationPoint (const juce::var& args)
{
    auto* param = findParam (args.getProperty ("trackId", var()).toString(),
                             (int) args.getProperty ("pluginIndex", -1),
                             (int) args.getProperty ("paramIndex", -1));
    if (param == nullptr) return errResult ("add_automation_point", "no such parameter");
    const double t = juce::jmax (0.0, (double) args.getProperty ("time", 0.0));
    const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) args.getProperty ("value", 0.0));
    beginTxn ("add_automation_point");
    const int idx = param->getCurve().addPoint (tracktion::TimePosition::fromSeconds (t),
                                                 param->valueRange.convertFrom0to1 (norm), 0.0f, &undoManager());
    logLine ("add_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("pointIndex", idx);
    return okResult ("add_automation_point", var (data));
}

juce::var MoshOps::cmdRemoveAutomationPoint (const juce::var& args)
{
    auto* param = findParam (args.getProperty ("trackId", var()).toString(),
                             (int) args.getProperty ("pluginIndex", -1),
                             (int) args.getProperty ("paramIndex", -1));
    if (param == nullptr) return errResult ("remove_automation_point", "no such parameter");
    auto& curve = param->getCurve();
    const int idx = (int) args.getProperty ("pointIndex", -1);
    if (idx < 0 || idx >= curve.getNumPoints()) return errResult ("remove_automation_point", "bad pointIndex");
    beginTxn ("remove_automation_point");
    curve.removePoint (idx, &undoManager());
    logLine ("remove_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_automation_point");
}

juce::var MoshOps::cmdSetAutomationPoint (const juce::var& args)
{
    // Move a point: remove + re-add at the new (time, value).
    auto* param = findParam (args.getProperty ("trackId", var()).toString(),
                             (int) args.getProperty ("pluginIndex", -1),
                             (int) args.getProperty ("paramIndex", -1));
    if (param == nullptr) return errResult ("set_automation_point", "no such parameter");
    auto& curve = param->getCurve();
    const int idx = (int) args.getProperty ("pointIndex", -1);
    if (idx < 0 || idx >= curve.getNumPoints()) return errResult ("set_automation_point", "bad pointIndex");

    const double t = juce::jmax (0.0, (double) args.getProperty ("time", curve.getPointTime (idx).inSeconds()));
    const float norm = juce::jlimit (0.0f, 1.0f,
        (float) (double) args.getProperty ("value", param->valueRange.convertTo0to1 (curve.getPointValue (idx))));
    beginTxn ("set_automation_point");
    curve.removePoint (idx, &undoManager());
    const int newIdx = curve.addPoint (tracktion::TimePosition::fromSeconds (t),
                                       param->valueRange.convertFrom0to1 (norm), 0.0f, &undoManager());
    logLine ("set_automation_point", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("pointIndex", newIdx);
    return okResult ("set_automation_point", var (data));
}

juce::var MoshOps::cmdClearAutomation (const juce::var& args)
{
    auto* param = findParam (args.getProperty ("trackId", var()).toString(),
                             (int) args.getProperty ("pluginIndex", -1),
                             (int) args.getProperty ("paramIndex", -1));
    if (param == nullptr) return errResult ("clear_automation", "no such parameter");
    beginTxn ("clear_automation");
    param->getCurve().clear (&undoManager());
    logLine ("clear_automation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("clear_automation");
}

// ─────────────────────────────────────────────────────────────────────────────
// G10 — parameter automation RECORDING (v0). set_track_automation_mode arms/disarms
// the record mode on a TRACK (not a single parameter — every automatable param on the
// track is captured while write-armed); write_automation_curve bulk-authors a curve in
// one undoable step. See docs/superpowers/specs/2026-07-17-g10-automation-record.md.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdSetTrackAutomationMode (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (trackId);
    if (track == nullptr) return errResult ("set_track_automation_mode", "no track");

    const auto parsed = parseAutomationRecordMode (args.getProperty ("mode", var()).toString());
    if (! parsed.ok) return errResult ("set_track_automation_mode", parsed.error);

    te::AutomationMode engineMode = te::AutomationMode::read;
    switch (parsed.mode)
    {
        case AutomationRecordMode::read:  engineMode = te::AutomationMode::read;  break;
        case AutomationRecordMode::touch: engineMode = te::AutomationMode::touch; break;
        case AutomationRecordMode::latch: engineMode = te::AutomationMode::latch; break;
        case AutomationRecordMode::write: engineMode = te::AutomationMode::write; break;
    }

    beginTxn ("set_track_automation_mode");
    // Track::automationMode is a CachedValue<AutomationMode> already referTo()'d against
    // the real Edit UndoManager (tracktion_Track.cpp) — a plain assignment is undo-correct
    // on its own; no custom UndoableAction needed (unlike the value-write bug fixed above).
    track->automationMode = engineMode;
    logLine ("set_track_automation_mode", args, true, {}, true);
    emitTrackPatch (*track);
    return okResult ("set_track_automation_mode");
}

juce::var MoshOps::cmdWriteAutomationCurve (const juce::var& args)
{
    const auto trackId     = args.getProperty ("trackId", var()).toString();
    const int  pluginIndex = (int) args.getProperty ("pluginIndex", -1);
    const int  paramIndex  = (int) args.getProperty ("paramIndex", -1);
    auto* param = findParam (trackId, pluginIndex, paramIndex);
    if (param == nullptr) return errResult ("write_automation_curve", "no such parameter");

    const auto apply = args.getProperty ("apply", "replace").toString();
    if (apply != "replace" && apply != "merge")
        return errResult ("write_automation_curve", "apply must be \"replace\" or \"merge\"");

    // Validate the WHOLE point array BEFORE any mutation (DRM-002 discipline — a rejected
    // call leaves no empty/partial undo step).
    const auto parsed = parseAutomationCurvePoints (args.getProperty ("points", var()));
    if (! parsed.ok) return errResult ("write_automation_curve", parsed.error);

    AutomationCurveReplaceRangeResult replaceRange;
    if (apply == "replace")
    {
        replaceRange = parseAutomationCurveReplaceRange (args, parsed.points);
        if (! replaceRange.ok) return errResult ("write_automation_curve", replaceRange.error);
    }

    beginTxn ("write_automation_curve");
    auto& curve = param->getCurve();
    if (apply == "replace")
    {
        // The validated replacement window defaults to the new points' span, or includes
        // explicit old bounds when an editor moves an edge point. Pad its end because
        // removePointsInRegion is HALF-OPEN [start,end); without the sub-millisecond epsilon,
        // a point exactly at the final timestamp would survive and be duplicated.
        const auto rangeStart = tracktion::TimePosition::fromSeconds (replaceRange.start);
        const auto rangeEnd   = tracktion::TimePosition::fromSeconds (replaceRange.end + 0.0005);
        curve.removePointsInRegion (tracktion::TimeRange (rangeStart, rangeEnd), &undoManager());
    }
    for (const auto& p : parsed.points)
        curve.addPoint (tracktion::TimePosition::fromSeconds (p.t),
                        param->valueRange.convertFrom0to1 (p.v), p.curve, &undoManager());

    logLine ("write_automation_curve", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("pointCount", (int) parsed.points.size());
    data->setProperty ("numPoints", curve.getNumPoints());
    return okResult ("write_automation_curve", var (data));
}

juce::var MoshOps::cmdOpenPluginEditor (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* plugin = findPlugin (trackId,
                               (int) args.getProperty ("index", -1));
    if (plugin == nullptr) return errResult ("open_plugin_editor", "no plugin");
    const bool contextActiveBefore = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    if (eng.hasAudio())
        eng.ensurePlaybackContext();
    const bool contextActiveAfter = eng.edit().getTransport().getCurrentPlaybackContext() != nullptr;
    pluginHost.openEditor (*plugin,
        [this, trackId] (te::AutomatableParameter& parameter, float before, float after)
        {
            return mirrorTrackEditorParameter (trackId, parameter, before, after);
        }); // opening is not undoable; parameter changes traverse set_plugin_param
    logLine ("open_plugin_editor", args, true, {}, false);
    auto* data = new DynamicObject();
    data->setProperty ("audioEnabled", eng.hasAudio());
    data->setProperty ("playbackContextActiveBefore", contextActiveBefore);
    data->setProperty ("playbackContextActive", contextActiveAfter);
    data->setProperty ("plugin", plugin->getName());
    return okResult ("open_plugin_editor", var (data));
}

// Native-editor callbacks deliberately author an ordinary parameter command. Keep these
// adapters next to the non-transactional open-editor handler rather than between two
// transaction-safe command handlers: the transaction-safety source audit derives each
// command span up to the next juce::var handler and must not attribute this adapter's
// nested execute() to set_plugin_param/set_master_plugin_param themselves.
bool MoshOps::mirrorTrackEditorParameter (const juce::String& trackId,
                                          te::AutomatableParameter& parameter,
                                          float before, float after)
{
    // perform()/undo()/redo() from the ordinary command path deliberately notify
    // parameter listeners so plugin UIs repaint. They are not fresh editor mutations.
    if (pluginParamReplayDepth > 0 || std::abs (before - after) <= 1.0e-7f)
        return true;

    auto restoreBefore = [&]
    {
        ScopedPluginParamReplay replay;
        parameter.setParameterWithoutUndo (
            parameter.getValueRange().clipValue (before), juce::dontSendNotification);
    };

    auto* track = findTrack (trackId);
    if (track == nullptr)
    {
        restoreBefore();
        return false;
    }

    auto plugins = track->pluginList.getPlugins();
    int pluginIndex = -1;
    int paramIndex = -1;
    te::Plugin* owner = nullptr;
    for (int i = 0; i < plugins.size(); ++i)
    {
        if ((paramIndex = indexOfParameter (*plugins[i], parameter)) >= 0)
        {
            pluginIndex = i;
            owner = plugins[i].get();
            break;
        }
    }
    if (owner == nullptr)
    {
        restoreBefore();
        return false;
    }

    const auto& range = parameter.getValueRange();
    auto* args = new DynamicObject();
    args->setProperty ("trackId", trackId);
    args->setProperty ("index", pluginIndex);
    args->setProperty ("pluginItemId", owner->itemID.toString());
    args->setProperty ("paramIndex", paramIndex);
    args->setProperty ("paramName", parameter.getParameterName());
    args->setProperty ("value", parameter.valueRange.convertTo0to1 (range.clipValue (after)));
    args->setProperty ("previousValue", parameter.valueRange.convertTo0to1 (range.clipValue (before)));
    args->setProperty ("source", "plugin_editor");

    // The editor already applied `after`. Rewind without notification, then feed the
    // desired value through the ordinary command so validation, lock ownership, undo,
    // automation-write capture, JSONL, events, multiplayer, and reactive re-rendering
    // are identical to every other plugin-parameter mutation.
    restoreBefore();
    auto* command = new DynamicObject();
    command->setProperty ("command", "set_plugin_param");
    command->setProperty ("args", var (args));
    const auto result = execute (var (command));
    return (bool) result.getProperty ("ok", false);
}

bool MoshOps::mirrorMasterEditorParameter (te::AutomatableParameter& parameter,
                                           float before, float after)
{
    if (pluginParamReplayDepth > 0 || std::abs (before - after) <= 1.0e-7f)
        return true;

    auto restoreBefore = [&]
    {
        ScopedPluginParamReplay replay;
        parameter.setParameterWithoutUndo (
            parameter.getValueRange().clipValue (before), juce::dontSendNotification);
    };

    auto plugins = eng.edit().getMasterPluginList().getPlugins();
    int pluginIndex = -1;
    int paramIndex = -1;
    te::Plugin* owner = nullptr;
    for (int i = 0; i < masterVisibleBoundary(); ++i)
    {
        if ((paramIndex = indexOfParameter (*plugins[i], parameter)) >= 0)
        {
            pluginIndex = i;
            owner = plugins[i].get();
            break;
        }
    }
    if (owner == nullptr)
    {
        restoreBefore();
        return false;
    }

    const auto& range = parameter.getValueRange();
    auto* args = new DynamicObject();
    args->setProperty ("index", pluginIndex);
    args->setProperty ("pluginItemId", owner->itemID.toString());
    args->setProperty ("paramIndex", paramIndex);
    args->setProperty ("paramName", parameter.getParameterName());
    args->setProperty ("value", parameter.valueRange.convertTo0to1 (range.clipValue (after)));
    args->setProperty ("previousValue", parameter.valueRange.convertTo0to1 (range.clipValue (before)));
    args->setProperty ("source", "plugin_editor");

    restoreBefore();
    auto* command = new DynamicObject();
    command->setProperty ("command", "set_master_plugin_param");
    command->setProperty ("args", var (args));
    const auto result = execute (var (command));
    return (bool) result.getProperty ("ok", false);
}

// DRM-001 — locate the bundled default drum kit. Resolution mirrors WebBridge's UI
// lookup: an env override first (tests / dev), then the app-bundle Resources, then
// next to the executable. Falls back to the bundle path so callers get a sensible
// (if absent) File to test with existsAsFile().
// The kit LIBRARY root — the directory that holds one folder per kit. CMake already
// stages the whole `drumkits` tree into the bundle, so adding a kit is dropping a folder
// in; no build change is needed.
juce::File MoshOps::drumKitsRoot() const
{
    using juce::File;

    // MOSH_DRUMKITS_DIR (plural) points at the library. The older MOSH_DRUMKIT_DIR
    // (singular) means "this directory IS the kit" and is handled by drumKitDir below —
    // both are honoured, because the singular one has live consumers including the
    // selftest's own resolver.
    const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_DRUMKITS_DIR", {});
    if (env.isNotEmpty())
    {
        File d (env);
        if (d.isDirectory()) return d;
    }

    auto appFile = File::getSpecialLocation (File::currentApplicationFile);
    auto bundled = appFile.getChildFile ("Contents/Resources/drumkits");
    if (bundled.isDirectory()) return bundled;

    auto exeDir = File::getSpecialLocation (File::currentExecutableFile)
                      .getParentDirectory().getChildFile ("drumkits");
    if (exeDir.isDirectory()) return exeDir;

    return bundled;   // best-effort; callers guard on existsAsFile()
}

// See MoshOps.h: the user's own kit library; env override keeps harness runs
// off the real ~/Library (JUCE ignores $HOME).
juce::File MoshOps::drumKitsUserRoot() const
{
    const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_KITS_USER_DIR", {});
    if (env.isNotEmpty()) return juce::File (env);
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile ("Library/Mosh/kits");
}

juce::File MoshOps::drumKitDir (const juce::String& kitId) const
{
    using juce::File;

    // BACKWARD COMPATIBILITY: MOSH_DRUMKIT_DIR (singular) has always meant "this directory
    // is the kit", and both MoshOps and the selftest's resolver rely on that. Honour it for
    // the default kit; a caller asking for a NAMED kit means the library.
    const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_DRUMKIT_DIR", {});
    if (env.isNotEmpty() && (kitId.isEmpty() || kitId == kDefaultKitId))
    {
        File d (env);
        if (d.isDirectory()) return d;
    }
    // A named user kit shadows a same-id bundled kit (the user's curation wins).
    if (kitId.isNotEmpty())
    {
        auto user = drumKitsUserRoot().getChildFile (kitId);
        if (user.isDirectory()) return user;
    }
    return drumKitsRoot().getChildFile (kitId.isEmpty() ? kDefaultKitId : kitId);
}

juce::File MoshOps::drumKitDir() const { return drumKitDir (kDefaultKitId); }

// ─────────────────────────────────────────────────────────────────────────────
// P1 preset seam — list_presets / load_preset (flywheel pillar 1: real sounds).
//
// Library layout: <root>/<pluginKey>/<preset file>, pluginKey ∈ {"vital","4osc",…}.
// Two roots: the bundled bank (resolution mirrors drumKitsRoot) and the user's
// ~/Library/Mosh/presets. `.vital` files target a hosted Vital VST3; `.json`
// files are 4OSC patches ({"params": {"<display name>": normalized 0..1},
// "waveShapes": [perOscInt…]}).
// ─────────────────────────────────────────────────────────────────────────────

juce::File MoshOps::presetsBundledRoot() const
{
    using juce::File;
    const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_PRESETS_DIR", {});
    if (env.isNotEmpty())
    {
        File d (env);
        if (d.isDirectory()) return d;
    }
    auto appFile = File::getSpecialLocation (File::currentApplicationFile);
    auto bundled = appFile.getChildFile ("Contents/Resources/presets");
    if (bundled.isDirectory()) return bundled;
    auto exeDir = File::getSpecialLocation (File::currentExecutableFile)
                      .getParentDirectory().getChildFile ("presets");
    if (exeDir.isDirectory()) return exeDir;
    return bundled;   // best-effort; callers guard on isDirectory()
}

juce::File MoshOps::presetsUserRoot() const
{
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile ("Library/Mosh/presets");
}

namespace
{
    // Wrap a raw `.vital` (plain JSON) into the blob a JUCE VST3 HOST accepts via
    // AudioPluginInstance::setStateInformation. The host wrapper first runs
    // AudioProcessor::getXmlFromBinary, which demands the copyXmlToBinary framing:
    // juce::magicXmlNumber ("VC2!", LE) + LE uint32 xml length + single-line
    // <VST3PluginState><IComponent>MemoryBlock-base64</IComponent></VST3PluginState>
    // + trailing NUL — anything else makes setStateInformation a silent no-op (the
    // 2026-05-11 MonsterDAWW diagnosis; its Python port, vital_state_wrap.py, is the
    // byte-verified reference for this framing). Here MemoryBlock::toBase64Encoding
    // is the real JUCE call, so only the framing is reproduced (copyXmlToBinary
    // itself is protected inside AudioProcessor).
    juce::MemoryBlock wrapVitalStateForJuceVst3Host (const juce::MemoryBlock& rawVitalJson)
    {
        juce::XmlElement root ("VST3PluginState");
        root.createNewChildElement ("IComponent")->addTextElement (rawVitalJson.toBase64Encoding());
        const auto xmlText = root.toString (juce::XmlElement::TextFormat().singleLine());
        juce::MemoryBlock out;
        juce::MemoryOutputStream mo (out, false);
        mo.writeInt (0x21324356);                       // juce::magicXmlNumber, "VC2!" LE
        const auto utf8 = xmlText.toRawUTF8();
        const auto len = (int) strlen (utf8);
        mo.writeInt (len);
        mo.write (utf8, (size_t) len);
        mo.writeByte (0);
        mo.flush();
        return out;
    }

    bool looksLikeWrappedState (const juce::MemoryBlock& b)
    {
        return b.getSize() >= 8 && juce::ByteOrder::littleEndianInt (b.getData()) == 0x21324356u;
    }

    // Apply/undo a whole external-plugin state blob. Same UAF-safe shape as
    // SetPluginParamValueAction above: never holds the plugin across perform/undo —
    // re-resolves by stable EditItemID every call, no-ops if unresolvable.
    struct LoadPresetStateAction final : public juce::UndoableAction
    {
        LoadPresetStateAction (te::Edit& e, te::EditItemID id,
                               juce::MemoryBlock before, juce::MemoryBlock after)
            : edit (e), pluginItemId (id),
              stateBefore (std::move (before)), stateAfter (std::move (after)) {}

        bool perform() override        { apply (stateAfter);  return true; }
        bool undo() override           { apply (stateBefore); return true; }
        int  getSizeInUnits() override { return (int) (sizeof (*this) + stateBefore.getSize() + stateAfter.getSize()); }

        void apply (const juce::MemoryBlock& blob)
        {
            if (blob.getSize() == 0) return;
            auto plugin = edit.getPluginCache().getPluginFor (pluginItemId);
            if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin.get()))
                if (auto* inst = ext->getAudioPluginInstance())
                {
                    inst->setStateInformation (blob.getData(), (int) blob.getSize());
                    // Persist into the Edit's ValueTree so save/reload carries the patch.
                    ext->flushPluginStateToValueTree();
                }
        }

        te::Edit& edit;
        const te::EditItemID pluginItemId;
        const juce::MemoryBlock stateBefore, stateAfter;
    };
}

juce::var MoshOps::cmdListPresets (const juce::var& args)
{
    const auto filter = args.getProperty ("plugin", var()).toString().toLowerCase();
    juce::Array<var> out;
    auto scanRoot = [&] (const juce::File& root, const char* source)
    {
        if (! root.isDirectory()) return;
        for (const auto& pluginDir : root.findChildFiles (juce::File::findDirectories, false))
        {
            const auto key = pluginDir.getFileName().toLowerCase();
            if (filter.isNotEmpty() && key != filter) continue;
            for (const auto& f : pluginDir.findChildFiles (juce::File::findFiles, false))
            {
                const auto ext = f.getFileExtension().toLowerCase();
                if (ext != ".vital" && ext != ".json") continue;
                auto* o = new DynamicObject();
                o->setProperty ("plugin", key);
                o->setProperty ("name", f.getFileNameWithoutExtension());
                o->setProperty ("file", f.getFullPathName());
                o->setProperty ("source", source);
                out.add (var (o));
            }
        }
    };
    scanRoot (presetsBundledRoot(), "bundled");
    scanRoot (presetsUserRoot(), "user");
    auto* data = new DynamicObject();
    data->setProperty ("presets", var (out));
    return okResult ("list_presets", var (data));
}

juce::var MoshOps::cmdLoadPreset (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const auto fileArg = args.getProperty ("file", var()).toString();
    const int  index   = (int) args.getProperty ("index", -1);

    auto* track = findTrack (trackId);
    if (track == nullptr) return errResult ("load_preset", "no track");
    juce::File file (fileArg);
    if (! file.existsAsFile()) return errResult ("load_preset", "preset file not found: " + fileArg);
    if (file.getSize() > 16 * 1024 * 1024) return errResult ("load_preset", "preset file too large");
    const auto ext = file.getFileExtension().toLowerCase();
    const auto presetName = file.getFileNameWithoutExtension();

    // ── .vital → a hosted Vital VST3 on this track ───────────────────────────
    if (ext == ".vital")
    {
        // Resolve the target BEFORE any transaction (G14: never open a txn that
        // might stay empty). An explicit index wins; otherwise the first external
        // synth whose name says Vital — deliberately NEVER any other synth, so a
        // .vital can't blast Serum's state.
        te::ExternalPlugin* target = nullptr;
        if (index >= 0)
            target = dynamic_cast<te::ExternalPlugin*> (findPlugin (trackId, index));
        else
            for (auto p : track->pluginList)
                if (auto* e = dynamic_cast<te::ExternalPlugin*> (p))
                    if (e->isSynth() && e->getName().containsIgnoreCase ("vital")) { target = e; break; }
        if (target == nullptr || ! target->getName().containsIgnoreCase ("vital"))
            return errResult ("load_preset", "no Vital instrument on this track (a .vital preset only targets Vital)");
        auto* inst = target->getAudioPluginInstance();
        if (inst == nullptr) return errResult ("load_preset", "Vital instance not available (plugin still loading?)");

        juce::MemoryBlock raw;
        if (! file.loadFileAsData (raw) || raw.getSize() == 0)
            return errResult ("load_preset", "could not read preset file");
        const auto blob = looksLikeWrappedState (raw) ? raw : wrapVitalStateForJuceVst3Host (raw);

        juce::MemoryBlock before;
        inst->getStateInformation (before);

        beginTxn ("load_preset");
        undoManager().perform (new LoadPresetStateAction (eng.edit(), target->itemID, std::move (before), blob));
        logLine ("load_preset", args, true, {}, true);
        emitTrackPatch (*track);
        reactiveTouchTrack (trackId);
        auto* data = new DynamicObject();
        data->setProperty ("plugin", target->getName());
        data->setProperty ("preset", presetName);
        // HONESTY: the state blob reached the plugin, but Vital applies patches on
        // its message-loop machinery — whether the PATCH audibly landed is proven
        // by ear / a state round-trip in the running app, not by this return.
        data->setProperty ("note", "state sent; verify audibly (Vital applies patches asynchronously)");
        return okResult ("load_preset", var (data));
    }

    // ── .json → the built-in 4OSC on this track ──────────────────────────────
    if (ext == ".json")
    {
        // A track-chain preset is a different thing from an instrument patch, and this
        // command is agent-reachable while apply_track_preset deliberately is not. Refuse
        // it by NAME. Checked twice: by its library folder FIRST, before the 4OSC lookup,
        // so a file picked from list_presets gets "wrong command" on any track rather
        // than "no 4OSC instrument" on the vocal track it was meant for; and by the
        // file's own `kind` once it is parsed, for one that was copied somewhere else.
        static const juce::String wrongSeam ("this is a track preset, not an instrument patch — "
                                             "apply it from the track's Vocal preset menu");
        if (file.getParentDirectory().getFileName() == trackpreset::kLibraryKey)
            return errResult ("load_preset", wrongSeam);

        te::Plugin* target = index >= 0 ? findPlugin (trackId, index) : nullptr;
        if (target == nullptr)
            for (auto p : track->pluginList)
                if (dynamic_cast<te::FourOscPlugin*> (p) != nullptr) { target = p; break; }
        auto* fourOsc = dynamic_cast<te::FourOscPlugin*> (target);
        if (fourOsc == nullptr)
            return errResult ("load_preset", "no 4OSC instrument on this track (a .json preset targets the built-in 4OSC)");

        const auto parsed = juce::JSON::parse (file.loadFileAsString());
        if (parsed.getProperty ("kind", var()).toString() == trackpreset::kKind)
            return errResult ("load_preset", wrongSeam);
        const auto params = parsed.getProperty ("params", var());
        auto* paramsObj = params.getDynamicObject();
        const auto waveShapes = parsed.getProperty ("waveShapes", var());

        // Resolve every named param BEFORE the txn (G14 again): apply-all-or-error.
        struct Pending { te::AutomatableParameter* p; int index; float raw; };
        juce::Array<Pending> pending;
        juce::StringArray unknown;
        if (paramsObj != nullptr)
            for (const auto& prop : paramsObj->getProperties())
            {
                te::AutomatableParameter* found = nullptr; int fi = -1;
                for (int i = 0; i < fourOsc->getNumAutomatableParameters(); ++i)
                {
                    auto ap = fourOsc->getAutomatableParameter (i);
                    if (ap != nullptr && ap->paramName.equalsIgnoreCase (prop.name.toString())) { found = ap.get(); fi = i; break; }
                }
                if (found == nullptr) { unknown.add (prop.name.toString()); continue; }
                const float norm = juce::jlimit (0.0f, 1.0f, (float) (double) prop.value);
                pending.add ({ found, fi, found->valueRange.convertFrom0to1 (norm) });
            }
        const bool hasShapes = waveShapes.isArray() && waveShapes.size() > 0;
        if (pending.isEmpty() && ! hasShapes)
            return errResult ("load_preset", "preset matched no 4OSC parameters"
                              + juce::String (unknown.isEmpty() ? "" : " (unknown: " + unknown.joinIntoString (", ") + ")"));

        beginTxn ("load_preset");
        for (const auto& pe : pending)
            undoManager().perform (new SetPluginParamValueAction (*pe.p, pe.index, pe.raw));
        if (hasShapes)
        {
            // Wave shape is a per-oscillator ValueTree property (not automatable).
            // Find the oscillator child trees in order and set their waveShape with
            // the undo manager, so the whole preset stays one undo step.
            int osc = 0;
            for (int i = 0; i < fourOsc->state.getNumChildren() && osc < waveShapes.size(); ++i)
            {
                auto child = fourOsc->state.getChild (i);
                if (child.hasProperty (te::IDs::waveShape) || child.getType().toString().containsIgnoreCase ("osc"))
                {
                    child.setProperty (te::IDs::waveShape, (int) waveShapes[osc], &undoManager());
                    ++osc;
                }
            }
        }
        logLine ("load_preset", args, true, {}, true);
        emitTrackPatch (*track);
        reactiveTouchTrack (trackId);
        auto* data = new DynamicObject();
        data->setProperty ("plugin", "4osc");
        data->setProperty ("preset", presetName);
        data->setProperty ("paramsApplied", pending.size());
        if (! unknown.isEmpty()) data->setProperty ("unknownParams", unknown.joinIntoString (", "));
        return okResult ("load_preset", var (data));
    }

    return errResult ("load_preset", "unsupported preset type: " + ext);
}

// ─────────────────────────────────────────────────────────────────────────────
// Track-chain presets — apply_track_preset {trackId, file}.
//
// Applies an ordered group of BUILT-IN effects ("Mosh Clean Lead v0": high-pass →
// compressor) to ONE explicitly named audio track as ONE undo step. Discovery reuses the
// preset library seam above: list_presets {plugin:"track-chain"}.
//
// A separate command from load_preset on purpose. load_preset swaps the state of an
// instrument the track already has and is in the agent's catalog; this INSERTS plugins,
// owns them as a group, and is UI-only — a producer applies a vocal chain, Moshi does not
// (agentic mixing is postponed, docs/vocal-presets/AUDIT-2026-10-01.md).
//
// The shape is preflight → one transaction → readback:
//
//   PREFLIGHT touches nothing: no engine object is created, the UndoManager is not
//   contacted, nothing is saved. Every reason the apply could fail is checked here —
//   the target, the file, each processor, each value against the pinned parameter table
//   (TrackPreset.h), the track's plugin capacity — so a refusal leaves no trace and no
//   empty transaction for the next undo to trip over (the G14 class).
//
//   APPLY is state-first (TrackPresetEngine.h::makeStageState): each stage is built as a
//   finished PLUGIN tree and the only undoable action is adding it to the track. No
//   parameter is written through the undo manager, so one undo removes the chain and one
//   redo restores it with its values, including after the plugin objects were purged.
//
//   READBACK reports what the live plugins hold, converted to the preset's units. A
//   value that did not land is a failure, never a success carrying the requested number.
//
// OWNERSHIP. Each inserted plugin is tagged (ids::moshPresetId …). Re-applying the same
// preset finds that group: untouched → a no-op that opens no transaction; edited, partial
// or reordered → only that group is replaced. A user's own plugin is never matched, even
// one of the same type. Replacing the group takes any automation the user drew on it
// along (one undo brings it back); nothing outside the group is touched.
//
// POSITION. The chain goes after the user's existing inserts and ahead of the first send
// and the fader, so the fader sets level rather than how hard the compressor is driven,
// and a send carries the processed voice. On a fresh track (mute gate + meter only) that
// is the end of the list, and the lazily created fader lands after it.
//
// NOT DONE HERE, deliberately: the transport is not stopped, nothing is rendered into
// the source audio, and no track gain, send, or other track is changed. Applying while
// RECORDING is refused — replacing the graph under a rolling record is not something this
// repo has proven safe, and a refusal the producer can read beats a take that glitched.
juce::var MoshOps::cmdApplyTrackPreset (const juce::var& args)
{
    using namespace trackpreset;
    static const juce::String cmd ("apply_track_preset");

    // ── preflight: the target ────────────────────────────────────────────────────────
    // The track is named by the caller, every time. There is no "selected track" here to
    // fall back to; an id that no longer resolves is an error, not a retarget.
    const auto trackId = args.getProperty ("trackId", var()).toString();
    if (trackId.isEmpty())
        return errResult (cmd, "trackId is required — a preset is applied to one named track");
    auto* track = findTrack (trackId);
    if (track == nullptr)
        return errResult (cmd, "no track: " + trackId);

    const auto trackType = track->state.getProperty (ids::trackType, "audio").toString();
    if (trackType != "audio")
        return errResult (cmd, "a vocal preset applies to an audio track; this is a " + trackType + " track");
    if (trackHasInstrument (*track))
        return errResult (cmd, "this track hosts an instrument; a vocal preset applies to an audio track");
    if (firstAuxReturnOn (*track) != nullptr)
        return errResult (cmd, "this is a return track; apply the preset to the vocal track that feeds it");
    if (eng.edit().getTransport().isRecording() || trackPresetPretendRecording_)
        return errResult (cmd, "cannot apply a preset while recording — stop recording first");

    // ── preflight: the preset ────────────────────────────────────────────────────────
    const auto fileArg = args.getProperty ("file", var()).toString();
    const juce::File file = juce::File::isAbsolutePath (fileArg) ? juce::File (fileArg) : juce::File();
    if (! file.existsAsFile())
        return errResult (cmd, "preset file not found: " + fileArg);
    if (file.getSize() > 1024 * 1024)
        return errResult (cmd, "preset file too large");
    const auto parsed = parseTrackPresetText (file.loadFileAsString());
    if (! parsed.ok)
        return errResult (cmd, "invalid track preset: " + parsed.error);
    const auto& preset = parsed.preset;
    const int numStages = (int) preset.stages.size();

    // The table only admits processors it pins; this confirms each is also in the
    // palette this build exposes (so the rack can name and show the row).
    for (const auto& stage : preset.stages)
        if (findBuiltin (stage.processor->type) == nullptr)
            return errResult (cmd, "this build has no '" + juce::String (stage.processor->type) + "' effect");

    // ── preflight: what is already there ─────────────────────────────────────────────
    auto& list = track->pluginList;
    juce::Array<te::Plugin*> owned;
    for (auto* p : list.getPlugins())
        if (p != nullptr && isOwnedBy (*p, preset.id))
            owned.add (p);

    auto ownedGroupIsThePreset = [&]
    {
        if (owned.size() != numStages) return false;
        for (int i = 0; i < numStages; ++i)
        {
            auto& p = *owned[i];
            if ((int) p.state.getProperty (ids::moshPresetStage, -1) != i
                || (int) p.state.getProperty (ids::moshPresetRevision, -1) != preset.revision
                || (i > 0 && list.indexOf (&p) != list.indexOf (owned[i - 1]) + 1)
                || stageMismatch (p, preset.stages[(size_t) i]).isNotEmpty())
                return false;
        }
        return true;
    };

    auto resultFor = [&] (bool changed, bool replaced)
    {
        juce::Array<var> stages;
        int i = 0;
        for (auto* p : list.getPlugins())
            if (p != nullptr && isOwnedBy (*p, preset.id) && i < numStages)
            {
                stages.add (stageReadback (*p, preset.stages[(size_t) i], list.indexOf (p)));
                ++i;
            }
        auto* data = new DynamicObject();
        data->setProperty ("trackId", track->itemID.toString());
        data->setProperty ("presetId", preset.id);
        data->setProperty ("revision", preset.revision);
        data->setProperty ("name", preset.name);
        data->setProperty ("changed", changed);
        data->setProperty ("replaced", replaced);
        data->setProperty ("stages", stages);
        return var (data);
    };

    // Already applied and untouched: nothing to do, so do nothing — in particular do NOT
    // open a transaction. An empty one would be logged as an undo step that undoes the
    // producer's PREVIOUS edit instead.
    if (ownedGroupIsThePreset())
        return okResult (cmd, resultFor (false, false));

    // Capacity, counted as it will be once the old group (if any) is gone. The engine's
    // insertPlugin drops a plugin silently at the limit, hidden mixer elements included.
    const int limit = eng.engine().getEngineBehaviour().getEditLimits().maxPluginsOnTrack;
    if (list.size() - owned.size() + numStages > limit)
        return errResult (cmd, "no room on this track for the preset's " + juce::String (numStages)
                               + " effects (a track holds at most " + juce::String (limit) + ")");

    // Where the chain goes: in place of the group being replaced, else ahead of the
    // first send and the fader, else at the end.
    auto insertIndexNow = [&]
    {
        auto plugins = list.getPlugins();
        for (int i = 0; i < plugins.size(); ++i)
            if (dynamic_cast<te::VolumeAndPanPlugin*> (plugins[i].get()) != nullptr
                || dynamic_cast<te::AuxSendPlugin*> (plugins[i].get()) != nullptr)
                return i;
        return plugins.size();
    };
    const bool replacing = ! owned.isEmpty();
    const int replaceAt = replacing ? list.indexOf (owned.getFirst()) : -1;

    // Finished PLUGIN trees, built with a null undo manager — still no engine contact.
    const bool remap = eng.engine().getEngineBehaviour().arePluginsRemappedWhenTempoChanges();
    juce::Array<juce::ValueTree> stageStates;
    for (int i = 0; i < numStages; ++i)
        stageStates.add (makeStageState (preset, i, remap));

    // ── apply: one transaction ───────────────────────────────────────────────────────
    beginTxn (cmd);
    auto& um = undoManager();

    // Rollback. Unreachable in real use — everything that can fail was checked above —
    // and exercised only through the selftest fault points. Outside a batch this
    // transaction is ours alone, so undoing it is exact and JUCE discards the undone set
    // (nothing is left redoable). Inside a batch "the current transaction" is the WHOLE
    // batch, so undoing it would take the batch's earlier commands too; there the pieces
    // are put back by hand.
    struct Removed { juce::ValueTree state; int index; };
    juce::Array<Removed> removed;
    juce::Array<te::Plugin::Ptr> inserted;
    auto rollback = [&]
    {
        if (! inBatch)
        {
            if (um.getNumActionsInCurrentTransaction() > 0)
                um.undoCurrentTransactionOnly();
        }
        else
        {
            for (int i = inserted.size(); --i >= 0;)
                inserted[i]->deleteFromParent();
            for (const auto& r : removed)             // ascending, so each index is valid as it lands
                list.insertPlugin (r.state, r.index);
        }
        synchronisePlaybackGraph();
    };
    auto fail = [&] (const juce::String& why)
    {
        rollback();
        return errResult (cmd, why);
    };

    // Create every stage and prove it holds the preset BEFORE the track is touched.
    juce::Array<te::Plugin::Ptr> created;
    for (int i = 0; i < numStages; ++i)
    {
        auto plugin = eng.edit().getPluginCache().createNewPlugin (stageStates[i]);
        if (plugin == nullptr)
            return fail ("could not create the preset's " + juce::String (preset.stages[(size_t) i].processor->type));
        if (auto why = stageMismatch (*plugin, preset.stages[(size_t) i]); why.isNotEmpty())
            return fail ("the preset did not load as written: " + why);
        created.add (plugin);
    }
    if (trackPresetFaultPoint_ == 1)
        return fail ("injected fault after creating the preset stages (selftest)");

    if (replacing)
    {
        for (auto* p : owned)
        {
            removed.add ({ p->state, list.indexOf (p) });
            pluginHost.closeEditor (*p);
        }
        for (int i = owned.size(); --i >= 0;)
            owned[i]->deleteFromParent();
    }

    // Removing the old group cannot move anything ahead of its first member, so that
    // position is still where the new group belongs.
    const int at = replacing ? replaceAt : insertIndexNow();
    for (int i = 0; i < numStages; ++i)
    {
        list.insertPlugin (created[i], at + i, nullptr);
        inserted.add (created[i]);   // before the check: a misplaced insert must still be rolled back
        if (list.indexOf (created[i].get()) != at + i)
            return fail ("could not insert the preset's " + juce::String (preset.stages[(size_t) i].processor->type));
        if (trackPresetFaultPoint_ == 2 && i == 0)
            return fail ("injected fault after inserting the first preset stage (selftest)");
    }
    synchronisePlaybackGraph();

    // Readback from the live, inserted plugins. Reported as actual values; if they are
    // not the preset's, that is a failure.
    for (int i = 0; i < numStages; ++i)
        if (auto why = stageMismatch (*created[i], preset.stages[(size_t) i]); why.isNotEmpty())
            return fail ("the preset did not read back as written: " + why);

    logLine (cmd, args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (trackId);   // the track's sound changed → re-bounce anything layered on it
    return okResult (cmd, resultFor (true, replacing));
}

bool MoshOps::drumKitAvailable (const juce::String& kitId) const
{
    const auto dir = drumKitDir();
    for (auto& pad : kDefaultKit)
        if (dir.getChildFile (pad.file).existsAsFile())
            return true;
    return false;
}

// DRM-001 — the track's existing te::SamplerPlugin, or a fresh one created via the
// Edit's PluginCache (so the inserted plugin IS the one we hold — see cmdLoadPlugin)
// and inserted at the FRONT of the chain (instrument-first: it sources audio that
// the volume/fx downstream then process).
te::SamplerPlugin* MoshOps::ensureSampler (te::AudioTrack& track)
{
    for (auto* p : track.pluginList.getPlugins())
        if (auto* s = dynamic_cast<te::SamplerPlugin*> (p))
            return s;

    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::SamplerPlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    track.pluginList.insertPlugin (plugin, 0, nullptr);   // front of chain
    return dynamic_cast<te::SamplerPlugin*> (plugin.get());
}

te::SamplerPlugin* MoshOps::findSampler (te::AudioTrack& track) const
{
    for (auto* p : track.pluginList.getPlugins())
        if (auto* s = dynamic_cast<te::SamplerPlugin*> (p))
            return s;
    return nullptr;
}

// Parse / pack a comma-separated pitch set (the drumMute/drumSolo track props).
static juce::SortedSet<int> parseLanePitches (const juce::String& s)
{
    juce::SortedSet<int> set;
    for (auto& tok : juce::StringArray::fromTokens (s, ",", ""))
        if (tok.trim().isNotEmpty()) set.add (tok.trim().getIntValue());
    return set;
}

// The i-th SOUND child of a sampler's state. te::SamplerPlugin::getSound does exactly
// this walk to resolve a pad index, but it is private — and every pad index in this file
// comes from that same numbering, so the two must agree.
static juce::ValueTree soundTreeAt (te::SamplerPlugin& sampler, int index)
{
    int n = 0;
    for (auto v : sampler.state)
        if (v.hasType (te::IDs::SOUND))
            if (n++ == index)
                return v;
    return {};
}

// The quietest gain the engine will actually STORE. te::SamplerPlugin clamps every gain
// write to [-48, +48] dB, in setSoundGains and again in the SamplerSound constructor, so
// -48 dB is silence as far as this plugin is concerned. Writing -100 does not store -100;
// it stores -48. (That mattered — see applyDrumLaneGains below.)
static constexpr float kPadMuteDb = -48.0f;

void MoshOps::applyDrumLaneGains (te::AudioTrack& track)
{
    auto* sampler = findSampler (track);
    if (sampler == nullptr) return;

    const auto muted = parseLanePitches (track.state.getProperty (ids::drumMute, "").toString());
    const auto solo  = parseLanePitches (track.state.getProperty (ids::drumSolo, "").toString());
    const bool soloActive = solo.size() > 0;

    for (int i = 0; i < sampler->getNumSounds(); ++i)
    {
        const int  key        = sampler->getKeyNote (i);
        const bool shouldMute = soloActive ? ! solo.contains (key) : muted.contains (key);

        auto sound = soundTreeAt (*sampler, i);
        if (! sound.isValid()) continue;

        // Whether a pad is currently silenced is recorded EXPLICITLY — the presence of the
        // parked gain is the flag — and never inferred from the gain itself. Inferring it
        // is precisely what broke this: the old code muted by writing -100 and detected
        // mute by reading back <= -99, but both values sit outside the engine's clamp, so
        // the stored gain was always -48, the restore branch never once fired, and a muted
        // lane stayed 48 dB down forever (persisting through save/reload). The selftest
        // beside it stayed green the whole time because it only ever asserted that the
        // muted-pitch SET rode the snapshot; nothing read a pad gain.
        const bool isMuted = sound.hasProperty (ids::moshPadGainDb);
        if (shouldMute == isMuted) continue;             // already in the state we want

        if (shouldMute)
        {
            // Park the pad's own gain before silencing it. NOTE for any future per-pad
            // gain control: while a pad is muted this parked copy — not the live gain —
            // is the user's setting, so a gain edit must be written HERE instead.
            sound.setProperty (ids::moshPadGainDb, sampler->getSoundGainDb (i), &undoManager());
            sampler->setSoundGains (i, kPadMuteDb, sampler->getSoundPan (i));
        }
        else
        {
            const auto parked = (float) (double) sound.getProperty (ids::moshPadGainDb, 0.0);
            sound.removeProperty (ids::moshPadGainDb, &undoManager());
            sampler->setSoundGains (i, parked, sampler->getSoundPan (i));
        }
    }
}

// plugin.sampler (docs/02_MOSHOPS_CONTRACT.md, Snapshot): every sound of one sampler, read
// from the SOUND children of its persisted state in one walk (the numbering every pad index
// uses, see soundTreeAt). Never from getSoundMedia / getSoundFile / getSoundLength, which
// read the list the sampler loads asynchronously, under the lock its audio thread takes, and
// which is empty or stale until that load has run. track.drumPads is a separate, older
// reading of the primary sampler and is left as it is.
//
// Per sound: `file` is the persisted source string; `path` is where the sampler finds it
// (resolved through the edit's filePathResolver, as the sampler resolves it, so an
// edit-relative source after Save-As is still absolute here; "" if it cannot be resolved);
// `missing` is true when nothing is at `path`. `silenced` is the parked-gain flag
// applyDrumLaneGains sets for a muted lane AND for a pad silenced by another lane's solo;
// `userGainDb` is the producer's level (the parked copy while silenced, else the live gain).
// `addressNote` is the lowest note the pad commands' narrowest-range rule resolves to THIS
// sound, absent when every note it covers reaches a narrower one. The file's length, rate
// and channels come from te::AudioFile's info (cached by the AudioFileManager; it takes
// only that cache's lock, never the sampler's).
juce::var MoshOps::samplerToVar (te::SamplerPlugin& sampler, te::AudioTrack* owner)
{
    std::vector<juce::ValueTree> sounds;
    for (auto v : sampler.state)
        if (v.hasType (te::IDs::SOUND))
            sounds.push_back (v);
    std::vector<std::pair<int, int>> ranges;
    for (const auto& sound : sounds)
        ranges.emplace_back ((int) sound[te::IDs::minNote], (int) sound[te::IDs::maxNote]);

    auto& edit = eng.edit();
    Array<var> list;
    for (int i = 0; i < (int) sounds.size(); ++i)
    {
        const auto& sound = sounds[(size_t) i];
        const auto source = sound[te::IDs::source].toString();
        const auto file = te::SourceFileReference::findFileFromString (edit, source);
        const bool resolved = file != juce::File();
        const bool exists = resolved && file.existsAsFile();
        const float gainDb = (float) sound[te::IDs::gainDb];
        const bool silenced = sound.hasProperty (ids::moshPadGainDb);
        const int lo = ranges[(size_t) i].first, hi = ranges[(size_t) i].second;

        auto* o = new DynamicObject();
        o->setProperty ("index", i);
        o->setProperty ("name", sound[te::IDs::name].toString());
        o->setProperty ("file", source);
        o->setProperty ("path", resolved ? file.getFullPathName() : juce::String());
        o->setProperty ("missing", ! exists);
        o->setProperty ("pitch", (int) sound[te::IDs::keyNote]);
        o->setProperty ("minNote", lo);
        o->setProperty ("maxNote", hi);
        o->setProperty ("gainDb", gainDb);
        o->setProperty ("userGainDb", silenced ? (float) sound[ids::moshPadGainDb] : gainDb);
        o->setProperty ("silenced", silenced);
        o->setProperty ("pan", (float) sound[te::IDs::pan]);
        o->setProperty ("openEnded", (bool) sound[te::IDs::openEnded]);
        if (const int group = (int) sound.getProperty (ids::moshChokeGroup, 0); group > 0)
            o->setProperty ("chokeGroup", group);
        o->setProperty ("mode", lo == hi ? "drum" : (lo == 0 && hi == 127 ? "melodic" : "range"));
        for (int note = juce::jmax (0, lo); note <= juce::jmin (127, hi); ++note)
            if (narrowestSoundCovering (ranges, note) == i)
            {
                o->setProperty ("addressNote", note);
                break;
            }
        if (exists)
        {
            const auto info = te::AudioFile (eng.engine(), file).getInfo();
            if (info.sampleRate > 0)
            {
                o->setProperty ("durationSec", (double) info.lengthInSamples / info.sampleRate);
                o->setProperty ("sampleRate", info.sampleRate);
                o->setProperty ("channels", info.numChannels);
            }
        }
        list.add (var (o));
    }

    auto* o = new DynamicObject();
    // The sampler the pad commands (set_drum_pad, clear_drum_pad, assign_sample,
    // load_drum_kit, set_drum_lane's gains) address: the first one on the track.
    const bool primary = owner != nullptr && findSampler (*owner) == &sampler;
    o->setProperty ("primary", primary);
    if (primary)
        if (const auto kit = owner->state.getProperty (ids::drumKitId, "").toString(); kit.isNotEmpty())
            o->setProperty ("kit", kit);
    o->setProperty ("sounds", list);
    // The engine's own limits (tracktion_SamplerPlugin.cpp): 32 simultaneous voices, 64
    // sounds per sampler, every gain clamped to [-48, +48] dB.
    auto* limits = new DynamicObject();
    limits->setProperty ("maxVoices", 32);
    limits->setProperty ("maxSounds", 64);
    limits->setProperty ("minGainDb", -48);
    limits->setProperty ("maxGainDb", 48);
    o->setProperty ("limits", var (limits));
    return var (o);
}

// FL drum-lane mute/solo. Stores the muted/soloed GM pitches on the track and applies
// them as sampler pad gains (a muted lane's pad is silenced; soloing lanes silences
// the rest). State persists with the Edit and rides the snapshot for the UI.
juce::var MoshOps::cmdSetDrumLane (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_drum_lane", "no track");
    const int note = juce::jlimit (-1, 127, (int) args.getProperty ("note", -1));
    if (note < 0) return errResult ("set_drum_lane", "note (0-127) required");

    auto pack = [] (const juce::SortedSet<int>& set) {
        juce::StringArray a;
        for (int i = 0; i < set.size(); ++i) a.add (juce::String (set[i]));
        return a.joinIntoString (",");
    };

    beginTxn ("set_drum_lane");
    auto muted = parseLanePitches (track->state.getProperty (ids::drumMute, "").toString());
    auto solo  = parseLanePitches (track->state.getProperty (ids::drumSolo, "").toString());
    if (args.hasProperty ("mute")) { if ((bool) args.getProperty ("mute", false)) muted.add (note); else muted.removeValue (note); }
    if (args.hasProperty ("solo")) { if ((bool) args.getProperty ("solo", false)) solo.add (note);  else solo.removeValue (note); }
    track->state.setProperty (ids::drumMute, pack (muted), &undoManager());
    track->state.setProperty (ids::drumSolo, pack (solo),  &undoManager());
    applyDrumLaneGains (*track);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("note", note);
    data->setProperty ("muted", muted.contains (note));
    data->setProperty ("solo",  solo.contains (note));
    logLine ("set_drum_lane", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3 — pad mute changes the bounce
    return okResult ("set_drum_lane", var (data));
}

// DRM-001 — clear a sampler and load the 8 bundled pads, each mapped to its GM
// pitch at unity (keyNote==minNote==maxNote) and open-ended (a short note rings the
// whole one-shot). Returns the number of pads actually loaded (0 ⇒ kit not found).
int MoshOps::loadDrumKitInto (te::SamplerPlugin& sampler, const juce::String& kitId)
{
    const auto dir = drumKitDir (kitId);

    // Confirm at least one pad is actually loadable BEFORE destroying the current
    // sounds — a missing/broken kit dir must be a no-op, never a silent wipe.
    bool anyPresent = false;
    for (auto& pad : kDefaultKit)
        if (dir.getChildFile (pad.file).existsAsFile()) { anyPresent = true; break; }
    if (! anyPresent)
        return 0;

    for (int i = sampler.getNumSounds(); --i >= 0;)
        sampler.removeSound (i);

    int loaded = 0;
    for (auto& pad : kDefaultKit)
    {
        auto f = dir.getChildFile (pad.file);
        if (! f.existsAsFile()) continue;

        const int idx = sampler.getNumSounds();
        if (sampler.addSound (f.getFullPathName(), pad.name, 0.0, 0.0 /*whole file*/, 0.0f).isNotEmpty())
            continue;
        sampler.setSoundParams (idx, pad.pitch, pad.pitch, pad.pitch);
        sampler.setSoundOpenEnded (idx, true);
        ++loaded;
    }

    // Resolve sample files now (see the pump note in cmdAssignSample). This pump runs in
    // the MIDDLE of the caller's transaction (load_drum_kit then records the kit and the
    // lane gains; create_track / set_track_type then add the track's meter), and Tracktion's
    // Edit::UndoTransactionTimer, if it is due (350 ms after a change it was told of in an
    // earlier pump), would call beginNewTransaction inside it and split the command into
    // two undo steps. Inhibited for the pump; it fires again on its next tick, after the
    // command.
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        {
            const te::Edit::UndoTransactionInhibitor oneUndoStep (eng.edit());
            mm->runDispatchLoopUntil (5);
        }

    return loaded;
}

// DRM-001 — auto-load the sane default instrument so a freshly-created MIDI/drum
// track is audible immediately, WITHOUT clobbering an instrument the user already
// chose. Drum ⇒ sampler + bundled kit; melodic ⇒ 4OSC (the best self-contained
// built-in synth). Discoverable, not magic: the loaded plugin shows up in the
// track's snapshot plugin rack and the header's instrument badge.
void MoshOps::ensureDefaultInstrument (te::AudioTrack& track, bool drum)
{
    if (trackHasInstrument (track))
        return;

    if (drum)
    {
        if (! drumKitAvailable())   // no kit → don't insert an empty, silent sampler
            return;
        if (auto* s = ensureSampler (track))
            loadDrumKitInto (*s);
        return;
    }

    if (auto plugin = eng.edit().getPluginCache().createNewPlugin ("4osc", {}))
    {
        track.pluginList.insertPlugin (plugin, 0, nullptr);   // front of chain (instrument)
        synchronisePlaybackGraph();
    }
}

} // namespace mosh
