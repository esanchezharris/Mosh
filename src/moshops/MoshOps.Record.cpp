// REC-001 — how a live MIDI take behaves, and Ableton's Capture MIDI.
//
// The recording LIFECYCLE already existed before this file: arm_track assigns and enables
// an input instance, set_transport{record} rolls, stop_recording lands the take. What did
// not exist was any way to say what a take should DO when it lands — merge into the clip
// it fell on or replace it, snap to a grid on the way in, respect a punch range — or any
// way to keep what you played when you were not recording at all.
//
// WHY THE INTENT IS STORED RATHER THAN WRITTEN STRAIGHT THROUGH. Three of these five
// settings live on te::MidiInputDevice (mergeRecordings / replaceExistingClips /
// quantisation), which is per-device and exists only while an audio device is open. A
// producer choosing "overdub" with no interface plugged in would be writing to nothing,
// and --selftest — which never has a device — could not tell a working setting from a
// dead one. So the command writes INTENT to the MOSH_PROJECT node (where it also saves
// and reloads with the .tracktionedit) and applyRecordOptionsToDevices() pushes it into
// the live engine every time it could matter. That is the same shape as G2b's count-in,
// and for the same reason.
//
// The fourth, punchInOut, does live in the Edit (te::Edit::recordingPunchInOut) — but it
// is bound with a nullptr UndoManager, so writing it inside a transaction creates an
// EMPTY one, and this repo has been bitten by that before: the next undo then destroys
// the previous edit instead (the G14 class). Storing it alongside the others keeps one
// write path and one posture: all five are non-undoable preferences.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "state/Ids.h"
#include "engine/RecordingResidue.h"

#include <set>

namespace mosh
{
using namespace juce;

namespace
{
/** The record-quantise grids tracktion actually implements, as BEATS — the same domain
    as quantize_notes' `division`, so a producer who knows one knows the other.

    Mirrors the quantisationTypes table in tracktion_QuantisationType.cpp. It is
    deliberately irregular (1/9 and 1/12 are there; 1/48 is not), which is why a
    requested value is matched against this list and REFUSED with the list when it
    misses, rather than snapped to the nearest entry — silently quantising to a grid
    the producer did not ask for is worse than saying no. */
struct QuantGrid { double beats; const char* engineName; };

const QuantGrid kQuantGrids[] =
{
    { 0.0,        "(none)"    },
    { 1.0 / 64.0, "1/64 beat" },
    { 1.0 / 32.0, "1/32 beat" },
    { 1.0 / 24.0, "1/24 beat" },
    { 1.0 / 16.0, "1/16 beat" },
    { 1.0 / 12.0, "1/12 beat" },
    { 1.0 /  9.0, "1/9 beat"  },
    { 1.0 /  8.0, "1/8 beat"  },
    { 1.0 /  6.0, "1/6 beat"  },
    { 1.0 /  4.0, "1/4 beat"  },
    { 1.0 /  3.0, "1/3 beat"  },
    { 1.0 /  2.0, "1/2 beat"  },
    { 1.0,        "1 beat"    },
};

/** Nearest grid whose value matches within a relative tolerance, or nullptr. The
    tolerance exists because 1/3 and 1/9 cannot round-trip exactly through JSON. */
const QuantGrid* findGrid (double beats)
{
    for (auto& g : kQuantGrids)
        if (std::abs (g.beats - beats) <= 1.0e-6 * juce::jmax (1.0, std::abs (g.beats)))
            return &g;
    return nullptr;
}

juce::String gridList()
{
    juce::StringArray s;
    for (auto& g : kQuantGrids)
        s.add (juce::String (g.beats, 6).trimCharactersAtEnd ("0").trimCharactersAtEnd ("."));
    return s.joinIntoString (", ");
}

const char* engineNameForBeats (double beats)
{
    if (auto* g = findGrid (beats)) return g->engineName;
    return "(none)";
}

/** How far back capture_midi may reach. Tracktion allocates the retrospective buffer per
    device from this, so it is a real memory cost, not a free dial. Ableton's own Capture
    buffer is comparable. */
constexpr double kRetroMaxSeconds     = 60.0;
constexpr double kRetroDefaultSeconds = 10.0;
}

// ── applying stored intent to the live engine ────────────────────────────────────────
void MoshOps::applyRecordOptionsToDevices()
{
    // Re-applies the STORED preference to whatever devices exist RIGHT NOW, every time
    // it is called (on set, on record-start, on project load) rather than only once —
    // so a controller plugged in after the setting was made still honours it. Cheap,
    // and a complete no-op headless where getMidiInDevices() is empty.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);

    const bool   overdub = node.hasProperty (ids::recOverdub)
                               ? (bool) node.getProperty (ids::recOverdub) : true;
    const bool   replace = node.hasProperty (ids::recReplaceExisting)
                               ? (bool) node.getProperty (ids::recReplaceExisting) : false;
    const double quant   = node.hasProperty (ids::recQuantize)
                               ? (double) node.getProperty (ids::recQuantize) : 0.0;
    const bool   punch   = node.hasProperty (ids::recPunchInOut)
                               ? (bool) node.getProperty (ids::recPunchInOut) : false;
    const double retro   = node.hasProperty (ids::recRetroSeconds)
                               ? (double) node.getProperty (ids::recRetroSeconds) : kRetroDefaultSeconds;

    // punchInOut is an Edit property, so it applies with or without a device. nullptr
    // UndoManager deliberately (see the file header) — it is a preference, and a
    // transaction here would be an empty one.
    eng.edit().recordingPunchInOut = punch;

    for (auto& dev : eng.engine().getDeviceManager().getMidiInDevices())
    {
        if (dev == nullptr) continue;
        dev->mergeRecordings      = overdub;
        dev->replaceExistingClips = replace;
        dev->quantisation.setType (engineNameForBeats (quant));
        dev->updateRetrospectiveBufferLength (retro);
    }
}

// ── set_record_options ───────────────────────────────────────────────────────────────
juce::var MoshOps::cmdSetRecordOptions (const juce::var& args)
{
    auto node = projectSettingsTree();

    // Every field is OPTIONAL and independently settable: the UI has five separate
    // controls, and a command that demanded all five would make each control clobber the
    // other four with whatever it happened to be rendering.
    if (args.hasProperty ("overdub"))
        node.setProperty (ids::recOverdub, (bool) args.getProperty ("overdub", true), nullptr);

    if (args.hasProperty ("replaceExisting"))
        node.setProperty (ids::recReplaceExisting, (bool) args.getProperty ("replaceExisting", false), nullptr);

    if (args.hasProperty ("quantize"))
    {
        const double q = (double) args.getProperty ("quantize", 0.0);
        if (findGrid (q) == nullptr)
            return errResult ("set_record_options",
                              "quantize must be one of these beat divisions: " + gridList());
        node.setProperty (ids::recQuantize, q, nullptr);
    }

    if (args.hasProperty ("punchInOut"))
        node.setProperty (ids::recPunchInOut, (bool) args.getProperty ("punchInOut", false), nullptr);

    if (args.hasProperty ("retrospectiveSeconds"))
    {
        const double s = (double) args.getProperty ("retrospectiveSeconds", kRetroDefaultSeconds);
        if (s < 0.0 || s > kRetroMaxSeconds)
            return errResult ("set_record_options",
                              "retrospectiveSeconds must be 0.." + juce::String ((int) kRetroMaxSeconds));
        node.setProperty (ids::recRetroSeconds, s, nullptr);
    }

    applyRecordOptionsToDevices();          // immediate effect this session

    eng.markDirty();                        // edit-state change → needs re-save
    logLine ("set_record_options", args, true, {}, false);   // preference — NOT undoable
    emitSnapshotInvalidated();
    return okResult ("set_record_options", recordOptionsToVar());
}

juce::var MoshOps::recordOptionsToVar()
{
    // Read-only by contract (snapshot() must not mutate): getChildWithName returns an
    // INVALID tree when the node is absent, and hasProperty() on an invalid tree is
    // false — so a project that has never set these reads its defaults without the
    // snapshot quietly creating the node.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);

    const double quant = node.hasProperty (ids::recQuantize)
                             ? (double) node.getProperty (ids::recQuantize) : 0.0;

    auto* o = new DynamicObject();
    // Always present, never conditional: a UI that has to distinguish "false" from
    // "missing" ends up rendering a toggle in a third, wrong state on a fresh project.
    o->setProperty ("overdub",         node.hasProperty (ids::recOverdub)
                                           ? (bool) node.getProperty (ids::recOverdub) : true);
    o->setProperty ("replaceExisting", node.hasProperty (ids::recReplaceExisting)
                                           ? (bool) node.getProperty (ids::recReplaceExisting) : false);
    o->setProperty ("quantize",        quant);
    o->setProperty ("quantizeLabel",   juce::String (engineNameForBeats (quant)));
    o->setProperty ("punchInOut",      node.hasProperty (ids::recPunchInOut)
                                           ? (bool) node.getProperty (ids::recPunchInOut) : false);
    o->setProperty ("retrospectiveSeconds", node.hasProperty (ids::recRetroSeconds)
                                           ? (double) node.getProperty (ids::recRetroSeconds)
                                           : kRetroDefaultSeconds);
    return var (o);
}

// ── capture_midi ─────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdCaptureMidi (const juce::var& args)
{
    // Ableton's Capture MIDI: you were noodling, you were NOT recording, and you want to
    // keep it. tracktion already buffers every incoming MIDI message per device
    // (RetrospectiveMidiBuffer); applyRetrospectiveRecord turns that buffer into clips as
    // if recording had been running the whole time.
    //
    // Unlike the rest of this file, capture_midi IS an Edit mutation — it creates clips —
    // so it takes a real transaction and is undoable. That matters more than usual for
    // this command: Capture is a gesture you fire speculatively, and a producer who does
    // not like what came back must be one Cmd+Z away from before.
    const bool armedOnly = (bool) args.getProperty ("armedOnly", false);

    auto reportNoOp = [&] (const char* reason) -> juce::var
    {
        // Graceful, never an error — pressing Capture with nothing buffered has done
        // nothing wrong, and --selftest (which has no device, so no buffer) pins this
        // exact shape rather than pretending it proved a capture.
        logLine ("capture_midi", args, true, {}, false);
        auto* d = new DynamicObject();
        d->setProperty ("applied", false);
        d->setProperty ("clips", Array<var>());
        d->setProperty ("reason", reason);
        return okResult ("capture_midi", var (d));
    };

    if (! eng.hasAudio())
        return reportNoOp ("no audio device");

    eng.ensurePlaybackContext();
    auto* context = eng.edit().getTransport().getCurrentPlaybackContext();
    if (context == nullptr)
        return reportNoOp ("no playback context");

    beginTxn ("capture_midi");

    // CAPTURE IS ADDITIVE, always — even when the producer has replaceExisting on for
    // ordinary recording. This is not a preference we are overriding for taste: the
    // engine's replace path is `track->deleteRegion (position, nullptr)`, and that
    // nullptr is a NON-undoable delete
    // (tracktion_MidiInputDevice.cpp, addMidiAsTransaction). The new clip IS undoable
    // (insertClipWithState adds it with &edit.getUndoManager()), so with replace left on,
    // one Cmd+Z would remove what Capture created and leave the clips it destroyed gone
    // for good — the G14 undo class, on a gesture a producer fires speculatively.
    //
    // Ableton's Capture never deletes what is already on the timeline either, so the
    // additive behaviour is also simply the right one. Restored on every exit path below.
    struct ReplaceGuard
    {
        std::vector<std::pair<te::MidiInputDevice*, bool>> saved;
        ~ReplaceGuard() { for (auto& [dev, was] : saved) dev->replaceExistingClips = was; }
    } replaceGuard;

    for (auto& dev : eng.engine().getDeviceManager().getMidiInDevices())
        if (dev != nullptr)
        {
            replaceGuard.saved.emplace_back (dev.get(), dev->replaceExistingClips);
            dev->replaceExistingClips = false;
        }

    juce::Array<te::Clip*> created;
    const auto result = context->applyRetrospectiveRecord (&created, armedOnly);

    if (! result.wasOk())
    {
        // A real engine refusal (nothing buffered is the common one). Report the
        // engine's own words rather than inventing a reason for it.
        logLine ("capture_midi", args, false, result.getErrorMessage(), false);
        return errResult ("capture_midi", result.getErrorMessage());
    }

    Array<var> landed;
    for (auto* c : created)
        if (c != nullptr)
            landed.add (clipToVar (*c));

    logLine ("capture_midi", args, true, {}, ! landed.isEmpty());
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("applied", ! landed.isEmpty());
    data->setProperty ("clips", landed);
    if (landed.isEmpty())
        data->setProperty ("reason", "nothing had been played into the retrospective buffer");
    return okResult ("capture_midi", var (data));
}


// ── recording residue (CAP-001) ──────────────────────────────────────────────────────
//
// Tracktion streams a take to disk WHILE recording and lands the clip only when the
// transport stops (applyLastRecording). A crash mid-take therefore leaves a WAV under
// the project directory that no clip references — real audio the producer sang, and
// the one thing the A3 journal replay cannot bring back (the clip never existed).
//
// Policy (ported from Moshpit M005-08): a readable take at the project rate is adopted
// through the NORMAL import path, placed at its BWAV time reference on the track its
// filename names; anything torn or unreadable is quarantined IN PLACE (renamed, never
// deleted, never adopted); the project document is never rewritten on a failure. Both
// are explicit commands from the recovery notice, never automatic: adoption creates a
// clip, and which orphan is worth keeping is the producer's call. There is no "newer
// than the last save" filter: the relaunch that recovers a crash reopens and re-saves
// the project first, which would hide exactly the file we are looking for.
namespace
{
struct ResidueEntry
{
    juce::File file;
    juce::String trackName;
    int take = 0;
    bool readable = false;
    double seconds = 0.0;
    double sampleRate = 0.0;
    double startSeconds = 0.0;
};

} // namespace

juce::var MoshOps::recordingResidueToVar()
{
    // Read-only by contract. Cheap: one directory listing of the project dir (no
    // recursion) plus one reader open per candidate; candidates are rare.
    Array<var> out;
    const auto dir = eng.editFile().getParentDirectory();
    if (! dir.isDirectory())
        return out;

    std::set<juce::String> referenced;
    for (auto* t : te::getAudioTracks (eng.edit()))
        for (auto* c : t->getClips())
            if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
            {
                referenced.insert (w->getOriginalFile().getFullPathName());
                referenced.insert (w->getCurrentSourceFile().getFullPathName());
            }

    // No rate gate here. Moshpit refused a rate mismatch because it had no resampler; a
    // Tracktion clip resamples on playback, and the relaunch that recovers a crash often
    // has NO device open (its "current rate" is a default, not the take's truth).
    const double projectRate = 0.0;
    juce::AudioFormatManager afm; afm.registerBasicFormats();
    for (const auto& file : mosh::residue::findResidue (dir, referenced))
    {
        const auto parsed = mosh::residue::parseTakeFileName (file.getFileNameWithoutExtension());
        std::unique_ptr<juce::AudioFormatReader> reader (afm.createReaderFor (file));
        const bool readable = reader != nullptr && reader->lengthInSamples > 0 && reader->sampleRate > 0.0;
        // The reader refuses every take a crash left behind: JUCE writes the WAV sizes only
        // on close. Inspect the chunks ourselves — an intact PCM payload behind a zero-size
        // header is the NORMAL crash residue and is adopted through a repaired copy.
        const auto shape = readable ? mosh::residue::WavShape{} : mosh::residue::inspectWav (file);
        const bool repairable = ! readable && shape.headerTorn();
        const std::int64_t frames = readable ? reader->lengthInSamples : repairable ? shape.payloadFrames() : 0;
        const double fileRate = readable ? reader->sampleRate : repairable ? shape.sampleRate : 0.0;
        auto* o = new DynamicObject();
        o->setProperty ("file", file.getFullPathName());
        o->setProperty ("name", file.getFileName());
        o->setProperty ("modifiedAt", file.getLastModificationTime().toISO8601 (true));
        o->setProperty ("trackName", parsed ? parsed->trackName : String());
        o->setProperty ("take", parsed ? parsed->take : 0);
        o->setProperty ("readable", readable);
        o->setProperty ("repairable", repairable);
        o->setProperty ("seconds", fileRate > 0.0 ? (double) frames / fileRate : 0.0);
        o->setProperty ("sampleRate", fileRate);
        o->setProperty ("startSeconds", readable
            ? mosh::residue::startSecondsFromTimeReference (
                  reader->metadataValues.getValue (juce::WavAudioFormat::bwavTimeReference, {}), reader->sampleRate)
            : repairable ? mosh::residue::startSecondsFromTimeReference (String (shape.bextTimeReference), shape.sampleRate)
                         : 0.0);
        o->setProperty ("decision",
            mosh::residue::decide (readable || repairable, frames, fileRate, projectRate) == mosh::residue::Decision::adopt
                ? "adopt" : "quarantine");
        out.add (var (o));
    }
    return out;
}

juce::var MoshOps::cmdListRecordingResidue (const juce::var&)
{
    auto* d = new DynamicObject();
    d->setProperty ("residue", recordingResidueToVar());
    return okResult ("list_recording_residue", var (d));   // read: no log line
}

juce::var MoshOps::cmdAdoptRecordingResidue (const juce::var& args)
{
    static const char* const kName = "adopt_recording_residue";
    const juce::File file (args.getProperty ("file", var()).toString());
    // Only a file the scan itself would offer is adoptable: no path can smuggle an
    // arbitrary WAV in under the recovery banner.
    // Bind to a NAMED local first: getArray() on the returned temporary dangles the
    // moment the full expression ends (the same trap MoshOps.cpp's snapshot code notes).
    juce::var entry;
    const auto listed = recordingResidueToVar();
    if (auto* arr = listed.getArray())
        for (const auto& e : *arr)
            if (e.getProperty ("file", var()).toString() == file.getFullPathName())
                entry = e;
    if (! entry.isObject())
        return errResult (kName, "not a recoverable take: " + file.getFileName());
    if (entry.getProperty ("decision", var()).toString() != "adopt")
        return errResult (kName, "this take is unreadable or at the wrong rate — quarantine it instead");

    // The track its name carries, else an explicit trackId, else the first audio track.
    juce::String trackId = args.getProperty ("trackId", var()).toString();
    if (trackId.isEmpty())
    {
        const auto wanted = entry.getProperty ("trackName", var()).toString();
        for (auto* t : te::getAudioTracks (eng.edit()))
            if (t->getName() == wanted) { trackId = t->itemID.toString(); break; }
    }
    if (trackId.isEmpty())
        if (auto tracks = te::getAudioTracks (eng.edit()); ! tracks.isEmpty())
            trackId = tracks.getFirst()->itemID.toString();
    if (trackId.isEmpty())
        return errResult (kName, "no audio track to land the take on");

    const double startSeconds = (double) entry.getProperty ("startSeconds", 0.0);

    // A torn header (the normal crash case) is repaired into a sibling copy; the original
    // is kept but renamed off the .wav extension so the scan stops offering it. The
    // repaired copy is what the clip references from now on.
    juce::File source = file;
    if ((bool) entry.getProperty ("repairable", false))
    {
        const auto repaired = file.getSiblingFile (file.getFileNameWithoutExtension() + ".recovered.wav");
        if (! mosh::residue::repairTruncatedWav (file, repaired))
            return errResult (kName, "could not repair the take's header — quarantine it instead");
        source = repaired;
    }
    auto result = importWaveFileToTrack (kName, source, file.getFileNameWithoutExtension(),
                                         trackId, startSeconds, args);
    if ((bool) result.getProperty ("ok", false))
    {
        if (source != file)
            file.moveFileTo (file.getSiblingFile (file.getFileName() + ".recovered-source"));   // kept, never deleted
        // Mark the landed clip as a recovered take (the same measured-peak posture as a
        // normal landing, so a silent crash residue is flagged too).
        const auto clipId = result.getProperty ("data", var()).getProperty ("clipId", var()).toString();
        if (auto* c = findClip (clipId))
        {
            measureLandedClipPeak (*c);
            c->state.setProperty (ids::moshRecovered, true, nullptr);
        }
        emitSnapshotInvalidated();
    }
    return result;
}

juce::var MoshOps::cmdQuarantineRecordingResidue (const juce::var& args)
{
    static const char* const kName = "quarantine_recording_residue";
    const juce::File file (args.getProperty ("file", var()).toString());
    bool listed = false;
    const auto candidates = recordingResidueToVar();   // named local — see cmdAdoptRecordingResidue
    if (auto* arr = candidates.getArray())
        for (const auto& e : *arr)
            if (e.getProperty ("file", var()).toString() == file.getFullPathName())
                listed = true;
    if (! listed)
        return errResult (kName, "not a recoverable take: " + file.getFileName());
    const auto target = mosh::residue::quarantineName (file);
    if (! file.moveFileTo (target))
    {
        logLine (kName, args, false, "could not rename", false);
        return errResult (kName, "could not rename " + file.getFileName());
    }
    logLine (kName, args, true, {}, false);   // a file action — never undoable, never deletes
    emitSnapshotInvalidated();
    auto* d = new DynamicObject();
    d->setProperty ("file", file.getFullPathName());
    d->setProperty ("quarantined", target.getFullPathName());
    return okResult (kName, var (d));
}
// ── calibrate_latency (LAT-001) ──────────────────────────────────────────────────────
//
// Ported from Moshpit M005-13/M005-29/M006-04. The measurement is a half-second log
// sweep played through the device output and captured from its input inside ONE
// juce::AudioIODeviceCallback, so the detected offset IS the output→room→input round
// trip in that device's own clock — no graph, no PDC, no monitoring path in the way.
// That is exactly why the Edit is DETACHED for the two seconds it runs (the same
// exclusivity dance export uses): Tracktion's own callback then emits silence, and the
// only thing in the room is the sweep.
//
// What Tracktion is told afterwards is NOT the measured value. It already subtracts the
// device-reported input+output latency and the graph PDC when it lands a take; pushing
// the whole measurement would double-compensate. MoshEngine pushes only the residual,
// and only while the record is honoured (same rate, same device pair) — see
// engine/LatencyCalibrationRecord.h for the maths and the tests that pin it.
juce::var MoshOps::cmdCalibrateLatency (const juce::var& args)
{
    static const char* const kName = "calibrate_latency";
    const auto action = args.getProperty ("action", "status").toString();

    auto reattach = [&]
    {
        if (! calibrationDetachedContext_) return;
        calibrationDetachedContext_ = false;
        eng.ensurePlaybackContext();
    };

    if (action == "status")
        return okResult (kName, latencyCalibrationToVar());   // read-only: no log line

    if (action == "cancel")
    {
        if (calibrationSession_ != nullptr)
            calibrationSession_->cancel();
        reattach();
        logLine (kName, args, true, {}, false);
        emitSnapshotInvalidated();
        return okResult (kName, latencyCalibrationToVar());
    }

    if (action == "clear")
    {
        eng.clearLatencyCalibration();
        calibrationError_.clear();
        logLine (kName, args, true, {}, false);
        emitSnapshotInvalidated();
        return okResult (kName, latencyCalibrationToVar());
    }

    if (action == "apply")
    {
        // Re-decide against whatever device/rate is live (a no-op headless: nothing to
        // push, and the record stays wherever it was).
        eng.applyLatencyCalibrationToDevices();
        logLine (kName, args, true, {}, false);
        emitSnapshotInvalidated();
        return okResult (kName, latencyCalibrationToVar());
    }

    if (action == "start")
    {
        // Honest refusals first, in the order a producer can act on them.
        if (! eng.hasAudio() || ! eng.audioReady())
        {
            logLine (kName, args, false, "no audio device in this session", false);
            return errResult (kName, "no audio device in this session");
        }
        auto& transport = eng.edit().getTransport();
        if (transport.isRecording())
            return errResult (kName, "stop recording before calibrating");
        if (calibrationSession_ != nullptr && calibrationSession_->running())
            return errResult (kName, "a calibration is already running");
        auto* device = adm().getCurrentAudioDevice();
        if (device == nullptr)
            return errResult (kName, "no audio device in this session");
        if (device->getActiveInputChannels().countNumberOfSetBits() == 0)
            return errResult (kName, "the audio device has no active input channel — pick an input in Settings first");

        // Detach the Edit (export's exclusivity dance, MoshOps.ProjectIo.cpp): meter taps
        // live on the context being freed, and lastSeenContext must not ABA-match the next.
        unregisterAllMeterClients();
        transport.stop (false, false);
        transport.freePlaybackContext();
        lastSeenContext = nullptr;
        calibrationDetachedContext_ = true;

        if (calibrationRegistrar_ == nullptr)
            calibrationRegistrar_ = std::make_unique<latency::DeviceManagerRegistrar> (adm());
        if (calibrationSession_ == nullptr)
            calibrationSession_ = std::make_unique<latency::CalibrationSession> (*calibrationRegistrar_);

        calibrationError_.clear();
        calibrationRate_ = device->getCurrentSampleRate();
        if (! calibrationSession_->start (calibrationRate_,
                                          eng.sessionDir().getChildFile ("latency-calibration-capture.f32")))
        {
            reattach();
            return errResult (kName, "a calibration is already running");
        }

        logLine (kName, args, true, {}, false);   // machine action — not undoable
        emitSnapshotInvalidated();                // state: running
        auto* d = new DynamicObject();
        d->setProperty ("started", true);
        // preroll 0.25 s + sweep 0.5 s + 1.0 s search window + 0.2 s tail (CalibrationRunner::begin)
        d->setProperty ("expectedSeconds", 1.95);
        return okResult (kName, var (d));
    }

    return errResult (kName, "action must be start, status, apply, cancel, or clear");
}

void MoshOps::pollLatencyCalibration()
{
    if (calibrationSession_ == nullptr || ! calibrationSession_->running())
        return;
    auto outcome = calibrationSession_->pollFinished();   // deregisters FIRST, then measures
    if (! outcome.has_value())
        return;

    if (outcome->succeeded())
    {
        latency::CalibrationRecord record;
        record.frames     = outcome->value->frames;
        record.sampleRate = calibrationRate_;
        record.confidence = outcome->value->confidence;
        record.measuredAt = Time::getCurrentTime().toISO8601 (true);
        const auto setup  = adm().getAudioDeviceSetup();
        record.inputDevice  = setup.inputDeviceName;
        record.outputDevice = setup.outputDeviceName;
        // fromVar's own band check, applied to a fresh measurement too: a >500 ms
        // "round trip" is a room echo or a routing loop, not a calibration.
        if (latency::CalibrationRecord::fromVar (record.toVar()).has_value())
        {
            calibrationError_.clear();
            eng.setLatencyCalibration (record);
        }
        else
        {
            calibrationError_ = "the measured round trip is outside the 500 ms band — check routing and retry";
        }
    }
    else
    {
        calibrationError_ = outcome->error;
    }

    if (calibrationDetachedContext_)
    {
        calibrationDetachedContext_ = false;
        eng.ensurePlaybackContext();      // also re-applies the residual for this device
    }
    emit ("latency_calibration", latencyCalibrationToVar());
    emitSnapshotInvalidated();
}

juce::var MoshOps::latencyCalibrationToVar()
{
    const bool running = calibrationSession_ != nullptr && calibrationSession_->running();
    const auto record  = eng.latencyCalibration();

    auto* o = new DynamicObject();
    o->setProperty ("state", running          ? "running"
                           : record.has_value() ? "measured"
                           : calibrationError_.isNotEmpty() ? "failed" : "idle");
    o->setProperty ("frames",       (juce::int64) (record ? record->frames : 0));
    o->setProperty ("sampleRate",   record ? record->sampleRate : 0.0);
    o->setProperty ("ms",           record ? record->milliseconds() : 0.0);
    o->setProperty ("confidence",   record ? record->confidence : 0.0);
    o->setProperty ("measuredAt",   record ? record->measuredAt : String());
    o->setProperty ("inputDevice",  record ? record->inputDevice : String());
    o->setProperty ("outputDevice", record ? record->outputDevice : String());
    o->setProperty ("method",       record ? record->method : String ("farina-sweep-v1"));
    o->setProperty ("deviceReportedSamples", (juce::int64) eng.deviceReportedLatencySamples());
    o->setProperty ("appliedMs",    eng.latencyCalibrationAppliedMs());
    o->setProperty ("applied",      eng.latencyCalibrationApplied());
    o->setProperty ("stale",        eng.latencyCalibrationStale());
    o->setProperty ("error",        calibrationError_);
    return var (o);
}

} // namespace mosh
