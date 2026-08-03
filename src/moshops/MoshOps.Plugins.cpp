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
#include "ScanProgress.h"
#include "state/Ids.h"
#include <cmath>

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
    auto plugin = eng.edit().getPluginCache().createNewPlugin (type, {});
    if (plugin == nullptr) return errResult ("load_builtin", "create failed: " + type);

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();   // append
    track->pluginList.insertPlugin (plugin, index, nullptr);

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
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
    return okResult ("set_track_type", var (data));
}

// DRM-001 — (re)load the bundled default drum kit onto a track's sampler (creating
// the sampler if absent). The command form lets the UI offer "load a kit" and lets
// a re-load reset edited pads.
juce::var MoshOps::cmdLoadDrumKit (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_drum_kit", "no track");

    // Validate the kit is present BEFORE opening a transaction / inserting a sampler,
    // so a missing kit is a clean error with no partial, un-emitted mutation.
    if (! drumKitAvailable())
        return errResult ("load_drum_kit", "no kit samples found (is the kit bundled?)");

    beginTxn ("load_drum_kit");
    auto* sampler = ensureSampler (*track);
    if (sampler == nullptr) return errResult ("load_drum_kit", "could not create sampler");
    const int pads = loadDrumKitInto (*sampler);
    if (pads == 0) return errResult ("load_drum_kit", "no kit samples found (is the kit bundled?)");
    applyDrumLaneGains (*track);  // re-loaded pads land at 0 dB — re-silence muted lanes

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("index", track->pluginList.indexOf (sampler));
    data->setProperty ("pads", pads);
    logLine ("load_drum_kit", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("load_drum_kit", var (data));
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
    juce::File f (path);
    if (path.isEmpty() || ! f.existsAsFile())
        return errResult ("assign_sample", "file not found: " + path);

    const auto name  = args.getProperty ("name", f.getFileNameWithoutExtension()).toString();
    const float gain = (float) (double) args.getProperty ("gainDb", 0.0);

    // NB: the sampler insert is undoable, but the pad SOUND edits below go straight to
    // the plugin (no UndoManager) — sampler sound content is non-undoable here, the same
    // as plugin add/remove. (Undo restores a freshly-inserted sampler's removal, not pads.)
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
    if (err.isNotEmpty()) return errResult ("assign_sample", err);
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
    data->setProperty ("sounds", sampler->getNumSounds());
    logLine ("assign_sample", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("assign_sample", var (data));
}

juce::var MoshOps::cmdLoadPlugin (const juce::var& args)
{
    // A2 — persist any unsaved work BEFORE an op that can crash the process in-place
    // (hosting a third-party VST3/AU is the #1 in-process-teardown crash). The on-disk save
    // becomes the recovery point, making the crash near-lossless without the full replay.
    eng.saveIfDirty();
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_plugin", "no track");

    const auto pluginId = args.getProperty ("pluginId", var()).toString();
    juce::PluginDescription desc;
    if (! pluginHost.findDescription (pluginId, desc))
        return errResult ("load_plugin", "unknown plugin: " + pluginId);

    beginTxn ("load_plugin");
    // MUST use the Edit's PluginCache so the inserted plugin IS the one we hold
    // (PluginManager::createNewPlugin yields a different instance → insertPlugin
    // re-creates from state, indexOf fails, and it asserts — engine's own note).
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, desc);
    if (plugin == nullptr) return errResult ("load_plugin", "create failed");

    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();   // append (−1 does not append)
    track->pluginList.insertPlugin (plugin, index, nullptr);

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("name", plugin->getName());
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
    pluginHost.closeEditor (*plugin);
    beginTxn ("remove_plugin");
    plugin->deleteFromParent();
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
    logLine ("reorder_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouchTrack (args.getProperty ("trackId", var()).toString());   // Phase 3
    return okResult ("reorder_plugin");
}

juce::var MoshOps::cmdSetPluginParam (const juce::var& args)
{
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
    logLine ("set_plugin_param", args, true, {}, true);
    // Scoped — param tweaks are the other rapid-fire case. A param that changes plugin
    // LATENCY leaves the session PDC readout briefly stale (self-corrects on the next
    // structural edit); the arrangement is unaffected. Group-track plugins → full.
    if (track != nullptr) emitTrackPatch (*track);
    else emitSnapshotInvalidated();
    reactiveTouchTrack (trackId);   // Phase 3 — param change → re-bounce
    return okResult ("set_plugin_param");
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
    // Same cache path as cmdLoadMasterPlugin/cmdLoadBuiltin.
    auto plugin = eng.edit().getPluginCache().createNewPlugin (type, {});
    if (plugin == nullptr) return errResult ("load_master_builtin", "create failed: " + type);

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
    data->setProperty ("name", plugin->getName());
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

    // wait:true forces a synchronous VST3 sweep (cheap + safe on the message thread).
    // AU cataloging ALWAYS runs on a background thread, even when wait:true, because
    // JUCE's AudioPluginFormat::createInstanceFromDescription marshals component
    // instantiation back to the message thread — a hanging AU stalls the UI with no
    // per-component timeout.  Only CRASHes are recovered via the dead-mans-pedal;
    // a HANG requires a forced app restart.  Never call the AU sweep synchronously
    // on the message thread.
    const bool wait = (bool) args.getProperty ("wait", false);
    if (! includeAU)
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
    if (wait)
    {
        // wait:true with AU requested: do the VST3 part inline, THEN kick off the
        // AU sweep on a background thread and return "scanning" to the caller.
        // (Keeping the message-thread VST3 result gives the caller a useful count
        // while the AU sweep is in progress.)
        if (includeVST3)
            pluginHost.rescan (clearFirst, includeVST3, false);
    }

    // Async AU rescan — mirror cmdRenderLayer: do the slow work on a background
    // std::thread, marshal the result back to the message thread.
    //
    // FIT-003 — arm the live progress sampler BEFORE spawning the scan thread (message
    // thread only; see timerCallback()) so the UI gets periodic running-count events
    // for the whole sweep, not just this start/done pair.
    scanSampling_  = true;
    scanFormat_    = format;
    scanStartMs_   = Time::getMillisecondCounterHiRes();
    lastScanCount_ = -1;
    emit ("plugin_scan_progress", makeScanProgressPayload (format, /*count=*/0, /*done=*/false, 0));
    // NOTE: clearFirst and the VST3 sweep have already run inline (if wait:true) or
    // will run together below (async path).  Pass clearFirst=false and includeVST3 in
    // the async lambda only if we didn't already do them above.
    const bool asyncClearFirst  = clearFirst && ! wait;
    const bool asyncIncludeVST3 = includeVST3 && ! wait;
    std::thread ([this, asyncClearFirst, asyncIncludeVST3, format]
    {
        // slowVST3=true: this is the deep, module-loading sweep on a BACKGROUND thread
        // (never the message thread) — engage Tracktion's out-of-process scanner + the
        // hang watchdog so a plugin that hangs the child (e.g. a WaveShell on the user's
        // conflicting Waves install) gets killed → blocklisted → skipped, and the catalog
        // is checkpointed mid-sweep so a kill keeps the progress so far.
        const int total = pluginHost.rescan (asyncClearFirst, asyncIncludeVST3, true, /*slowVST3=*/true);
        juce::MessageManager::callAsync ([this, total, format]
        {
            const int elapsed = (int) (Time::getMillisecondCounterHiRes() - scanStartMs_);
            scanSampling_ = false;   // stop the timerCallback() sampler before the terminal emit
            emit ("plugin_scan_progress", makeScanProgressPayload (format, total, /*done=*/true, elapsed));
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

    beginTxn ("write_automation_curve");
    auto& curve = param->getCurve();
    if (apply == "replace")
    {
        // [minT, maxT] the new points span, padded past the last point by a sub-millisecond
        // epsilon: removePointsInRegion is HALF-OPEN [start,end), so without the pad a
        // pre-existing point sitting exactly at the new curve's last timestamp would survive
        // the clear and end up duplicated alongside the freshly-added point at that time.
        const auto rangeStart = tracktion::TimePosition::fromSeconds (parsed.points.front().t);
        const auto rangeEnd   = tracktion::TimePosition::fromSeconds (parsed.points.back().t + 0.0005);
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
juce::File MoshOps::drumKitDir() const
{
    using juce::File;

    const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_DRUMKIT_DIR", {});
    if (env.isNotEmpty())
    {
        File d (env);
        if (d.isDirectory()) return d;
    }

    auto appFile = File::getSpecialLocation (File::currentApplicationFile);
    auto bundled = appFile.getChildFile ("Contents/Resources/drumkits/mosh-kit");
    if (bundled.isDirectory()) return bundled;

    auto exeDir = File::getSpecialLocation (File::currentExecutableFile)
                      .getParentDirectory().getChildFile ("drumkits/mosh-kit");
    if (exeDir.isDirectory()) return exeDir;

    return bundled;   // best-effort; callers guard on existsAsFile()
}

bool MoshOps::drumKitAvailable() const
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

void MoshOps::applyDrumLaneGains (te::AudioTrack& track)
{
    auto* sampler = findSampler (track);
    if (sampler == nullptr) return;

    const auto muted = parseLanePitches (track.state.getProperty (ids::drumMute, "").toString());
    const auto solo  = parseLanePitches (track.state.getProperty (ids::drumSolo, "").toString());
    const bool soloActive = solo.size() > 0;

    for (int i = 0; i < sampler->getNumSounds(); ++i)
    {
        const int   key = sampler->getKeyNote (i);
        const bool  eff = soloActive ? ! solo.contains (key) : muted.contains (key);
        const float cur = sampler->getSoundGainDb (i);
        // Only touch a pad crossing the mute threshold — a non-muted pad keeps its own
        // gain; a formerly-muted pad restores to 0 dB.
        if (eff)                   { if (cur > -99.0f) sampler->setSoundGains (i, -100.0f, sampler->getSoundPan (i)); }
        else if (cur <= -99.0f)                        sampler->setSoundGains (i,    0.0f, sampler->getSoundPan (i));
    }
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
int MoshOps::loadDrumKitInto (te::SamplerPlugin& sampler)
{
    const auto dir = drumKitDir();

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

    // Resolve sample files now (see the pump note in cmdAssignSample).
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (5);

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
        track.pluginList.insertPlugin (plugin, 0, nullptr);   // front of chain (instrument)
}

} // namespace mosh
