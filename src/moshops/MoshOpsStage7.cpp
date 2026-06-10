// Stage 7 — the MoshIR engine gaps (phase0 spec §3.3). New native commands the
// IR taxonomy needs that v0 stages 0–6 never built: tempo/time-sig/key, MIDI
// note editing, the builtin sampler + sounds, track routing, aux sends/returns,
// compressor sidechain, automation curves, clip pitch/stretch/slice, and
// arrangement sections. All follow the house idiom: validate → transaction →
// mutate via engine APIs → logLine → emit → envelope.
//
// API signatures verified against the pinned tracktion_engine 2877b621
// (docs/ENGINE_API_NOTES.md "Stage 7" section).

#include "MoshOps.h"
#include "state/Ids.h"
#include "plugins/neural/NeuralInsertPlugin.h"

namespace mosh
{
using namespace juce;

namespace
{
    const Identifier MOSH_SESSION ("MOSH_SESSION");
    const Identifier MOSH_ARRANGE ("MOSH_ARRANGE");
    const Identifier SECTION ("SECTION");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tempo / time-sig / key
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdSetTempo (const juce::var& args)
{
    const double bpm = (double) args.getProperty ("bpm", 0.0);
    if (bpm < 20.0 || bpm > 400.0)
        return errResult ("set_tempo", "bpm out of range [20, 400]: " + String (bpm));

    undoManager().beginNewTransaction ("set_tempo");
    if (args.hasProperty ("atBar"))
    {
        // Tempo map (Stage 28): insert/update a tempo change at a bar line.
        const int atBar = jmax (1, (int) args.getProperty ("atBar", 1));
        auto& ts0 = eng.edit().tempoSequence.getTimeSigAt (tracktion::TimePosition());
        const double beatsPerBar = ts0.numerator.get() * 4.0 / ts0.denominator.get();
        const auto beat = tracktion::BeatPosition::fromBeats ((atBar - 1) * beatsPerBar);
        eng.edit().tempoSequence.insertTempo (beat, bpm, 1.0f);   // public overload uses the edit's UM
    }
    else
    {
        // The session's base tempo: mutate the setting at beat 0.
        eng.edit().tempoSequence.getTempoAt (tracktion::TimePosition()).setBpm (bpm);
    }
    logLine ("set_tempo", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_tempo");
}

// Stage 28: drop a tempo-map point (never the base tempo at beat 0).
juce::var MoshOps::cmdRemoveTempo (const juce::var& args)
{
    const int atBar = (int) args.getProperty ("atBar", -1);
    if (atBar < 2) return errResult ("remove_tempo", "atBar must be >= 2 (the base tempo stays)");
    auto& seq = eng.edit().tempoSequence;
    auto& ts0 = seq.getTimeSigAt (tracktion::TimePosition());
    const double beatsPerBar = ts0.numerator.get() * 4.0 / ts0.denominator.get();
    const double targetBeat = (atBar - 1) * beatsPerBar;

    undoManager().beginNewTransaction ("remove_tempo");
    for (int i = seq.getNumTempos(); --i >= 1;)
        if (auto* t = seq.getTempo (i))
            if (std::abs (t->getStartBeat().inBeats() - targetBeat) < 0.01)
            {
                seq.removeTempo (i, true);
                logLine ("remove_tempo", args, true, {}, true);
                emitSnapshotInvalidated();
                return okResult ("remove_tempo");
            }
    return errResult ("remove_tempo", "no tempo change at bar " + String (atBar));
}

juce::var MoshOps::cmdSetTimeSig (const juce::var& args)
{
    const int num   = (int) args.getProperty ("numerator", 4);
    const int denom = (int) args.getProperty ("denominator", 4);
    if (num < 1 || num > 32 || ! (denom == 1 || denom == 2 || denom == 4 || denom == 8 || denom == 16 || denom == 32))
        return errResult ("set_time_sig", "bad time signature");

    undoManager().beginNewTransaction ("set_time_sig");
    auto& ts = eng.edit().tempoSequence.getTimeSigAt (tracktion::TimePosition());
    ts.numerator = num;
    ts.denominator = denom;
    logLine ("set_time_sig", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_time_sig");
}

juce::var MoshOps::cmdSetKey (const juce::var& args)
{
    const auto root  = args.getProperty ("root", var()).toString();
    const auto scale = args.getProperty ("scale", var()).toString();
    if (root.isEmpty() || scale.isEmpty())
        return errResult ("set_key", "missing root/scale");

    undoManager().beginNewTransaction ("set_key");
    // Key lives in MOSH session state (no engine-native key concept we rely
    // on); feeds the snapshot + the Tier-B tempoKeyContext fingerprint field.
    auto node = eng.edit().state.getOrCreateChildWithName (MOSH_SESSION, &undoManager());
    node.setProperty ("keyRoot", root, &undoManager());
    node.setProperty ("keyScale", scale, &undoManager());
    logLine ("set_key", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_key");
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDI note editing (notes.* — clip-relative beats throughout)
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdAddNotes (const juce::var& args)
{
    auto* mc = findMidiClip (args.getProperty ("clipId", var()).toString());
    if (mc == nullptr) return errResult ("add_notes", "no midi clip");
    auto notes = args.getProperty ("notes", var());
    if (! notes.isArray() || notes.size() == 0)
        return errResult ("add_notes", "missing 'notes'");

    undoManager().beginNewTransaction ("add_notes");
    auto& seq = mc->getSequence();
    int added = 0;
    for (auto& n : *notes.getArray())
    {
        const int pitch = (int) n.getProperty ("pitch", -1);
        const int vel   = jlimit (1, 127, (int) n.getProperty ("vel", 100));
        const double st = (double) n.getProperty ("startBeats", 0.0);
        const double du = (double) n.getProperty ("durBeats", 0.0);
        if (pitch < 0 || pitch > 127 || du <= 0.0) continue;
        seq.addNote (pitch, tracktion::BeatPosition::fromBeats (st),
                     tracktion::BeatDuration::fromBeats (du), vel, 0, &undoManager());
        ++added;
    }

    auto* data = new DynamicObject();
    data->setProperty ("added", added);
    logLine ("add_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_notes", var (data));
}

// Stage 16: the piano roll's edit primitive. Each edit matches one note by
// (pitch, startBeats ±0.01 beats) and rewrites pitch/start/duration/velocity.
// ONE undo transaction for the whole batch — a drag is one undo step.
juce::var MoshOps::cmdUpdateNotes (const juce::var& args)
{
    auto* mc = findMidiClip (args.getProperty ("clipId", var()).toString());
    if (mc == nullptr) return errResult ("update_notes", "no midi clip");
    auto edits = args.getProperty ("edits", var());
    if (! edits.isArray() || edits.size() == 0)
        return errResult ("update_notes", "missing 'edits'");

    undoManager().beginNewTransaction ("update_notes");
    auto& seq = mc->getSequence();
    int updated = 0;
    Array<var> finals;   // resolved post-edit notes — the lift re-adds these
    for (auto& e : *edits.getArray())
    {
        const auto match = e.getProperty ("match", var());
        const auto set   = e.getProperty ("set", var());
        const int    mPitch = (int) match.getProperty ("pitch", -1);
        const double mStart = (double) match.getProperty ("startBeats", -1.0);

        for (auto* n : seq.getNotes())
        {
            if (n == nullptr) continue;
            if (n->getNoteNumber() != mPitch) continue;
            if (std::abs (n->getStartBeat().inBeats() - mStart) > 0.01) continue;

            const double newStart = set.hasProperty ("startBeats")
                                        ? (double) set.getProperty ("startBeats", 0.0)
                                        : n->getStartBeat().inBeats();
            const double newDur   = set.hasProperty ("durBeats")
                                        ? (double) set.getProperty ("durBeats", 0.25)
                                        : n->getLengthBeats().inBeats();
            n->setStartAndLength (tracktion::BeatPosition::fromBeats (juce::jmax (0.0, newStart)),
                                  tracktion::BeatDuration::fromBeats (juce::jmax (0.01, newDur)),
                                  &undoManager());
            if (set.hasProperty ("pitch"))
                n->setNoteNumber (juce::jlimit (0, 127, (int) set.getProperty ("pitch", 60)), &undoManager());
            if (set.hasProperty ("vel"))
                n->setVelocity (juce::jlimit (1, 127, (int) set.getProperty ("vel", 100)), &undoManager());

            auto* f = new DynamicObject();
            f->setProperty ("matchPitch", mPitch);
            f->setProperty ("matchStartBeats", mStart);
            f->setProperty ("pitch", n->getNoteNumber());
            f->setProperty ("startBeats", n->getStartBeat().inBeats());
            f->setProperty ("durBeats", n->getLengthBeats().inBeats());
            f->setProperty ("vel", n->getVelocity());
            finals.add (var (f));
            ++updated;
            break;      // one note per edit
        }
    }

    auto* data = new DynamicObject();
    data->setProperty ("updated", updated);
    data->setProperty ("notes", finals);
    logLine ("update_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("update_notes", var (data));
}

juce::var MoshOps::cmdRemoveNotes (const juce::var& args)
{
    auto* mc = findMidiClip (args.getProperty ("clipId", var()).toString());
    if (mc == nullptr) return errResult ("remove_notes", "no midi clip");

    // Optional filters; no filter = remove everything.
    juce::SortedSet<int> pitches;
    if (auto pv = args.getProperty ("pitches", var()); pv.isArray())
        for (auto& p : *pv.getArray()) pitches.add ((int) p);
    const bool hasRange = args.hasProperty ("rangeStartBeats");
    const double r0 = (double) args.getProperty ("rangeStartBeats", 0.0);
    const double r1 = r0 + (double) args.getProperty ("rangeLengthBeats", 0.0);

    undoManager().beginNewTransaction ("remove_notes");
    auto& seq = mc->getSequence();
    juce::Array<te::MidiNote*> doomed;
    for (auto* n : seq.getNotes())
    {
        if (! pitches.isEmpty() && ! pitches.contains (n->getNoteNumber())) continue;
        if (hasRange)
        {
            const double st = n->getStartBeat().inBeats();
            if (st < r0 || st >= r1) continue;
        }
        doomed.add (n);
    }
    for (auto* n : doomed)
        seq.removeNote (*n, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("removed", doomed.size());
    logLine ("remove_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_notes", var (data));
}

juce::var MoshOps::cmdTransposeNotes (const juce::var& args)
{
    auto* mc = findMidiClip (args.getProperty ("clipId", var()).toString());
    if (mc == nullptr) return errResult ("transpose_notes", "no midi clip");
    const int semis = (int) args.getProperty ("semitones", 0);

    undoManager().beginNewTransaction ("transpose_notes");
    for (auto* n : mc->getSequence().getNotes())
        n->setNoteNumber (jlimit (0, 127, n->getNoteNumber() + semis), &undoManager());
    logLine ("transpose_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("transpose_notes");
}

juce::var MoshOps::cmdQuantizeNotes (const juce::var& args)
{
    auto* mc = findMidiClip (args.getProperty ("clipId", var()).toString());
    if (mc == nullptr) return errResult ("quantize_notes", "no midi clip");
    const double grid = (double) args.getProperty ("gridBeats", 0.0);
    const double strength = jlimit (0.0, 1.0, (double) args.getProperty ("strength", 1.0));
    if (grid <= 0.0) return errResult ("quantize_notes", "bad gridBeats");

    undoManager().beginNewTransaction ("quantize_notes");
    for (auto* n : mc->getSequence().getNotes())
    {
        const double st = n->getStartBeat().inBeats();
        const double snapped = std::round (st / grid) * grid;
        const double ns = st + strength * (snapped - st);
        n->setStartAndLength (tracktion::BeatPosition::fromBeats (jmax (0.0, ns)),
                              n->getLengthBeats(), &undoManager());
    }
    logLine ("quantize_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("quantize_notes");
}

juce::var MoshOps::cmdHumanizeNotes (const juce::var& args)
{
    auto* mc = findMidiClip (args.getProperty ("clipId", var()).toString());
    if (mc == nullptr) return errResult ("humanize_notes", "no midi clip");
    // Stochastic op: seed is REQUIRED, never defaulted (phase0 §4.3).
    if (! args.hasProperty ("seed"))
        return errResult ("humanize_notes", "seed required (stochastic op, no default seed)");

    const double timing = jmax (0.0, (double) args.getProperty ("timingBeats", 0.0));
    const double velVar = jmax (0.0, (double) args.getProperty ("velVar", 0.0));
    juce::Random rng ((int64) (int) args.getProperty ("seed", 0));

    undoManager().beginNewTransaction ("humanize_notes");
    // Deterministic: notes iterated in sequence order, two draws per note.
    for (auto* n : mc->getSequence().getNotes())
    {
        const double jitter = (rng.nextDouble() * 2.0 - 1.0) * timing;
        const int vj = (int) std::lround ((rng.nextDouble() * 2.0 - 1.0) * velVar);
        n->setStartAndLength (tracktion::BeatPosition::fromBeats (jmax (0.0, n->getStartBeat().inBeats() + jitter)),
                              n->getLengthBeats(), &undoManager());
        n->setVelocity (jlimit (1, 127, n->getVelocity() + vj), &undoManager());
    }
    logLine ("humanize_notes", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("humanize_notes");
}

// ─────────────────────────────────────────────────────────────────────────────
// Builtin devices + sampler sounds
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoadBuiltin (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("load_builtin_plugin", "no track");

    const auto type = args.getProperty ("type", var()).toString();
    const char* xmlType = nullptr;
    if      (type == "sampler")    xmlType = te::SamplerPlugin::xmlTypeName;
    else if (type == "4osc")       xmlType = te::FourOscPlugin::xmlTypeName;
    else if (type == "compressor") xmlType = te::CompressorPlugin::xmlTypeName;
    else if (type == "eq")         xmlType = te::EqualiserPlugin::xmlTypeName;
    else if (type == "delay")      xmlType = te::DelayPlugin::xmlTypeName;
    else if (type == "reverb")     xmlType = te::ReverbPlugin::xmlTypeName;
    else if (type == "lowpass")    xmlType = te::LowPassPlugin::xmlTypeName;
    else if (type == "pitchshift") xmlType = te::PitchShiftPlugin::xmlTypeName;
    else if (type == "chorus")     xmlType = te::ChorusPlugin::xmlTypeName;
    else if (type == "phaser")     xmlType = te::PhaserPlugin::xmlTypeName;
    if (xmlType == nullptr)
        return errResult ("load_builtin_plugin", "unknown builtin type: " + type);

    undoManager().beginNewTransaction ("load_builtin_plugin");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (xmlType, {});
    if (plugin == nullptr) return errResult ("load_builtin_plugin", "create failed");

    const int vIndex = (int) args.getProperty ("index", -1);
    auto vis = visiblePlugins (*track);
    const int rawIndex = (vIndex < 0 || vIndex >= vis.size())
                             ? track->pluginList.getPlugins().size()
                             : track->pluginList.indexOf (vis[vIndex]);
    track->pluginList.insertPlugin (plugin, rawIndex, nullptr);
    ensureMeterLast (*track);

    auto* data = new DynamicObject();
    data->setProperty ("index", visiblePluginIndex (*track, plugin.get()));
    data->setProperty ("pluginItemId", plugin->itemID.toString());
    data->setProperty ("type", type);
    logLine ("load_builtin_plugin", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("load_builtin_plugin", var (data));
}

juce::var MoshOps::cmdAddSamplerSound (const juce::var& args)
{
    auto* sp = dynamic_cast<te::SamplerPlugin*> (
        findPlugin (args.getProperty ("trackId", var()).toString(),
                    (int) args.getProperty ("index", -1)));
    if (sp == nullptr) return errResult ("add_sampler_sound", "no sampler at index");

    File file (args.getProperty ("file", var()).toString());
    if (! file.existsAsFile()) return errResult ("add_sampler_sound", "file not found");
    te::AudioFile af (eng.edit().engine, file);
    if (! af.isValid()) return errResult ("add_sampler_sound", "invalid audio file");

    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = file.getFileNameWithoutExtension();

    undoManager().beginNewTransaction ("add_sampler_sound");
    const auto err = sp->addSound (file.getFullPathName(), name, 0.0, af.getLength(),
                                   (float) (double) args.getProperty ("gainDb", 0.0));
    if (err.isNotEmpty())
    {
        logLine ("add_sampler_sound", args, false, err, true);
        return errResult ("add_sampler_sound", err);
    }
    const int soundIndex = sp->getNumSounds() - 1;
    sp->setSoundParams (soundIndex,
                        (int) args.getProperty ("keyNote", 60),
                        (int) args.getProperty ("minNote", 0),
                        (int) args.getProperty ("maxNote", 127));
    if ((bool) args.getProperty ("openEnded", false))
        sp->setSoundOpenEnded (soundIndex, true);

    // SamplerPlugin rebuilds its sound list via an AsyncUpdater; in headless
    // command runs nothing pumps the message thread between this command and
    // an offline render, so the sound would not EXIST yet (the silent-808
    // bug: only samplers followed by a later create_track ever sounded).
    // Same drain pattern as createAudioTrack.
    if (! eng.hasAudio())
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

    auto* data = new DynamicObject();
    data->setProperty ("soundIndex", soundIndex);
    logLine ("add_sampler_sound", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_sampler_sound", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Clips: remove / pitch / stretch / slice
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdRemoveClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("remove_clip", "no clip: " + id);

    undoManager().beginNewTransaction ("remove_clip");
    clip->removeFromParent();
    logLine ("remove_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_clip");
}

juce::var MoshOps::cmdSetClipPitch (const juce::var& args)
{
    auto* acb = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (acb == nullptr) return errResult ("set_clip_pitch", "no audio clip");
    const double semis = jlimit (-48.0, 48.0, (double) args.getProperty ("semitones", 0.0));

    undoManager().beginNewTransaction ("set_clip_pitch");
    acb->setPitchChange ((float) semis);
    logLine ("set_clip_pitch", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_pitch");
}

juce::var MoshOps::cmdSetClipStretch (const juce::var& args)
{
    auto* acb = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (acb == nullptr) return errResult ("set_clip_stretch", "no audio clip");
    const double ratio = (double) args.getProperty ("ratio", 1.0);
    if (ratio < 0.25 || ratio > 4.0) return errResult ("set_clip_stretch", "ratio out of range [0.25, 4]");

    undoManager().beginNewTransaction ("set_clip_stretch");
    // Let the engine pick the best available stretcher for the build
    // (getActualTimeStretchMode falls back when a mode isn't compiled in).
    acb->setTimeStretchMode (te::TimeStretcher::soundtouchBetter);
    acb->setSpeedRatio (ratio);
    logLine ("set_clip_stretch", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_stretch");
}

juce::var MoshOps::cmdSliceClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("slice_clip", "no clip: " + id);
    auto* clipTrack = dynamic_cast<te::ClipTrack*> (clip->getTrack());
    if (clipTrack == nullptr) return errResult ("slice_clip", "clip not on a clip track");
    const double grid = (double) args.getProperty ("gridBeats", 0.0);
    if (grid <= 0.0) return errResult ("slice_clip", "bad gridBeats (transient mode is not wired; grid only)");

    // Compute split times up front (clip-start-anchored, grid spaced in beats
    // through the tempo map), then repeatedly split the rightmost piece.
    auto& ts = eng.edit().tempoSequence;
    const auto pos = clip->getPosition();
    const double startBeats = ts.toBeats (pos.getStart()).inBeats();
    const double endBeats   = ts.toBeats (pos.getEnd()).inBeats();

    undoManager().beginNewTransaction ("slice_clip");
    juce::Array<var> clipIds;
    clipIds.add (clip->itemID.toString());
    te::Clip* cur = clip;
    for (double b = startBeats + grid; b < endBeats - 1.0e-6; b += grid)
    {
        auto* right = clipTrack->splitClip (*cur, ts.toTime (tracktion::BeatPosition::fromBeats (b)));
        if (right == nullptr) break;
        clipIds.add (right->itemID.toString());
        cur = right;
    }

    auto* data = new DynamicObject();
    data->setProperty ("clipIds", clipIds);
    logLine ("slice_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("slice_clip", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing: track output, aux sends/returns, sidechain
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdRouteTrack (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("route_track", "no track");

    const auto destId = args.getProperty ("destTrackId", var()).toString();
    undoManager().beginNewTransaction ("route_track");
    if (destId.isEmpty())
        track->getOutput().setOutputToDefaultDevice (false);
    else
    {
        auto* dest = findTrack (destId);
        if (dest == nullptr) return errResult ("route_track", "no dest track: " + destId);
        track->getOutput().setOutputToTrack (dest);
    }
    logLine ("route_track", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("route_track");
}

juce::var MoshOps::cmdAddSend (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_send", "no track");
    const int bus = (int) args.getProperty ("busNumber", -1);
    if (bus < 0) return errResult ("add_send", "missing busNumber");

    undoManager().beginNewTransaction ("add_send");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::AuxSendPlugin::xmlTypeName, {});
    auto* send = dynamic_cast<te::AuxSendPlugin*> (plugin.get());
    if (send == nullptr) return errResult ("add_send", "create failed");
    send->busNumber = bus;
    send->setGainDb ((float) (double) args.getProperty ("gainDb", 0.0));
    track->pluginList.insertPlugin (plugin, track->pluginList.getPlugins().size(), nullptr);
    ensureMeterLast (*track);

    auto* data = new DynamicObject();
    data->setProperty ("index", visiblePluginIndex (*track, plugin.get()));
    data->setProperty ("busNumber", bus);
    logLine ("add_send", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_send", var (data));
}

juce::var MoshOps::cmdAddReturn (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_return", "no track");
    const int bus = (int) args.getProperty ("busNumber", -1);
    if (bus < 0) return errResult ("add_return", "missing busNumber");

    undoManager().beginNewTransaction ("add_return");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::AuxReturnPlugin::xmlTypeName, {});
    auto* ret = dynamic_cast<te::AuxReturnPlugin*> (plugin.get());
    if (ret == nullptr) return errResult ("add_return", "create failed");
    ret->busNumber = bus;
    // Returns must sit BEFORE the track's volume plugin to feed the fader.
    track->pluginList.insertPlugin (plugin, 0, nullptr);
    ensureMeterLast (*track);

    auto* data = new DynamicObject();
    data->setProperty ("index", visiblePluginIndex (*track, plugin.get()));
    data->setProperty ("busNumber", bus);
    logLine ("add_return", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_return", var (data));
}

juce::var MoshOps::cmdSetSidechain (const juce::var& args)
{
    auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                               (int) args.getProperty ("index", -1));
    auto* comp = dynamic_cast<te::CompressorPlugin*> (plugin);
    if (comp == nullptr) return errResult ("set_sidechain", "no compressor at index");
    auto* src = findTrack (args.getProperty ("sourceTrackId", var()).toString());
    if (src == nullptr) return errResult ("set_sidechain", "no source track");

    undoManager().beginNewTransaction ("set_sidechain");
    comp->setSidechainSourceID (src->itemID);
    comp->useSidechainTrigger = true;
    comp->guessSidechainRouting();      // wires source channels → sidechain input

    // Optional dynamics params, addressed semantically (names scanned on the
    // engine's own parameter list — exact engine names are version-fragile).
    auto setIf = [&] (const char* argName, const char* paramToken, double scale01 = -1.0)
    {
        if (! args.hasProperty (argName)) return;
        if (auto p = findParamByName (*comp, paramToken))
        {
            const auto v = (float) (double) args.getProperty (argName, 0.0);
            if (scale01 >= 0.0) p->setNormalisedParameter (v, juce::sendNotification);
            else                p->setParameter (v, juce::sendNotification);
        }
    };
    setIf ("thresholdDb", "threshold");
    setIf ("ratio", "ratio");
    setIf ("attackMs", "attack");
    setIf ("releaseMs", "release");

    logLine ("set_sidechain", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_sidechain");
}

// ─────────────────────────────────────────────────────────────────────────────
// Automation
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdWriteAutomation (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("write_automation", "no track");

    te::AutomatableParameter::Ptr param;
    if (const auto mixer = args.getProperty ("mixer", var()).toString(); mixer.isNotEmpty())
    {
        auto* vp = ensureVolumePlugin (*track);
        if (vp == nullptr) return errResult ("write_automation", "no volume plugin");
        param = (mixer == "pan") ? vp->panParam : vp->volParam;
    }
    else
    {
        auto* plugin = findPlugin (args.getProperty ("trackId", var()).toString(),
                                   (int) args.getProperty ("pluginIndex", -1));
        if (plugin == nullptr) return errResult ("write_automation", "no plugin at pluginIndex");
        if (const auto pname = args.getProperty ("paramName", var()).toString(); pname.isNotEmpty())
            param = findParamByName (*plugin, pname);
        else if (const int pi = (int) args.getProperty ("paramIndex", -1);
                 pi >= 0 && pi < plugin->getNumAutomatableParameters())
            param = plugin->getAutomatableParameter (pi);
        if (param == nullptr) return errResult ("write_automation", "no such param");
    }

    auto points = args.getProperty ("points", var());
    if (! points.isArray() || points.size() == 0)
        return errResult ("write_automation", "missing 'points'");

    undoManager().beginNewTransaction ("write_automation");
    auto& curve = param->getCurve();
    curve.clear (&undoManager());       // 'write' semantics: replace the lane
    auto& ts = eng.edit().tempoSequence;
    for (auto& p : *points.getArray())
    {
        const double beats = (double) p.getProperty ("beats", 0.0);
        const float value  = jlimit (0.0f, 1.0f, (float) (double) p.getProperty ("value", 0.0));
        const float curveAmt = jlimit (-1.0f, 1.0f, (float) (double) p.getProperty ("curve", 0.0));
        curve.addPoint (ts.toTime (tracktion::BeatPosition::fromBeats (beats)),
                        param->valueRange.convertFrom0to1 (value), curveAmt, &undoManager());
    }

    auto* data = new DynamicObject();
    data->setProperty ("param", param->getParameterName());
    data->setProperty ("points", points.size());
    logLine ("write_automation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("write_automation", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Arrangement sections (MOSH state — thin markers, phase0 §3.3 arrange.*)
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdCreateSection (const juce::var& args)
{
    const auto name = args.getProperty ("name", var()).toString();
    const int startBar = (int) args.getProperty ("startBar", 0);
    const int lengthBars = (int) args.getProperty ("lengthBars", 0);
    if (name.isEmpty() || startBar < 1 || lengthBars < 1)
        return errResult ("create_section", "need name, startBar >= 1, lengthBars >= 1");

    undoManager().beginNewTransaction ("create_section");
    auto arrange = eng.edit().state.getOrCreateChildWithName (MOSH_ARRANGE, &undoManager());
    // Re-creating a named section moves it (idempotent for replay).
    auto node = arrange.getChildWithProperty ("name", name);
    if (! node.isValid())
    {
        node = juce::ValueTree (SECTION);
        arrange.appendChild (node, &undoManager());
        node.setProperty ("name", name, &undoManager());
    }
    node.setProperty ("startBar", startBar, &undoManager());
    node.setProperty ("lengthBars", lengthBars, &undoManager());

    logLine ("create_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_section");
}

// Stage 23: the arranger strip needs delete (create_section already moves/
// resizes idempotently by name).
juce::var MoshOps::cmdRemoveSection (const juce::var& args)
{
    const auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) return errResult ("remove_section", "missing 'name'");
    auto arrange = eng.edit().state.getChildWithName (MOSH_ARRANGE);
    auto node = arrange.isValid() ? arrange.getChildWithProperty ("name", name) : juce::ValueTree();
    if (! node.isValid()) return errResult ("remove_section", "no section: " + name);

    undoManager().beginNewTransaction ("remove_section");
    arrange.removeChild (node, &undoManager());
    logLine ("remove_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_section");
}

} // namespace mosh
