// RFC 001 (A-PR2) — MoshOps partial-class split: the transport/tempo/project
// command bodies (set_transport, SES-001 tempo map: set_tempo/time-signature/
// insert/remove tempo + time-sig changes/tempo curve, set_metronome, KEY-001
// musical key, PRJ-008 project settings, G2b count-in), moved VERBATIM from
// MoshOps.cpp — including the KEY-001 file-local validation tables (their only
// consumers are here) and the kDefaultKeyTonic/kDefaultKeyMode static member
// definitions. Same class, same member functions — only the translation unit
// changed. The dispatch if-chain and all transaction/log/result/emit plumbing
// stay in MoshOps.cpp (one mutation path, by construction).

#include "MoshOps.h"
#include "RecordingLanding.h"
#include "state/Ids.h"
#include "state/CountIn.h"
#include "state/Migrations.h"
// CAP-TRN-005 — the four te::Click accessors, re-declared VERBATIM from
// tracktion_engine/playback/graph/tracktion_ClickNode.h (pinned clone 2877b621).
//
// They cannot simply be included: that header also declares ClickNode, which derives from
// tracktion::graph::Node, and tracktion_graph is not in the module's public include set —
// the module pulls the header in only from tracktion_engine_playback.cpp, so including it
// here fails on an incomplete base class. Re-declaring is still CALLING the engine's own
// implementation (these have external linkage and are compiled into the module), not
// re-deriving it from te::SettingID + restartAllTransports, which would mean owning a copy
// of the engine's behaviour. If the engine ever changes one of these signatures the result
// is a LINK error, which is loud — not a silent divergence.
namespace tracktion { inline namespace engine { namespace Click
{
    int getMidiClickNote (Engine&, bool big);
    juce::String getClickWaveFile (Engine&, bool big);
    void setMidiClickNote (Engine&, bool big, int noteNum);
    void setClickWaveFile (Engine&, bool big, const juce::String& filename);
}}} // namespace tracktion::engine::Click

namespace mosh
{
using namespace juce;

juce::var MoshOps::cmdSetTransport (const juce::var& args)
{
    auto& transport = eng.edit().getTransport();
    const auto action = args.getProperty ("action", var()).toString();
    bool finalizedRecording = false;

    if (recording::shouldFinalizeBeforeTransportAction (transport.isRecording(), action))
    {
        const auto stopResult = cmdStopRecording (var (new DynamicObject()));
        const auto stopData = stopResult.getProperty ("data", var());
        const bool stopped = stopResult.isObject()
            && (bool) stopResult.getProperty ("ok", false)
            && stopData.isObject()
            && (bool) stopData.getProperty ("applied", false);
        if (! stopped)
        {
            auto reason = stopResult.getProperty ("error", var()).toString();
            if (reason.isEmpty())
                reason = stopData.getProperty ("reason", "could not land recording take").toString();
            logLine ("set_transport", args, false, reason, false);
            return errResult ("set_transport", reason);
        }
        finalizedRecording = true;
    }

    // Play/record touch the audio device; skip them in no-audio (headless) mode.
    if (! finalizedRecording
        && (action == "play" || (action == "toggle" && ! transport.isPlaying()))
        && eng.hasAudio())
    {
        eng.ensurePlaybackContext();
        transport.play (false);
    }
    else if (! finalizedRecording
             && (action == "stop" || (action == "toggle" && transport.isPlaying())))
    {
        transport.stop (false, false);
    }
    else if (! finalizedRecording && action == "record" && eng.hasAudio())
    {
        // G2b — re-sync the live Edit's pre-roll to the stored project preference
        // right before every record start, so a save/reload that swapped in a
        // different Edit instance (or a countInBars change from another session)
        // is always honored. transport.record() below is what actually consults
        // it (te::Edit::getNumCountInBeats(), via TransportControl).
        applyCountInToEdit();
        // REC-001 — same re-sync, same reason, for the settings that decide what the take
        // DOES: a MIDI device plugged in since the preference was set has never seen it,
        // and the engine reads mergeRecordings/quantisation at landing time.
        applyRecordOptionsToDevices();
        eng.ensurePlaybackContext();
        transport.record (false);
    }

    if (action == "to_end")
        transport.setPosition (tracktion::TimePosition::fromSeconds (eng.edit().getLength().inSeconds()));
    else if (action == "to_start")
        transport.setPosition (tracktion::TimePosition());

    if (args.hasProperty ("position"))
        transport.setPosition (tracktion::TimePosition::fromSeconds ((double) args.getProperty ("position", 0.0)));

    if (args.hasProperty ("loop"))
        transport.looping = (bool) args.getProperty ("loop", false);

    if (args.hasProperty ("loopStart") && args.hasProperty ("loopEnd"))
        transport.setLoopRange ({ tracktion::TimePosition::fromSeconds ((double) args.getProperty ("loopStart", 0.0)),
                                  tracktion::TimePosition::fromSeconds ((double) args.getProperty ("loopEnd", 0.0)) });

    logLine ("set_transport", args, true, {}, false);          // transport is NOT undoable
    emit ("transport", transportToVar());
    return okResult ("set_transport", transportToVar());
}

juce::var MoshOps::cmdSetTempo (const juce::var& args)
{
    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    if (tempo == nullptr) return errResult ("set_tempo", "no tempo setting");

    const double bpm = juce::jlimit (20.0, 999.0, (double) args.getProperty ("bpm", 120.0));
    beginTxn ("set_tempo");
    tempo->setBpm (bpm);
    logLine ("set_tempo", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("bpm", tempo->getBpm());
    return okResult ("set_tempo", var (data));
}

juce::var MoshOps::cmdSetTimeSignature (const juce::var& args)
{
    auto& edit = eng.edit();
    auto* ts = edit.tempoSequence.getTimeSig (0);
    if (ts == nullptr) return errResult ("set_time_signature", "no time signature");

    const int num = juce::jlimit (1, 32, (int) args.getProperty ("numerator", 4));
    const int den = (int) args.getProperty ("denominator", 4);
    static const int validDen[] = { 1, 2, 4, 8, 16, 32 };
    bool denOk = false;
    for (int d : validDen) if (d == den) denOk = true;
    if (! denOk) return errResult ("set_time_signature", "denominator must be a power of two (1..32)");

    beginTxn ("set_time_signature");
    ts->setStringTimeSig (juce::String (num) + "/" + juce::String (den));
    logLine ("set_time_signature", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("numerator", ts->numerator.get());
    data->setProperty ("denominator", ts->denominator.get());
    return okResult ("set_time_signature", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// SES-001 — the tempo MAP. te::TempoSequence natively supports multi-point tempo
// and time-sig changes (insert/remove/toBeats/toTime; playback honors the map
// with no clip-anchoring work). Mosh inserts STEP changes only: curve = 1.0 is
// the engine's hold-then-jump form (the ramp branch in tracktion_core's
// Sequence::Section build is gated on curve != +-1.0). Bezier ramps + audio warp
// are deliberately deferred. set_tempo / set_time_signature keep editing point 0.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdInsertTempoChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const double time = (double) args.getProperty ("time", -1.0);
    if (time < 0.0) return errResult ("insert_tempo_change", "missing/negative 'time'");
    const double bpm = (double) args.getProperty ("bpm", 0.0);
    if (bpm < 20.0 || bpm > 999.0) return errResult ("insert_tempo_change", "bpm must be 20..999");

    // Optional curve: shapes the ramp FROM the PREVIOUS point TO this one is NOT how
    // the engine models it — curve lives on the setting that STARTS a span (this
    // setting's curve shapes the ramp from HERE to the NEXT point). 1.0 (default) =
    // step (hold-then-jump); values in (-1, 1) ramp: <0 log, 0 linear, >0 exponential.
    const double curve = juce::jlimit (-1.0, 1.0, (double) args.getProperty ("curve", 1.0));

    beginTxn ("insert_tempo_change");
    auto setting = edit.tempoSequence.insertTempo (tracktion::TimePosition::fromSeconds (time));
    if (setting == nullptr) return errResult ("insert_tempo_change", "insertTempo failed");
    setting->setBpm (bpm);
    setting->setCurve ((float) curve);

    logLine ("insert_tempo_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("time", setting->getStartTime().inSeconds());
    data->setProperty ("bpm", setting->getBpm());
    data->setProperty ("curve", (double) setting->getCurve());
    data->setProperty ("count", edit.tempoSequence.getNumTempos());
    return okResult ("insert_tempo_change", var (data));
}

juce::var MoshOps::cmdSetTempoCurve (const juce::var& args)
{
    auto& edit = eng.edit();
    const int index = (int) args.getProperty ("index", -1);
    if (index < 0 || index >= edit.tempoSequence.getNumTempos())
        return errResult ("set_tempo_curve", "index must be 0..numTempos-1");
    if (! args.hasProperty ("curve"))
        return errResult ("set_tempo_curve", "missing 'curve'");
    const double curve = juce::jlimit (-1.0, 1.0, (double) args.getProperty ("curve", 1.0));

    // The curve on point N shapes the span FROM point N TO point N+1 (the engine's
    // Section build gates the ramp subdivision on currTempo.curve != +-1).
    beginTxn ("set_tempo_curve");
    edit.tempoSequence.getTempo (index)->setCurve ((float) curve);
    logLine ("set_tempo_curve", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("index", index);
    data->setProperty ("curve", curve);
    return okResult ("set_tempo_curve", var (data));
}

juce::var MoshOps::cmdRemoveTempoChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const int index = (int) args.getProperty ("index", -1);
    // Index 0 is the edit's base tempo (the engine requires a first setting; it is
    // edited via set_tempo, never removed).
    if (index <= 0 || index >= edit.tempoSequence.getNumTempos())
        return errResult ("remove_tempo_change", "index must be 1..numTempos-1");

    beginTxn ("remove_tempo_change");
    // remapEdit=false: Mosh's command surface is seconds-anchored, so removing a
    // tempo point must not shift clip positions.
    edit.tempoSequence.removeTempo (index, false);
    logLine ("remove_tempo_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("count", edit.tempoSequence.getNumTempos());
    return okResult ("remove_tempo_change", var (data));
}

juce::var MoshOps::cmdInsertTimeSigChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const double time = (double) args.getProperty ("time", -1.0);
    if (time < 0.0) return errResult ("insert_time_sig_change", "missing/negative 'time'");
    const int num = juce::jlimit (1, 32, (int) args.getProperty ("numerator", 4));
    const int den = (int) args.getProperty ("denominator", 4);
    static const int validDen[] = { 1, 2, 4, 8, 16, 32 };
    bool denOk = false;
    for (int d : validDen) if (d == den) denOk = true;
    if (! denOk) return errResult ("insert_time_sig_change", "denominator must be a power of two (1..32)");

    beginTxn ("insert_time_sig_change");
    auto setting = edit.tempoSequence.insertTimeSig (tracktion::TimePosition::fromSeconds (time));
    if (setting == nullptr) return errResult ("insert_time_sig_change", "insertTimeSig failed");
    setting->setStringTimeSig (juce::String (num) + "/" + juce::String (den));

    logLine ("insert_time_sig_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("numerator", setting->numerator.get());
    data->setProperty ("denominator", setting->denominator.get());
    data->setProperty ("count", edit.tempoSequence.getNumTimeSigs());
    return okResult ("insert_time_sig_change", var (data));
}

juce::var MoshOps::cmdRemoveTimeSigChange (const juce::var& args)
{
    auto& edit = eng.edit();
    const int index = (int) args.getProperty ("index", -1);
    if (index <= 0 || index >= edit.tempoSequence.getNumTimeSigs())
        return errResult ("remove_time_sig_change", "index must be 1..numTimeSigs-1");

    beginTxn ("remove_time_sig_change");
    edit.tempoSequence.removeTimeSig (index);
    logLine ("remove_time_sig_change", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("count", edit.tempoSequence.getNumTimeSigs());
    return okResult ("remove_time_sig_change", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// CAP-TRN-005 — the metronome's SOUND, LEVEL and ROUTING.
//
// All of it is tracktion_engine's own click-track surface (resolved signatures in
// docs/ENGINE_API_NOTES.md § "Metronome / click track"); Mosh invents no parallel
// model. There are two storage homes and the split is the ENGINE's, not ours:
//
//   PER-EDIT — te::Edit's own CLICKTRACK child, so it saves/reloads with the
//     .tracktionedit: enabled, level, emphasizeBars, recordingOnly, outputDevice.
//   APP-GLOBAL — te::PropertyStorage, reached through the te::Click free functions:
//     the two click SAMPLES and the two MIDI click NOTES. The engine has no
//     per-Edit home for these at all — they are a machine preference, like the
//     audio device — so mirroring them onto MOSH_PROJECT the way REC-001 mirrors
//     the record options would be inventing a second source of truth for no gain
//     (REC-001's reason was that its engine homes are UNREACHABLE headless;
//     PropertyStorage is reachable and durable in every mode).
//
// Still a NON-UNDOABLE PREFERENCE, and now by construction as well as by policy:
// Edit::initialiseClickTrack binds every one of those CachedValues with a NULLPTR
// UndoManager, so a beginTxn here could only ever push an EMPTY transaction — the
// G14 class, where the next undo destroys the PREVIOUS real edit. No transaction,
// logLine(..., false), snapshot_invalidated. Works headless.
//
// Partial patch (cmdSetProjectSettings' template): every arg is optional, an absent
// one is left untouched, and EVERYTHING is validated before ANYTHING is written so
// a rejected field leaves the whole setting as it was.
// ─────────────────────────────────────────────────────────────────────────────

namespace
{
    // te::Edit::getClickTrackVolume() re-clamps on every READ and setClickTrackVolume
    // clamps on write, both to [0.2, 1.0] — so the click has a FLOOR: 0 is not silence.
    // The snapshot carries these two numbers so the UI can draw the range the engine
    // actually honours instead of a 0..1 slider whose bottom fifth does nothing.
    constexpr double kClickLevelMin = 0.2;
    constexpr double kClickLevelMax = 1.0;

    // The engine's click loader is juce::WavAudioFormat DIRECTLY (loadWavDataIntoMemory
    // in tracktion_ClickNode.cpp), not the format manager — anything else reads as an
    // empty buffer and SILENTLY falls back to the built-in click. Rejecting here is the
    // difference between "that file is not a WAV" and a setting that looks applied but
    // is not.
    bool isClickWavFile (const juce::File& f)
    {
        return f.existsAsFile() && f.getFileExtension().equalsIgnoreCase (".wav");
    }
}

juce::var MoshOps::clickSettingsToVar()
{
    auto& edit = eng.edit();
    auto& engine = eng.engine();

    auto* o = new DynamicObject();
    o->setProperty ("enabled", edit.clickTrackEnabled.get());
    o->setProperty ("level", (double) edit.getClickTrackVolume());
    o->setProperty ("levelMin", kClickLevelMin);
    o->setProperty ("levelMax", kClickLevelMax);
    o->setProperty ("emphasizeBars", edit.clickTrackEmphasiseBars.get());
    o->setProperty ("recordingOnly", edit.clickTrackRecordingOnly.get());

    // Stored INTENT and what the engine will actually use, as two fields — because they
    // genuinely differ. te::Edit::clickTrackDevice is private, so the intent is read
    // straight off the CLICKTRACK child it is bound to, and it HAS to be read that way:
    // getClickTrackDevice() normalises any name it cannot resolve to "(default audio
    // output)", so headless — where there are no output devices at all — every stored
    // routing would read back as the default and look exactly like it never persisted.
    const auto clickTree = edit.state.getChildWithName (te::IDs::CLICKTRACK);
    o->setProperty ("outputDevice", clickTree.getProperty (te::IDs::outputDevice, "").toString());
    o->setProperty ("outputDeviceResolved", edit.getClickTrackDevice());
    o->setProperty ("defaultOutputDevice", te::DeviceManager::getDefaultAudioOutDeviceName (false));

    // "" ⇒ the engine's built-in bigclick/littleclick binary data.
    o->setProperty ("soundBig", te::Click::getClickWaveFile (engine, true));
    o->setProperty ("soundSmall", te::Click::getClickWaveFile (engine, false));
    // Only audible when the click is ROUTED to a MIDI output (ClickGenerator's midi
    // branch); on an audio out they are inert, which is why the UI reveals them only
    // once a MIDI destination is chosen.
    o->setProperty ("midiNoteBig", te::Click::getMidiClickNote (engine, true));
    o->setProperty ("midiNoteSmall", te::Click::getMidiClickNote (engine, false));
    return var (o);
}

juce::var MoshOps::cmdSetMetronome (const juce::var& args)
{
    auto& edit = eng.edit();
    auto& engine = eng.engine();

    // ── validate every supplied field BEFORE writing any of them ──
    if (args.hasProperty ("level"))
    {
        const double lv = (double) args.getProperty ("level", -1.0);
        if (lv < 0.0 || lv > 1.0)
            return errResult ("set_metronome", "level must be a linear gain in 0..1 "
                                               "(the engine clamps it to 0.2..1.0)");
    }
    if (args.hasProperty ("midiNoteBig"))
    {
        const int n = (int) args.getProperty ("midiNoteBig", -1);
        if (n < 0 || n > 127) return errResult ("set_metronome", "midiNoteBig must be 0..127");
    }
    if (args.hasProperty ("midiNoteSmall"))
    {
        const int n = (int) args.getProperty ("midiNoteSmall", -1);
        if (n < 0 || n > 127) return errResult ("set_metronome", "midiNoteSmall must be 0..127");
    }

    // "" resets to the engine's built-in click; anything else must be a real .wav.
    juce::String soundBig, soundSmall;
    if (args.hasProperty ("soundBig"))
    {
        soundBig = args.getProperty ("soundBig", var()).toString().trim();
        if (soundBig.isNotEmpty() && ! isClickWavFile (juce::File (soundBig)))
            return errResult ("set_metronome", "soundBig must be an existing .wav file (or \"\" to "
                                               "restore the built-in click): " + soundBig);
    }
    if (args.hasProperty ("soundSmall"))
    {
        soundSmall = args.getProperty ("soundSmall", var()).toString().trim();
        if (soundSmall.isNotEmpty() && ! isClickWavFile (juce::File (soundSmall)))
            return errResult ("set_metronome", "soundSmall must be an existing .wav file (or \"\" to "
                                               "restore the built-in click): " + soundSmall);
    }

    const auto defaultOut = te::DeviceManager::getDefaultAudioOutDeviceName (false);
    juce::String outputDevice;
    if (args.hasProperty ("outputDevice"))
    {
        outputDevice = args.getProperty ("outputDevice", var()).toString().trim();
        if (outputDevice.isEmpty() || outputDevice == "default")
            outputDevice = defaultOut;

        // With a live device manager the name must resolve; headless the output list is
        // empty, so accept it as persisted intent (cmdSetTrackOutput's posture exactly) —
        // the graph resolves it when audio is up, and outputDeviceResolved in the snapshot
        // shows what will really be used meanwhile.
        if (eng.hasAudio()
            && outputDevice != defaultOut
            && outputDevice != te::DeviceManager::getDefaultMidiOutDeviceName (false)
            && engine.getDeviceManager().findOutputDeviceWithName (outputDevice) == nullptr)
            return errResult ("set_metronome", "unknown click output device: " + outputDevice);
    }

    // Everything below is optional, so a call naming NOTHING we understand is a typo,
    // not a no-op. (It used to be "turn the click off", because `enabled` defaulted to
    // false — the one behaviour a partial patch cannot keep.)
    const bool touchesEdit = args.hasProperty ("enabled") || args.hasProperty ("level")
                          || args.hasProperty ("emphasizeBars") || args.hasProperty ("recordingOnly")
                          || args.hasProperty ("outputDevice");
    const bool touchesGlobal = args.hasProperty ("soundBig") || args.hasProperty ("soundSmall")
                            || args.hasProperty ("midiNoteBig") || args.hasProperty ("midiNoteSmall");
    if (! touchesEdit && ! touchesGlobal)
        return errResult ("set_metronome", "expected at least one of: enabled, level, emphasizeBars, "
                                           "recordingOnly, outputDevice, soundBig, soundSmall, "
                                           "midiNoteBig, midiNoteSmall");

    // ── apply ──
    if (args.hasProperty ("enabled"))       edit.clickTrackEnabled       = (bool) args.getProperty ("enabled", false);
    if (args.hasProperty ("emphasizeBars")) edit.clickTrackEmphasiseBars = (bool) args.getProperty ("emphasizeBars", false);
    if (args.hasProperty ("recordingOnly")) edit.clickTrackRecordingOnly = (bool) args.getProperty ("recordingOnly", false);
    if (args.hasProperty ("level"))         edit.setClickTrackVolume ((float) (double) args.getProperty ("level", 1.0));
    if (args.hasProperty ("outputDevice"))  edit.setClickTrackOutput (outputDevice);
    if (args.hasProperty ("soundBig"))      te::Click::setClickWaveFile (engine, true,  soundBig);
    if (args.hasProperty ("soundSmall"))    te::Click::setClickWaveFile (engine, false, soundSmall);
    if (args.hasProperty ("midiNoteBig"))   te::Click::setMidiClickNote (engine, true,  (int) args.getProperty ("midiNoteBig", 37));
    if (args.hasProperty ("midiNoteSmall")) te::Click::setMidiClickNote (engine, false, (int) args.getProperty ("midiNoteSmall", 76));

    // The CLICKTRACK child lives in the Edit tree, so a per-Edit field really does need a
    // re-save. The app-global half does not (PropertyStorage writes itself).
    if (touchesEdit)
        eng.markDirty();

    logLine ("set_metronome", args, true, {}, false);
    emitSnapshotInvalidated();

    auto data = clickSettingsToVar();
    // `metronome` stays in the result next to the full block: it is the field every
    // existing consumer already reads, and renaming it would be churn for nothing.
    if (auto* o = data.getDynamicObject())
        o->setProperty ("metronome", edit.clickTrackEnabled.get());
    return okResult ("set_metronome", data);
}

// KEY-001 — the musical-key domains. These MUST stay byte-identical to the literal
// arrays in ui/src/vendor/voice.js (NOTE_PC keys + SCALES keys); Moshi's voice snaps
// every earcon to (tonic, mode), so a mismatch would make the host accept a key the
// voice cannot sing. Validated by cmdSetKey; the snapshot defaults below match the
// voice's neutral start (A4 tonic + SCALES.minor).
namespace
{
    // voice.js NOTE_PC keys (enharmonic spellings included), in declaration order.
    const char* const kNotePcNames[] = {
        "C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb",
        "G", "G#", "Ab", "A", "A#", "Bb", "B"
    };
    // voice.js SCALES keys.
    const char* const kScaleNames[] = {
        "major", "minor", "dorian", "mixolydian", "pentatonic", "chromatic"
    };

    bool isValidTonic (const juce::String& t)
    {
        for (auto* n : kNotePcNames) if (t == n) return true;
        return false;
    }
    bool isValidMode (const juce::String& m)
    {
        for (auto* n : kScaleNames) if (m == n) return true;
        return false;
    }
}

const char* const MoshOps::kDefaultKeyTonic = "A";
const char* const MoshOps::kDefaultKeyMode  = "minor";

// PRJ-008 — the MOSH_PROJECT child of the Edit's own ValueTree (mirrors the
// MOSH_RENDERLAYER parenting). Created empty on first access so it saves/reloads
// with the .tracktionedit. Pure storage accessor: no undo manager, no logging.
juce::ValueTree MoshOps::projectSettingsTree()
{
    auto state = eng.edit().state;
    auto node = state.getChildWithName (ids::MOSH_PROJECT);
    if (! node.isValid())
    {
        node = juce::ValueTree (ids::MOSH_PROJECT);
        state.appendChild (node, nullptr);   // nullptr: not an undoable edit (preference)
    }
    return node;
}

juce::var MoshOps::projectSettingsToVar()
{
    // Project INTENT where stored; live device readout as the fallback (device values
    // stay the live truth, project = intent). timeBase has no device analogue, so it
    // defaults to "seconds". NON-mutating read (snapshot() is read-only by contract):
    // getChildWithName returns an invalid tree when unset, whose hasProperty() is false,
    // so the device-fallback below handles the absent case without writing the Edit tree.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    auto& dm = eng.engine().getDeviceManager();

    double sr = dm.getSampleRate();
    if (sr < 7000.0) sr = 44100.0;
    if (node.hasProperty (ids::projectSampleRate))
        sr = (double) node.getProperty (ids::projectSampleRate);

    int bd = dm.getBitDepth();
    if (bd != 16 && bd != 24 && bd != 32) bd = 24;
    if (node.hasProperty (ids::projectBitDepth))
        bd = (int) node.getProperty (ids::projectBitDepth);

    juce::String tb = node.hasProperty (ids::timeBase)
                          ? node.getProperty (ids::timeBase).toString()
                          : juce::String ("seconds");

    // KEY-001 — the musical key, ALWAYS present so the UI never sees a missing field.
    // Default A/minor (matches voice.js's neutral A4 tonic + SCALES.minor). Stored on
    // the same MOSH_PROJECT node; falls back to the default where unset.
    juce::String tonic = node.hasProperty (ids::musicalTonic)
                             ? node.getProperty (ids::musicalTonic).toString()
                             : juce::String (kDefaultKeyTonic);
    juce::String keyMode = node.hasProperty (ids::musicalMode)
                               ? node.getProperty (ids::musicalMode).toString()
                               : juce::String (kDefaultKeyMode);

    auto* key = new DynamicObject();
    key->setProperty ("tonic", tonic);
    key->setProperty ("mode", keyMode);

    // G2b — count-in / pre-roll bars, ALWAYS present (default 0/off) so the UI
    // never sees a missing field, mirroring the key default above.
    const int countInBars = node.hasProperty (ids::countInBars)
                                ? (int) node.getProperty (ids::countInBars) : 0;

    auto* o = new DynamicObject();
    o->setProperty ("sampleRate", sr);
    o->setProperty ("bitDepth", bd);
    o->setProperty ("timeBase", tb);
    o->setProperty ("key", var (key));
    o->setProperty ("countInBars", countInBars);
    // REC-001 — how a take behaves, alongside the count-in that precedes it. Nested
    // rather than flattened so the recording panel binds one object and a sixth setting
    // later costs no snapshot-shape change.
    o->setProperty ("recordOptions", recordOptionsToVar());
    // PRJ-FMT — the stamped project format version (0 ⇒ legacy/unsaved). Lets the UI and
    // the selftest observe the on-tree stamp without reading the .tracktionedit directly.
    o->setProperty ("formatVersion", mosh::readFileVersion (eng.edit().state));
    return var (o);
}

juce::var MoshOps::cmdSetProjectSettings (const juce::var& args)
{
    // Per-project format / time-base INTENT — a producer preference (the export/
    // format default + the timeline display base), NOT a live device change. Stored
    // on a MOSH_PROJECT child of the Edit tree so it persists with the session, and
    // followed the cmdSetMetronome template exactly: no Tracktion transaction (no
    // beginNewTransaction), logLine(..., false), emitSnapshotInvalidated. Works
    // headless (no audio device required).
    //
    // Validate every supplied field before writing anything (partial patch: each
    // field is optional, but a present field that fails validation is a hard error
    // and leaves the stored settings untouched).
    if (args.hasProperty ("sampleRate"))
    {
        const double sr = (double) args.getProperty ("sampleRate", 0.0);
        if (sr < 7000.0)
            return errResult ("set_project_settings", "sampleRate must be >= 7000");
    }
    if (args.hasProperty ("bitDepth"))
    {
        const int bd = (int) args.getProperty ("bitDepth", 0);
        if (bd != 16 && bd != 24 && bd != 32)
            return errResult ("set_project_settings", "bitDepth must be one of 16, 24, 32");
    }
    if (args.hasProperty ("timeBase"))
    {
        const auto tb = args.getProperty ("timeBase", var()).toString();
        if (tb != "seconds" && tb != "barsBeats")
            return errResult ("set_project_settings", "timeBase must be 'seconds' or 'barsBeats'");
    }

    auto node = projectSettingsTree();
    if (args.hasProperty ("sampleRate"))
        node.setProperty (ids::projectSampleRate, (double) args.getProperty ("sampleRate", 0.0), nullptr);
    if (args.hasProperty ("bitDepth"))
        node.setProperty (ids::projectBitDepth, (int) args.getProperty ("bitDepth", 0), nullptr);
    if (args.hasProperty ("timeBase"))
        node.setProperty (ids::timeBase, args.getProperty ("timeBase", var()).toString(), nullptr);

    eng.markDirty();                                           // edit-state change → needs re-save (gap 1)
    logLine ("set_project_settings", args, true, {}, false);   // preference — NOT undoable
    emitSnapshotInvalidated();
    return okResult ("set_project_settings", projectSettingsToVar());
}

juce::var MoshOps::cmdSetKey (const juce::var& args)
{
    // KEY-001 — the project's musical key (tonic + mode). Producer INTENT, stored on
    // the same MOSH_PROJECT node as the format/time-base prefs, so it saves/reloads
    // with the .tracktionedit. Followed the cmdSetProjectSettings template exactly:
    // validate-then-write, NO Tracktion transaction (no beginNewTransaction),
    // logLine(..., false) → NON-undoable preference, emitSnapshotInvalidated. Works
    // headless (no audio device required).
    //
    // Validate against the voice.js NOTE_PC / SCALES domains BEFORE writing anything
    // (a present-but-invalid field is a hard error that leaves storage untouched).
    if (args.hasProperty ("tonic"))
    {
        const auto tonic = args.getProperty ("tonic", var()).toString();
        if (! isValidTonic (tonic))
            return errResult ("set_key", "tonic must be one of the voice.js NOTE_PC names (C..B incl. enharmonics)");
    }
    if (args.hasProperty ("mode"))
    {
        const auto m = args.getProperty ("mode", var()).toString();
        if (! isValidMode (m))
            return errResult ("set_key", "mode must be one of the voice.js SCALES (major|minor|dorian|mixolydian|pentatonic|chromatic)");
    }

    auto node = projectSettingsTree();
    if (args.hasProperty ("tonic"))
        node.setProperty (ids::musicalTonic, args.getProperty ("tonic", var()).toString(), nullptr);
    if (args.hasProperty ("mode"))
        node.setProperty (ids::musicalMode, args.getProperty ("mode", var()).toString(), nullptr);

    eng.markDirty();                              // edit-state change → needs re-save (gap 1)
    logLine ("set_key", args, true, {}, false);   // preference — NOT undoable
    emitSnapshotInvalidated();
    return okResult ("set_key", projectSettingsToVar());
}

// G2b — count-in / pre-roll bars. te::Edit::CountIn's none/oneBar/twoBar values
// are 0/1/2 — exactly mosh::countin's {0,1,2} bars domain — so a validated bars
// value casts straight across with no lookup table. Asserted here (rather than in
// the engine-free state/CountIn.h) because only this translation unit can see the
// real tracktion_engine enum.
static_assert (static_cast<int> (te::Edit::CountIn::none)   == 0
            && static_cast<int> (te::Edit::CountIn::oneBar) == 1
            && static_cast<int> (te::Edit::CountIn::twoBar) == 2,
               "mosh::countin's {0,1,2} bars domain assumes te::Edit::CountIn's "
               "none/oneBar/twoBar == 0/1/2 — update the cast in applyCountInToEdit "
               "if tracktion_engine ever renumbers this enum");

void MoshOps::applyCountInToEdit()
{
    // Re-applies the STORED preference to the LIVE Edit's real pre-roll every time
    // it's called (cmdSetCountIn, and cmdSetTransport's "record" branch) rather
    // than only at load time — so recording always honors the CURRENT project
    // setting regardless of when/how the Edit was loaded. Cheap (writes engine
    // property storage; no audio device needed) and safe headless.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    const int bars = node.hasProperty (ids::countInBars) ? (int) node.getProperty (ids::countInBars) : 0;
    const int clamped = mosh::countin::isValidBars (bars) ? bars : 0;   // defensive: never feed the engine a bad value
    eng.edit().setCountInMode (static_cast<te::Edit::CountIn> (clamped));
}

juce::var MoshOps::cmdSetCountIn (const juce::var& args)
{
    // G2b — count-in / pre-roll bars before recording. Producer INTENT, stored on
    // the same MOSH_PROJECT node as timeBase/key, following the cmdSetKey template
    // exactly: validate-then-write, NO Tracktion transaction (no
    // beginNewTransaction), logLine(..., false) → NON-undoable preference,
    // emitSnapshotInvalidated. Works headless (no audio device required).
    //
    // ENGINE-WIRED, not just stored: applyCountInToEdit() below pushes the value
    // straight into tracktion_engine's own pre-roll (te::Edit::setCountInMode),
    // which TransportControl's record-start logic already consults
    // (Edit::getNumCountInBeats()) to roll the playhead back N beats and play an
    // audible click through the pre-roll before capture actually begins — see
    // tracktion_TransportControl.cpp's performRecord. No new recording machinery was
    // needed; Mosh just exposes + persists the setting the engine already honors.
    if (! args.hasProperty ("bars"))
        return errResult ("set_count_in", "bars is required");

    const int bars = (int) args.getProperty ("bars", 0);
    if (! mosh::countin::isValidBars (bars))
        return errResult ("set_count_in", mosh::countin::validationError());

    auto node = projectSettingsTree();
    node.setProperty (ids::countInBars, bars, nullptr);
    applyCountInToEdit();                                  // immediate effect this session

    eng.markDirty();                                        // edit-state change → needs re-save (gap 1)
    logLine ("set_count_in", args, true, {}, false);        // preference — NOT undoable
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("countInBars", bars);
    return okResult ("set_count_in", var (data));
}

} // namespace mosh
