// RFC 001 (A-PR2) — MoshOps partial-class split: the track-domain command
// bodies (create/rename/remove, MIX-008 group/ungroup submix tracks, RTG-001/
// RTG-002 per-track input choice + output routing, track volume/pan/mute/solo,
// arm/record-stop/input-monitor, and the take-lane commands), moved VERBATIM
// from MoshOps.cpp. Same class, same member functions — only the translation
// unit changed. The dispatch if-chain and all transaction/log/result/emit
// plumbing stay in MoshOps.cpp (one mutation path, by construction). Cross-TU
// helpers (SetFaderValueAction — also used by the master-fader commands that
// stay behind) live in MoshOpsInternal.h.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "RecordingLanding.h"
#include "state/Ids.h"
#include "multiplayer/LogicalId.h"

namespace mosh
{
using namespace juce;

namespace
{
juce::String captureStateForClip (te::Clip& clip)
{
    if (auto* midi = dynamic_cast<te::MidiClip*> (&clip))
        return "midi\n" + midi->getSequence().state.toXmlString();

    if (auto* wave = dynamic_cast<te::WaveAudioClip*> (&clip))
    {
        juce::StringArray state { "wave", juce::String (wave->getNumTakes (false)),
                                 juce::String (wave->getCurrentTake()) };
        state.addArray (wave->getTakeDescriptions());
        return state.joinIntoString ("\n");
    }

    return {};
}
}

juce::var MoshOps::cmdCreateTrack (const juce::var& args)
{
    // DRM-001 — optional track type. "drum" stamps the type flag and auto-loads the
    // working sampler + bundled kit so drum clips sound immediately ("audio" default).
    const auto type = args.getProperty ("type", "audio").toString();
    if (type != "audio" && type != "drum")
        return errResult ("create_track", "type must be 'audio' or 'drum'");

    beginTxn ("create_track");
    auto* track = createAudioTrack (args.getProperty ("name", var()).toString());
    if (track == nullptr)
    {
        logLine ("create_track", args, false, "insert failed", true);
        return errResult ("create_track", "insert failed");
    }

    if (type == "drum")
    {
        track->state.setProperty (ids::trackType, "drum", &undoManager());
        ensureDefaultInstrument (*track, true);   // sampler + kit
    }

    // METER-001 — auto-meter every freshly created track (must run AFTER any
    // same-command instrument/plugin setup above, since ensureTrackMeter appends
    // at the CURRENT end of the chain — calling it any earlier would leave the
    // tap ahead of the instrument, silently mismeasuring the track's real output).
    // Previously only enable_all_meters (called once at UI init) covered this, so
    // any track created mid-session — here, or via import/paste/add_midi_clip/
    // add_drum_pattern/create_bus/accept_render's Neural Renders lane, all fixed
    // alongside this one — never appeared in the "levels" telemetry. Best-effort:
    // a meter-creation failure must not fail track creation itself.
    ensureTrackMeter (*track);

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("type", type);
    data->setProperty ("isInstrument", trackHasInstrument (*track));
    logLine ("create_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_track", var (data));
}

juce::var MoshOps::cmdRenameTrack (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    te::Track* track = findTrack (id);
    if (track == nullptr) track = findGroupTrack (id);   // MIX-008: groups rename too
    if (track == nullptr) return errResult ("rename_track", "no track: " + id);

    beginTxn ("rename_track");
    track->setName (args.getProperty ("name", var()).toString());
    logLine ("rename_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_track");
}

// TRK-COLOUR (#550) — recolour a track. Colour is pure organisation: it changes nothing
// audible, which is exactly why it earns its place in a beat-first session where a
// producer is looking at a dozen lanes and needs to find the drums instantly.
//
// VALIDATES rather than coerces. An unparseable colour that silently did nothing would be
// the failure mode this whole programme exists to remove, so a bad value is an error the
// caller sees. "" clears back to the type default — a real operation, not a rejection.
juce::var MoshOps::cmdSetTrackColor (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    te::Track* track = findTrack (id);
    if (track == nullptr) track = findGroupTrack (id);   // groups recolour too, like rename
    if (track == nullptr) return errResult ("set_track_color", "no track: " + id);

    auto colour = args.getProperty ("color", var()).toString().trim().toLowerCase();
    if (colour.isNotEmpty())
    {
        const bool wellFormed = colour.length() == 7
                             && colour[0] == '#'
                             && colour.substring (1).containsOnly ("0123456789abcdef");
        if (! wellFormed)
            return errResult ("set_track_color",
                              "color must be \"#rrggbb\" or \"\" to clear, got: " + colour);
    }

    beginTxn ("set_track_color");
    if (colour.isEmpty()) track->state.removeProperty (ids::trackColour, &undoManager());
    else                  track->state.setProperty (ids::trackColour, colour, &undoManager());
    logLine ("set_track_color", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_color");
}

// TRK-REORDER (#550) — move a track to a new position in the arrangement.
//
// `toIndex` is a position in the SAME list the snapshot numbers: te::getAudioTracks minus
// hidden tracks (MoshOps.cpp's trackToVar loop). Using any other ordering would make the
// index the UI can see mean something different from the index the command takes, which is
// the sort of near-miss that reads as a bug the first time a producer drags row 3 to row 1.
//
// REFUSES to move a track that lives inside a folder/group. Tracktion's moveTrack takes a
// TrackInsertPoint that also carries the PARENT, so a naive top-level move would silently
// pull a track out of its submix — changing routing, which is audible, in a command whose
// whole promise is that it only changes order. An honest refusal beats a surprise.
juce::var MoshOps::cmdMoveTrack (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (id);
    if (track == nullptr) return errResult ("move_track", "no track: " + id);

    if (! args.hasProperty ("toIndex")) return errResult ("move_track", "missing 'toIndex'");

    // The visible ordering — identical filter to the snapshot's.
    juce::Array<te::AudioTrack*> visible;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr && ! (bool) t->state.getProperty (ids::moshHidden, false))
            visible.add (t);

    const int from = visible.indexOf (track);
    if (from < 0) return errResult ("move_track", "track is not an orderable arrangement track: " + id);
    if (track->getParentFolderTrack() != nullptr)
        return errResult ("move_track", "track is inside a group; ungroup it before reordering: " + id);

    const int n  = visible.size();
    const int to = juce::jlimit (0, n - 1, (int) args.getProperty ("toIndex", 0));
    if (to == from)
    {
        // A no-op is SUCCESS, not an error: a drag that lands where it started is a
        // perfectly ordinary gesture, and failing it would make the UI show an error for
        // doing nothing. No transaction is opened, so it also cannot pollute undo.
        return okResult ("move_track");
    }

    beginTxn ("move_track");
    // Moving DOWN lands after the track currently occupying the target slot; moving UP
    // lands before it. Expressed with Tracktion's own insert-point idiom rather than
    // arithmetic on indices, so the two directions cannot drift apart by one.
    te::TrackInsertPoint point (*visible[to], /*insertBefore=*/ to < from);
    eng.edit().moveTrack (track, point);
    logLine ("move_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_track");
}

juce::var MoshOps::cmdRemoveTrack (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* track = findTrack (id);
    if (track == nullptr) return errResult ("remove_track", "no track: " + id);

    beginTxn ("remove_track");
    eng.edit().deleteTrack (track);
    logLine ("remove_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_track");
}

// ─────────────────────────────────────────────────────────────────────────────
// MIX-008 — group (submix) tracks
//
// A te::FolderTrack created with asSubmix=true GENUINELY sums its children: the
// graph builder routes every child through a SummingNode wrapped by the folder's
// own plugin chain (createNodeForSubmixTrack; proven by the engine's nested-submix
// test). insertNewFolderTrack(asSubmix=true) adds the default VolumeAndPan +
// LevelMeter plugins, which is exactly what keeps isSubmixFolder() true — so the
// group has a real fader and the summing is engine-owned, not a Mosh claim.
// ─────────────────────────────────────────────────────────────────────────────
te::FolderTrack* MoshOps::findGroupTrack (const juce::String& id)
{
    const auto itemId = te::EditItemID::fromString (id);
    for (auto* t : te::getAllTracks (eng.edit()))
        if (auto* ft = dynamic_cast<te::FolderTrack*> (t))
            if (ft->itemID == itemId)
                return ft;
    return nullptr;
}

juce::var MoshOps::cmdCreateGroupTrack (const juce::var& args)
{
    auto& edit = eng.edit();

    // Resolve the member tracks FIRST (cheap precondition, zero side effects on
    // a malformed request). Unknown ids are skipped + reported, not fatal — an
    // empty trackIds (or none) creates an empty group, which is valid.
    juce::Array<te::AudioTrack*> members;
    int unknown = 0;
    const auto idsVar = args.getProperty ("trackIds", var());   // bind before getArray
    if (auto* ids = idsVar.getArray())
        for (auto& idv : *ids)
        {
            if (auto* t = findTrack (idv.toString()))
            {
                if (! members.contains (t))
                    members.add (t);
            }
            else
                ++unknown;
        }

    beginTxn ("create_group_track");

    auto folder = edit.insertNewFolderTrack (te::TrackInsertPoint::getEndOfTracks (edit),
                                             nullptr, /*asSubmix*/ true);
    if (folder == nullptr)
        return errResult ("create_group_track", "insertNewFolderTrack failed");

    logicalid::ensureTrack (folder->state);   // MP-001 — stable cross-peer id for the submix

    const auto name = args.getProperty ("name", var()).toString();
    folder->setName (name.isNotEmpty() ? name : juce::String ("Group"));

    // Move each member under the folder, preserving their relative order: the
    // first child goes to the start of the folder, each next one after the last.
    te::Track* preceding = nullptr;
    for (auto* m : members)
    {
        edit.moveTrack (m, te::TrackInsertPoint (folder.get(), preceding));
        preceding = m;
    }

    // Deliberately NO message-loop pump here: EditItemID assignment is synchronous
    // (edit.createNewItemID() runs inline), and a mid-command pump re-enters queued
    // async engine work — the AUD-001 use-after-free class (see patches/0005).

    auto* data = new DynamicObject();
    data->setProperty ("groupId", folder->itemID.toString());
    data->setProperty ("moved", members.size());
    if (unknown > 0) data->setProperty ("unknownTrackIds", unknown);
    logLine ("create_group_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_group_track", var (data));
}

juce::var MoshOps::cmdUngroupTrack (const juce::var& args)
{
    auto& edit = eng.edit();
    const auto id = args.getProperty ("trackId", var()).toString();
    auto* folder = findGroupTrack (id);
    if (folder == nullptr) return errResult ("ungroup_track", "no group track: " + id);

    // Collect the folder's direct children before mutating.
    juce::Array<te::Track*> children;
    for (auto* t : te::getAllTracks (edit))
        if (t != nullptr && t->getParentTrack() == folder)
            children.add (t);

    beginTxn ("ungroup_track");

    // Hoist each child to the top level right after the folder (order preserved),
    // then delete the now-empty folder. One transaction = one undo step.
    te::Track* preceding = folder;
    for (auto* c : children)
    {
        edit.moveTrack (c, te::TrackInsertPoint (nullptr, preceding));
        preceding = c;
    }
    edit.deleteTrack (folder);

    // Deliberately NO message-loop pump here: EditItemID assignment is synchronous
    // (edit.createNewItemID() runs inline), and a mid-command pump re-enters queued
    // async engine work — the AUD-001 use-after-free class (see patches/0005).

    auto* data = new DynamicObject();
    data->setProperty ("hoisted", children.size());
    logLine ("ungroup_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("ungroup_track", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// RTG-001 / RTG-002 — per-track input choice + output routing
//
// Both ride engine machinery that already exists: the DeviceManager builds one
// WaveInputDevice per stereo pair / mono channel (so "input 3-4" is a device),
// and every AudioTrack owns a te::TrackOutput that can route to any hardware
// out OR into another track (the graph sums feeders via a SummingNode — an
// implicit bus, with cycle detection). Mosh adds only the choice surface.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdListWaveInputs (const juce::var&)
{
    // Read-only audio-input enumeration (RTG-001) — modelled on cmdListMidiInputs:
    // no transaction, no log line, no event. Headless the wave-input list is empty
    // (devices exist only once CoreAudio is up) -> a well-formed empty array.
    auto& dm = eng.engine().getDeviceManager();

    Array<var> inputs;
    for (int i = 0; i < dm.getNumWaveInDevices(); ++i)
        if (auto* wi = dm.getWaveInDevice (i))
        {
            auto* o = new DynamicObject();
            o->setProperty ("deviceID", wi->getDeviceID());
            o->setProperty ("name", wi->getName());
            o->setProperty ("enabled", wi->isEnabled());
            o->setProperty ("isStereoPair", wi->isStereoPair());
            inputs.add (var (o));
        }

    auto* data = new DynamicObject();
    data->setProperty ("inputs", inputs);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_wave_inputs", var (data));
}

juce::var MoshOps::cmdSetTrackInput (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_input", "no track");
    const auto deviceID = args.getProperty ("deviceID", var()).toString();
    if (deviceID.isEmpty()) return errResult ("set_track_input", "missing 'deviceID'");

    // A monitoring/routing PREFERENCE (like arm_track / set_input_monitor): the
    // engine binds input destinations without the undo manager, so no transaction.
    // The CHOICE is stored on the track's own state tree (saves/reloads with the
    // edit) and arm_track prefers it over first-match.
    track->state.setProperty (ids::moshInputDevice, deviceID, nullptr);

    // Live application: retarget the chosen instance to this track. Headless
    // (no playback context) there are no instances -> graceful applied:false.
    //
    // The requested device's FAMILY is resolved first, and only instances of that family
    // are considered. A track can legitimately carry a wave input AND a MIDI input at
    // once, so "clear the old assignment" has to mean the old assignment of the SAME
    // family — choosing a controller must not unassign the audio input, or vice versa.
    // This loop previously skipped every MIDI instance outright, with two consequences:
    // a MIDI deviceID could never become `chosen`, so the choice was merely stored and
    // did not take effect until the next arm_track; and switching from controller A to
    // controller B never released A, leaving both driving the track.
    auto& dm = eng.engine().getDeviceManager();
    const bool wantMidi = dm.findMidiInputDeviceForID (deviceID) != nullptr;

    bool applied = false;
    bool wasArmed = false;
    te::InputDeviceInstance* chosen = nullptr;
    for (auto* inst : eng.edit().getAllInputDevices())
    {
        if (inst == nullptr || inst->getInputDevice().isMidi() != wantMidi) continue;
        if (te::isOnTargetTrack (*inst, *track, 0))
        {
            wasArmed = inst->isRecordingEnabled (track->itemID);
            if (inst->getInputDevice().getDeviceID() != deviceID)
            {
                // Clear the old assignment; ignore the Result (a missing target
                // is already the state we want).
                [[maybe_unused]] auto r = inst->removeTarget (track->itemID, nullptr);
            }
        }
        if (inst->getInputDevice().getDeviceID() == deviceID)
            chosen = inst;
    }
    if (chosen != nullptr)
    {
        // setTarget returns tl::expected — check, never blind-deref.
        if (auto r = chosen->setTarget (track->itemID, true, nullptr, 0))
        {
            if (wasArmed)
                chosen->setRecordingEnabled (track->itemID, true);   // keep the arm across the swap
            applied = true;
        }
        else
        {
            logLine ("set_track_input", args, false, r.error(), false);
            return errResult ("set_track_input", r.error());
        }
    }

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("deviceID", deviceID);
    data->setProperty ("kind", wantMidi ? "midi" : "wave");
    data->setProperty ("applied", applied);
    if (! applied) data->setProperty ("reason", "no live input instance (choice stored)");
    logLine ("set_track_input", args, true, {}, false);   // preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_track_input", var (data));
}

juce::var MoshOps::cmdListTrackOutputs (const juce::var&)
{
    // Read-only output enumeration (RTG-002): the hardware wave outs + every audio
    // track as a candidate route-to-track destination (an implicit submix). No
    // transaction, no log line. Headless: empty device list, tracks still listed.
    auto& dm = eng.engine().getDeviceManager();

    Array<var> outputs;
    for (int i = 0; i < dm.getNumWaveOutDevices(); ++i)
        if (auto* wo = dm.getWaveOutDevice (i))
        {
            auto* o = new DynamicObject();
            o->setProperty ("deviceID", wo->getDeviceID());
            o->setProperty ("name", wo->getName());
            o->setProperty ("enabled", wo->isEnabled());
            outputs.add (var (o));
        }

    Array<var> trackDests;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
        {
            auto* o = new DynamicObject();
            o->setProperty ("id", t->itemID.toString());
            o->setProperty ("name", t->getName());
            trackDests.add (var (o));
        }

    auto* data = new DynamicObject();
    data->setProperty ("outputs", outputs);
    data->setProperty ("tracks", trackDests);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_track_outputs", var (data));
}

juce::var MoshOps::cmdSetTrackOutput (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_output", "no track");
    auto& out = track->getOutput();

    // Three destination forms: { destTrackId } routes into another track (implicit
    // bus), { deviceID } routes to a hardware out, { output: "default" } resets.
    // TrackOutput state is CachedValue-bound to the Edit's UndoManager -> undoable.
    if (args.hasProperty ("destTrackId"))
    {
        const auto destId = args.getProperty ("destTrackId", var()).toString();
        auto* dest = findTrack (destId);
        if (dest == nullptr) return errResult ("set_track_output", "no destination track: " + destId);
        if (dest == track)   return errResult ("set_track_output", "a track cannot output to itself");
        // Cycle guard BEFORE applying: if the destination already feeds into this
        // track (directly or transitively), routing track->dest would loop.
        if (dest->getOutput().feedsInto (track))
            return errResult ("set_track_output", "routing would create a cycle");

        beginTxn ("set_track_output");
        out.setOutputToTrack (dest);
        logLine ("set_track_output", args, true, {}, true);
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("trackId", track->itemID.toString());
        data->setProperty ("destTrackId", dest->itemID.toString());
        return okResult ("set_track_output", var (data));
    }

    if (args.hasProperty ("deviceID"))
    {
        const auto deviceID = args.getProperty ("deviceID", var()).toString();
        if (deviceID.isEmpty()) return errResult ("set_track_output", "empty 'deviceID'");
        // With a live device manager, validate the id; headless the list is empty,
        // so accept it as persisted intent (the graph resolves it when audio is up;
        // a missing device falls back to silence + the UI shows the stored name).
        if (eng.hasAudio())
        {
            auto& dm = eng.engine().getDeviceManager();
            bool known = false;
            for (int i = 0; i < dm.getNumWaveOutDevices(); ++i)
                if (auto* wo = dm.getWaveOutDevice (i))
                    if (wo->getDeviceID() == deviceID) { known = true; break; }
            if (! known) return errResult ("set_track_output", "unknown output device: " + deviceID);
        }
        beginTxn ("set_track_output");
        out.setOutputToDeviceID (deviceID);
        logLine ("set_track_output", args, true, {}, true);
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("trackId", track->itemID.toString());
        data->setProperty ("deviceID", deviceID);
        return okResult ("set_track_output", var (data));
    }

    if (args.getProperty ("output", var()).toString() == "default")
    {
        beginTxn ("set_track_output");
        out.setOutputToDefaultDevice (false /*isMidi*/);
        logLine ("set_track_output", args, true, {}, true);
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("trackId", track->itemID.toString());
        data->setProperty ("output", "default");
        return okResult ("set_track_output", var (data));
    }

    return errResult ("set_track_output", "expected 'destTrackId', 'deviceID', or output:'default'");
}

juce::var MoshOps::cmdSetTrackVolume (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    te::VolumeAndPanPlugin* vp = nullptr;
    te::AudioTrack* audioTrack = nullptr;
    if (auto* track = findTrack (id))
        { audioTrack = track; vp = ensureVolumePlugin (*track); }
    else if (auto* group = findGroupTrack (id))   // MIX-008: group fader (submix VolumeAndPan)
        vp = group->getVolumePlugin();
    if (vp == nullptr) return errResult ("set_track_volume", "no track");

    beginTxn ("set_track_volume");
    // G14 — route the fader change through the UndoManager (setVolumeDb alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*vp, false, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_track_volume", args, true, {}, true);
    if (audioTrack != nullptr) emitTrackPatch (*audioTrack);   // scoped (group fader → full below)
    else emitSnapshotInvalidated();
    return okResult ("set_track_volume");
}

juce::var MoshOps::cmdSetTrackPan (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_pan", "no track");
    auto* vp = ensureVolumePlugin (*track);
    if (vp == nullptr) return errResult ("set_track_pan", "no volume plugin");

    beginTxn ("set_track_pan");
    // G14 — route the pan change through the UndoManager (setPan alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*vp, true,
        juce::jlimit (-1.0f, 1.0f, (float) (double) args.getProperty ("pan", 0.0))));
    logLine ("set_track_pan", args, true, {}, true);
    emitTrackPatch (*track);   // scoped — pan is purely track-local
    return okResult ("set_track_pan");
}

juce::var MoshOps::cmdSetTrackMute (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_mute", "no track");
    beginTxn ("set_track_mute");
    // G14 class (found by the P6 undo matrix): te::Track::setMute writes its CachedValue
    // with a NULL UndoManager, leaving this transaction EMPTY — undo then popped the
    // PREVIOUS command's transaction (destroying the user's prior edit) while the mute
    // stuck. A plain ValueTree write through the edit's UndoManager records correctly,
    // and mute is a plain CachedValue<bool> (not an AutomatableParameter), so undo's
    // CachedValue refresh is the complete story — no SetFaderValueAction-style replay
    // needed here.
    track->state.setProperty (te::IDs::mute, (bool) args.getProperty ("mute", false), &undoManager());
    logLine ("set_track_mute", args, true, {}, true);
    emitTrackPatch (*track);   // scoped — mute is purely track-local (unlike solo, which dims others)
    return okResult ("set_track_mute");
}

juce::var MoshOps::cmdSetTrackSolo (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_track_solo", "no track");
    beginTxn ("set_track_solo");
    // Same G14-class fix as set_track_mute above (P6 undo matrix find).
    track->state.setProperty (te::IDs::solo, (bool) args.getProperty ("solo", false), &undoManager());
    logLine ("set_track_solo", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_track_solo");
}

juce::var MoshOps::cmdArmTrack (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("arm_track", "no track");
    const bool armed = (bool) args.getProperty ("armed", false);

    // Record-arm is a monitoring preference, NOT an undoable session edit: the engine
    // binds the destination's `armed` flag with a nullptr UndoManager
    // (tracktion_InputDevice.h: recordEnabled.referTo (state, IDs::armed, nullptr, false)),
    // so a transaction here would be empty. Treat it like set_metronome / set_transport.

    // A fresh Edit has no playback context yet, so getAllInputDevices() would be empty
    // until the user pressed Play once. Record-arm is itself a live-audio action: make
    // the context available before looking up device instances rather than exposing a
    // hidden Play-first precondition. Headless remains a graceful applied:false no-op.
    if (armed && eng.hasAudio())
        eng.ensurePlaybackContext();

    // getAllInputDevices() is still empty headless / without an open audio device, so
    // there are no instances to operate on. Degrade gracefully: ok result,
    // applied:false, never an error (mirrors cmdSetTransport skipping play/record when
    // !hasAudio()).
    bool applied = false;
    auto inputs = eng.edit().getAllInputDevices();

    // Find an instance already targeting this track at slot 0.
    te::InputDeviceInstance* target = nullptr;
    for (auto* inst : inputs)
        if (inst != nullptr && te::isOnTargetTrack (*inst, *track, 0))
        {
            target = inst;
            break;
        }

    // Arming a virgin track: assign an available input first, then enable
    // (RecordingDemo does setTarget + setRecordingEnabled together). Disarming a track
    // with no instance is a harmless no-op.
    //
    // CTL-001 — route MIDI to instrument tracks: an instrument track (one hosting a
    // synth) should receive live MIDI from a controller, not a wave input, so a played
    // note turns into audio. We therefore prefer a MIDI input instance when the track
    // has an instrument, and a wave input otherwise. setTarget + setRecordingEnabled
    // are identical calls for either device family. There is NO Tracktion "all MIDI
    // inputs auto-route to the armed track" behaviour — each input must be explicitly
    // targeted; we pick the FIRST matching input (multi-controller disambiguation is a
    // later enhancement). Wave-only tracks are unchanged from the recording wave.
    if (target == nullptr && armed)
    {
        const bool wantMidi = trackHasInstrument (*track);

        // RTG-001 — honor an explicitly-chosen input first (set_track_input stores
        // the WaveInputDevice deviceID on the track's state). Falls through to the
        // family-preference passes below when no choice is stored / not present.
        const auto chosenID = track->state.getProperty (ids::moshInputDevice, var()).toString();
        if (chosenID.isNotEmpty())
            for (auto* inst : inputs)
                if (inst != nullptr && inst->getInputDevice().getDeviceID() == chosenID)
                {
                    if (auto r = inst->setTarget (track->itemID, true, nullptr, 0))
                        target = inst;
                    // A failed setTarget on the chosen device falls through to the
                    // normal auto-assign rather than failing the arm outright.
                    break;
                }

        auto matchesPreferred = [wantMidi] (te::InputDeviceInstance* inst)
        {
            const auto type = inst->getInputDevice().getDeviceType();
            return wantMidi ? (type == te::InputDevice::physicalMidiDevice
                                   || type == te::InputDevice::virtualMidiDevice)
                            : (type == te::InputDevice::waveDevice);
        };

        // First pass: the preferred device family (MIDI for instrument tracks, wave
        // otherwise). Fallback pass: the other family, so arming still does something
        // sensible if e.g. only a wave input is present (or only MIDI, no synth yet).
        for (int pass = 0; pass < 2 && target == nullptr; ++pass)
            for (auto* inst : inputs)
            {
                if (inst == nullptr) continue;
                const bool preferred = matchesPreferred (inst);
                if (pass == 0 ? ! preferred : preferred)
                    continue;     // pass 0: preferred only; pass 1: the other family only
                if (! (inst->getInputDevice().getDeviceType() == te::InputDevice::waveDevice
                       || inst->getInputDevice().isMidi()))
                    continue;     // ignore track-wave/track-midi internal device types

                // setTarget returns tl::expected — check the error, never blind-deref.
                // Pass nullptr (no UndoManager): arming is a non-undoable preference, so
                // the target assignment stays off the Edit undo stack too (it still
                // persists in the input-device ValueTree and saves with the Edit).
                if (auto r = inst->setTarget (track->itemID, true, nullptr, 0))
                {
                    target = inst;
                    break;
                }
                else
                {
                    // Genuine assignment failure (a live device rejected the target):
                    // log exactly once and surface as an error — never a misleading ok.
                    logLine ("arm_track", args, false, r.error(), false);
                    return errResult ("arm_track", r.error());
                }
            }
    }

    if (target != nullptr)
    {
        target->setRecordingEnabled (track->itemID, armed);
        applied = true;
    }

    logLine ("arm_track", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("armed", armed);
    data->setProperty ("applied", applied);
    if (! applied)
        data->setProperty ("reason", "no input device");
    return okResult ("arm_track", var (data));
}

juce::var MoshOps::cmdStopRecording (const juce::var& args)
{
    // Wave B — record-to-take landing (TRA-002 wave, MID-001 MIDI, ARE-003 latency).
    //
    // Stopping a recording is a RECORDING-LIFECYCLE action, NOT an undoable session
    // edit: Tracktion lands the take's clip(s) on the armed track(s) via its own async
    // clip-add path (the recording context's stopRecording produces a Clip::Array), and
    // the user undoes the *take* via remove_clip if they reject it. So this is a
    // non-undoable transport op (no beginNewTransaction; logged undoable:false) — the
    // same posture as set_transport / arm_track.
    //
    // discardRecordings=false KEEPS the takes (the canonical RecordingDemo stop overload
    // transport.stop(discardRecordings, clearDevices)); discardRecordings=true throws the
    // captured audio/MIDI away and lands nothing. clearDevices stays false so the
    // playback graph survives for the next take.
    const bool discard = (bool) args.getProperty ("discardRecordings", false);

    auto& transport = eng.edit().getTransport();

    // Graceful degradation (mirrors cmdArmTrack / the cmdSetTransport record guard):
    // headless / no audio device → no playback context → no armed inputs → nothing can
    // have been captured. NEVER an error: ok result, applied:false, clips:[], reason.
    auto reportNoOp = [&] (const char* reason) -> juce::var
    {
        logLine ("stop_recording", args, true, {}, false);   // recording op is NOT undoable
        emit ("transport", transportToVar());
        emitSnapshotInvalidated();
        auto* data = new DynamicObject();
        data->setProperty ("applied", false);
        data->setProperty ("discarded", discard);
        data->setProperty ("clips", Array<var>());
        data->setProperty ("reason", reason);
        return okResult ("stop_recording", var (data));
    };

    if (! eng.hasAudio())
        return reportNoOp ("no audio device");

    auto* context = transport.getCurrentPlaybackContext();
    if (context == nullptr)
        return reportNoOp ("no playback context");

    if (! transport.isRecording())
        return reportNoOp ("not recording");

    // Bind the input array to a local before iterating (no dangling temporary).
    juce::Array<te::AudioTrack*> armedTracks;
    {
        auto inputs = eng.edit().getAllInputDevices();
        auto allTracks = te::getAudioTracks (eng.edit());
        for (auto* inst : inputs)
            if (inst != nullptr)
                for (auto* t : allTracks)
                    if (t != nullptr
                        && te::isOnTargetTrack (*inst, *t, 0)
                        && inst->isRecordingEnabled (t->itemID)
                        && ! armedTracks.contains (t))
                        armedTracks.add (t);
    }

    juce::HashMap<juce::String, int> beforeIds;
    juce::HashMap<juce::String, juce::String> beforeCaptureStates;
    for (auto* t : armedTracks)
        for (auto* c : t->getClips())
            if (c != nullptr)
            {
                const auto id = c->itemID.toString();
                beforeIds.set (id, 1);
                beforeCaptureStates.set (id, captureStateForClip (*c));
            }

    // Stop, KEEPING takes (unless asked to discard). clearDevices=false preserves the
    // graph. Take landing is SYNCHRONOUS inside transport.stop() (performStop() ->
    // playbackContext->stopRecording() -> applyRecording()), so the take clips exist in
    // track.getClips() right after this returns.
    transport.stop (discard, false);

    // ARE-003: the landed clip's start is auto-adjusted by record latency inside
    // Tracktion; we just read it back via clipToVar (no app-side alignment).
    Array<var> landed;
    int landedTrackCount = 0;
    if (! discard)
        for (auto* t : armedTracks)
        {
            bool trackLanded = false;
            for (auto* c : t->getClips())
                if (c != nullptr)
                {
                    const auto id = c->itemID.toString();
                    if (recording::didLandClip (beforeIds.contains (id),
                                                beforeCaptureStates[id],
                                                captureStateForClip (*c)))
                    {
                        landed.add (clipToVar (*c));
                        trackLanded = true;
                    }
                }
            if (trackLanded)
                ++landedTrackCount;
        }

    const bool applied = recording::captureApplied (armedTracks.size(),
                                                    landedTrackCount, discard);

    logLine ("stop_recording", args, true, {}, false);   // recording op is NOT undoable
    emit ("transport", transportToVar());
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("applied", applied);
    data->setProperty ("discarded", discard);
    data->setProperty ("clips", landed);
    if (! applied)
        data->setProperty ("reason", landed.isEmpty()
            ? "no take captured (no live input)"
            : "one or more armed tracks did not capture a take");
    return okResult ("stop_recording", var (data));
}

juce::var MoshOps::cmdSetInputMonitor (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_input_monitor", "no track");

    // Accept either { mode: "off"|"automatic"|"on" } or legacy { monitor: bool }.
    juce::String modeStr;
    if (args.hasProperty ("mode"))
        modeStr = args.getProperty ("mode", var()).toString();
    else if (args.hasProperty ("monitor"))
        modeStr = ((bool) args.getProperty ("monitor", false)) ? "on" : "off";
    else
        modeStr = "automatic";

    te::InputDevice::MonitorMode mode;
    if (modeStr == "off")            mode = te::InputDevice::MonitorMode::off;
    else if (modeStr == "automatic") mode = te::InputDevice::MonitorMode::automatic;
    else if (modeStr == "on")        mode = te::InputDevice::MonitorMode::on;
    else return errResult ("set_input_monitor", "bad mode: " + modeStr);

    // Input monitoring is a device preference, NOT an undoable Edit change: setMonitorMode
    // writes the field + saveProps() (global engine props, not the Edit value tree), so a
    // transaction would be empty. Treat it like set_metronome.

    // Monitor mode is a property of the shared InputDevice (the *device*, not the
    // instance) — two tracks fed by the same physical input share one monitor mode.
    // Headless getAllInputDevices() is empty → no-op, applied:false (never an error).
    bool applied = false;
    for (auto* inst : eng.edit().getAllInputDevices())
        if (inst != nullptr && te::isOnTargetTrack (*inst, *track, 0))
        {
            inst->getInputDevice().setMonitorMode (mode);
            applied = true;
            break;
        }

    logLine ("set_input_monitor", args, true, {}, false);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("mode", modeStr);
    data->setProperty ("applied", applied);
    if (! applied)
        data->setProperty ("reason", "no input device");
    return okResult ("set_input_monitor", var (data));
}

// ── take lanes (audio) — expose Tracktion's native take tree ──────────────────
juce::var MoshOps::cmdListTakes (const juce::var& args)
{
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (w == nullptr) return errResult ("list_takes", "no wave clip");
    auto descs = w->getTakeDescriptions();
    juce::Array<juce::var> takes;
    for (int i = 0; i < descs.size(); ++i)
    {
        auto* t = new juce::DynamicObject();
        t->setProperty ("index", i);
        t->setProperty ("description", descs[i]);
        t->setProperty ("isCurrent", i == w->getCurrentTake());
        takes.add (juce::var (t));
    }
    auto* o = new juce::DynamicObject();
    o->setProperty ("clipId", w->itemID.toString());
    o->setProperty ("numTakes", w->getNumTakes (false));
    o->setProperty ("currentTakeIndex", w->getCurrentTake());
    o->setProperty ("takes", takes);
    return okResult ("list_takes", juce::var (o));   // read-only: no transaction / log
}

juce::var MoshOps::cmdSetCurrentTake (const juce::var& args)
{
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (w == nullptr) return errResult ("set_current_take", "no wave clip");
    const int n = w->getNumTakes (false);
    if (n <= 0) return errResult ("set_current_take", "no takes");
    const int idx = juce::jlimit (0, n - 1, (int) args.getProperty ("takeIndex", 0));
    beginTxn ("set_current_take");
    w->setCurrentTake (idx);
    logLine ("set_current_take", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_current_take");
}

juce::var MoshOps::cmdKeepTake (const juce::var& args)
{
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (w == nullptr) return errResult ("keep_take", "no wave clip");
    if (! w->hasAnyTakes()) return errResult ("keep_take", "no takes to keep");
    beginTxn ("keep_take");
    w->deleteAllUnusedTakes (false);   // keep the current take; preserve source files → undo-safe
    logLine ("keep_take", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("keep_take");
}

juce::var MoshOps::cmdMarkTake (const juce::var& args)
{
    logLine ("mark_take", args, true, {}, false);
    emit ("controller_event", args);
    return okResult ("mark_take");
}

} // namespace mosh
