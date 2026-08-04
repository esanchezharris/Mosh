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

} // namespace mosh
