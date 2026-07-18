#include "MoshEngine.h"
#include "SessionPaths.h"
#include "SourceRef.h"
#include "state/Migrations.h"

namespace mosh
{
namespace
{
    // Lets us suppress the engine's automatic audio-device init (the te::Engine
    // ctor calls Engine::initialise() → DeviceManager::initialise(), which opens
    // CoreAudio). Headless/no-audio runs return false so construction never
    // blocks on the audio HAL.
    struct MoshEngineBehaviour : te::EngineBehaviour
    {
        bool audio;
        explicit MoshEngineBehaviour (bool a) : audio (a) {}
        bool autoInitialiseDeviceManager() override { return audio; }
        // No audio → don't enumerate audio I/O device types (avoids the macOS
        // mic-permission prompt on headless/no-audio launches).
        bool addSystemAudioIODeviceTypes() override { return audio; }

        // PRF-001 — the ONE knob Tracktion's parallel audio graph reads. The engine
        // applies setNumThreads(getNumberOfCPUsToUseForAudio() - 1) in EditPlaybackContext
        // (live) and NodeRenderContext (offline), so this is a genuine, load-bearing
        // preference, NOT a dead toggle. 0 == auto (all cores, the engine default);
        // a positive value clamps to [1..getNumCpus()]. UI value 1 => 0 workers =>
        // single-threaded. Read on the message thread during context build AND under
        // the audio-callback lock by DeviceManager::updateNumCPUs(), so it is atomic.
        std::atomic<int> audioThreads { 0 };
        int getNumberOfCPUsToUseForAudio() override
        {
            const int n = audioThreads.load (std::memory_order_relaxed);
            const int cores = juce::jmax (1, juce::SystemStats::getNumCpus());
            return n > 0 ? juce::jlimit (1, cores, n) : cores;
        }

        // The internal master-bus spectral tap (xmlTypeName moshMasterSpectralTap,
        // see MoshOps::ensureMasterSpectralTap/isInternalMasterPlugin) occupies ONE
        // master-plugin slot invisibly — masterVisibleBoundary() hides it from
        // master.plugins entirely, but Tracktion's PluginList::insertPlugin still
        // counts it against te::EditLimits::maxNumMasterPlugins (default 4). Without
        // this override, once the tap exists (created lazily the first time
        // transport plays, via emitSpectrum), the user's effective VISIBLE budget
        // silently drops from 4 to 3: the 4th load_master_plugin/load_master_builtin
        // hits PluginList::insertPlugin's `numPlugins >= limits.maxNumMasterPlugins`
        // guard and returns an empty Ptr — a SILENT no-op Tracktion gives no error
        // for, which cmdLoadMasterPlugin/cmdLoadMasterBuiltin didn't check either
        // (see the belt-and-suspenders fix there). +1 keeps the full 4-plugin
        // visible budget regardless of whether the tap has been created yet.
        te::EditLimits getEditLimits() override
        {
            auto limits = te::EngineBehaviour::getEditLimits();
            limits.maxNumMasterPlugins += 1;
            return limits;
        }
    };
}

MoshEngine::MoshEngine (bool openAudioDevice, bool freshSession, const juce::String& freshSessionName)
{
    audioOpen = openAudioDevice
                && ! juce::SystemStats::getEnvironmentVariable ("MOSH_NO_AUDIO", {}).isNotEmpty();

    // 3-arg construction so we can disable auto device-init in no-audio mode
    // (the device opens during the Engine ctor otherwise — 01 §5).
    // te::Engine takes ownership of the behaviour unique_ptr; capture the raw
    // pointer FIRST (PRF-001) so we can mutate its audioThreads atomic later.
    // The Engine outlives every mutation, so this borrowed pointer stays valid.
    auto behaviour = std::make_unique<MoshEngineBehaviour> (audioOpen);
    behaviourPtr = behaviour.get();
    enginePtr = std::make_unique<te::Engine> (
        juce::String ("Mosh"),
        std::make_unique<te::UIBehaviour>(),
        std::move (behaviour));

    // Session directory: a stable per-app-data folder so save/reload round-trips.
    // Each harness run gets its own dir so it can't be polluted by (or clobber) a real
    // GUI session, or another concurrent harness — see freshSession below. Established
    // BEFORE the device init so PRE-001 can restore the persisted device setup from it.
    // freshSessionName is a BASE leaf ("session-selftest", ...); empty means the GUI.
    // resolveSessionLeaf applies the MOSH_SELFTEST_SESSION override (explicit always wins
    // verbatim — gate.sh/verify.py read artifacts back out of that exact path) and otherwise
    // auto-isolates headless runs per process, so two concurrent harnesses can no longer
    // wipe each other's session dir mid-test. See src/engine/SessionPaths.h.
    const auto sessionLeaf = mosh::sessionpaths::resolveSessionLeaf (
        freshSessionName,
        juce::SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {}),
        mosh::sessionpaths::processTag());
    const auto moshDir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                             .getChildFile ("Mosh");
    session = moshDir.getChildFile (sessionLeaf);
    // Fail-closed: a cold-start wipe must NEVER land on the owner's GUI project. Nothing
    // should route "session" here with freshSession set, but this is a data-loss class —
    // guard it rather than trust every caller.
    if (freshSession && sessionLeaf != "session")
        session.deleteRecursively();
    else if (freshSession)
        DBG ("MoshEngine: refusing to wipe the GUI \"session\" dir");
    session.createDirectory();
    if (mosh::sessionpaths::isAutoIsolatedLeaf (sessionLeaf))
        mosh::sessionpaths::publishLatestPointer (moshDir, freshSessionName, session);
    session.getChildFile ("audio").createDirectory();
    // A2 — latch the prior session's liveness sentinel BEFORE this run overwrites it. Present
    // ⇒ the last GUI session didn't shut down cleanly (crashed). Wiped freshSession dirs
    // (headless harnesses) never have it, so they always read clean.
    uncleanAtStartup = session.getChildFile ("session.running").existsAsFile();
    // gap 2 — reopen the last project on relaunch (GUI path). The harness keeps the fixed
    // session file: a freshSession dir is wiped above, so last-project.json never exists
    // there and startupEditFile() would fall back anyway — we short-circuit it explicitly.
    editPath = freshSession ? session.getChildFile ("session.tracktionedit")
                            : startupEditFile();

    applyRequestedAudioOutputDevice();

    // The harness saves + reloads internally; wipe any prior run's persisted edit
    // so it always starts cold and is idempotent across repeated --selftest runs.
    if (freshSession)
        editPath.deleteFile();

    bool loadedFromFile = false;
    if (editPath.existsAsFile())
    {
        // Persisted session: load it (tracks/clips/RenderLayers come back).
        editPtr = te::loadEditFromFile (*enginePtr, editPath);
        // PRJ-FMT — gate BEFORE the engine uses the Edit (before wireEditResolvers).
        auto mr = mosh::migrateOrRefuse (editPtr->state);
        if (mr.ok)
            loadedFromFile = true;
        else
        {
            // Refused: a newer-format file. Fall through to a SAFE empty Edit, record the
            // reason (surfaced via snapshot.session.loadError), and DON'T persist over the
            // newer file — save() is a no-op while loadError is set.
            loadError = mr.error;
            editPtr.reset();
        }
    }

    if (! loadedFromFile)
    {
        // Fresh session (or a refused newer-format file). createEmptyEdit seeds a default
        // audio track; Mosh starts empty so every track is an explicit create_track command
        // (clean undo + gate semantics).
        editPtr = te::createEmptyEdit (*enginePtr, editPath);
        juce::Array<te::AudioTrack*> defaults (te::getAudioTracks (*editPtr));
        for (auto* t : defaults)
            editPtr->deleteTrack (t);

        editPtr->getSceneList();

        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

        editPtr->getUndoManager().clearUndoHistory();
    }
    wireEditResolvers();
}

MoshEngine::~MoshEngine()
{
    if (editPtr != nullptr)
        editPtr->getTransport().stop (false, false);
    editPtr.reset();
    enginePtr.reset();
}

void MoshEngine::ensurePlaybackContext()
{
    if (! audioOpen)
        return;

    edit().getTransport().ensureContextAllocated();

    // One-time: enable the device manager's wave inputs so record-armed tracks
    // actually capture (without setEnabled(true) they exist but stay silent). Never
    // runs headless — guarded by audioOpen — and runs once via the latch. We default
    // monitor mode to automatic (audible only when record-enabled) per RecordingDemo.
    if (! inputsConfigured)
    {
        inputsConfigured = true;
        auto& dm = enginePtr->getDeviceManager();
        for (int i = 0; i < dm.getNumWaveInDevices(); ++i)
            if (auto* wip = dm.getWaveInDevice (i))
            {
                wip->setMonitorMode (te::InputDevice::MonitorMode::automatic);
                wip->setEnabled (true);
            }

        // ── Live MIDI inputs (CTL-001) ──────────────────────────────────────
        // Enable every physical/virtual MIDI input so a controller can drive an
        // ARMED instrument track live (exactly the wave path, just the MIDI device
        // family). Monitor=automatic matches the wave default: the synth only sounds
        // when the track is armed (isLivePlayEnabled() == acceptsInput AND a dest
        // targets the track AND (monitor==on OR (automatic AND recordEnabled))).
        // setEnabled defaults true on the device ctor but loadMidiProps can override
        // it from saved per-device engine props, so we set it unconditionally (a
        // global engine pref via saveProps — correctly NON-undoable, like the wave
        // path). This is the canonical MidiRecordingDemo enable-then-target sequence.
        for (auto& mi : dm.getMidiInDevices())
            if (mi != nullptr)
            {
                mi->setMonitorMode (te::InputDevice::MonitorMode::automatic);
                mi->setEnabled (true);
            }

        // setEnabled(true) on a MIDI device calls dm.rescanMidiDeviceList() which is
        // ASYNC (startTimer(5) -> timerCallback -> applyNewMidiDeviceList). Pump the
        // message loop briefly so the rescan applies and EditPlaybackContext rebuilds
        // its device list BEFORE restartPlayback(), otherwise the new MIDI instances
        // would not yet appear in getAllInputDevices() and the route would race.
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (30);

        edit().restartPlayback();
    }
}

void MoshEngine::applyRequestedAudioOutputDevice()
{
    if (! audioOpen)
        return;

    // PRE-001 — restore the persisted device setup (written by set_audio_device /
    // set_buffer_size into the session dir) BEFORE the env-var fallback, so a saved
    // device choice survives an app restart. The env vars below still override it
    // (they are an explicit per-launch request). Missing/invalid XML is a no-op.
    // NB: Mosh disables Tracktion's autoInitialiseDeviceManager and manages the device
    // itself, so this raw JUCE initialise() is the single active restore (there is no
    // competing Tracktion PropertyStorage auto-apply here). It deliberately accepts
    // skipping te::DeviceManager::loadSettings()'s extra channel-enable / defaultWaveID
    // restore; full cross-restart fidelity is hardware-gated and verified on a real device.
    if (auto deviceXmlFile = session.getChildFile ("audio-device.xml"); deviceXmlFile.existsAsFile())
        if (auto deviceXml = juce::XmlDocument::parse (deviceXmlFile))
            enginePtr->getDeviceManager().deviceManager.initialise (256, 256, deviceXml.get(), true);

    const auto requested = juce::SystemStats::getEnvironmentVariable ("MOSH_AUDIO_OUTPUT_DEVICE", {}).trim();
    const auto requestedInput = juce::SystemStats::getEnvironmentVariable ("MOSH_AUDIO_INPUT_DEVICE", {}).trim();
    if (requested.isEmpty() && requestedInput.isEmpty())
        return;

    auto& tracktionDevices = enginePtr->getDeviceManager();
    auto& devices = tracktionDevices.deviceManager;

    juce::String matchedType;
    juce::String matchedOutput;
    juce::String matchedInput;
    for (auto* type : devices.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        if (requested.isNotEmpty())
        {
            auto outputs = type->getDeviceNames (false);
            auto index = outputs.indexOf (requested);
            if (index < 0)
            {
                for (int i = 0; i < outputs.size(); ++i)
                    if (outputs[i].equalsIgnoreCase (requested))
                    {
                        index = i;
                        break;
                    }
            }
            if (index >= 0)
            {
                matchedType = type->getTypeName();
                matchedOutput = outputs[index];
            }
        }

        if (requestedInput.isNotEmpty())
        {
            auto inputs = type->getDeviceNames (true);
            auto index = inputs.indexOf (requestedInput);
            if (index < 0)
            {
                for (int i = 0; i < inputs.size(); ++i)
                    if (inputs[i].equalsIgnoreCase (requestedInput))
                    {
                        index = i;
                        break;
                    }
            }
            if (index >= 0)
            {
                if (matchedType.isEmpty())
                    matchedType = type->getTypeName();
                if (matchedType == type->getTypeName())
                    matchedInput = inputs[index];
            }
        }

        if ((requested.isEmpty() || matchedOutput.isNotEmpty())
            && (requestedInput.isEmpty() || matchedInput.isNotEmpty()))
            break;
    }

    if (requested.isNotEmpty() && matchedOutput.isEmpty())
    {
        audioError = "Requested audio output device not found: " + requested;
        DBG (audioError);
        return;
    }
    if (requestedInput.isNotEmpty() && matchedInput.isEmpty())
    {
        audioError = "Requested audio input device not found: " + requestedInput;
        DBG (audioError);
        return;
    }

    auto setup = devices.getAudioDeviceSetup();
    devices.setCurrentAudioDeviceType (matchedType, true);
    if (matchedOutput.isNotEmpty())
        setup.outputDeviceName = matchedOutput;
    setup.inputDeviceName = matchedInput;
    setup.inputChannels.clear();
    setup.useDefaultInputChannels = matchedInput.isNotEmpty();
    setup.useDefaultOutputChannels = true;

    if (auto error = devices.setAudioDeviceSetup (setup, true); error.isNotEmpty())
    {
        audioError = "Could not open requested audio output device '" + matchedOutput + "': " + error;
        DBG (audioError);
        return;
    }

    tracktionDevices.rescanWaveDeviceList();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (50);
}

juce::File MoshEngine::generateTestTone (double seconds, double freqHz, const juce::String& name)
{
    auto file = session.getChildFile ("audio")
                    .getChildFile (name.isEmpty() ? "tone" : name)
                    .withFileExtension ("wav");
    file.deleteFile();

    const double sampleRate = 44100.0;
    const int    numSamples = (int) (seconds * sampleRate);
    const int    numChannels = 2;

    juce::AudioBuffer<float> buffer (numChannels, numSamples);
    const double inc = juce::MathConstants<double>::twoPi * freqHz / sampleRate;
    double phase = 0.0;
    for (int i = 0; i < numSamples; ++i)
    {
        // Gentle fade in/out so loops don't click.
        const double env = juce::jmin (1.0, juce::jmin (i, numSamples - i) / (0.01 * sampleRate));
        const auto s = (float) (std::sin (phase) * 0.25 * env);
        buffer.setSample (0, i, s);
        buffer.setSample (1, i, s);
        phase += inc;
    }

    juce::WavAudioFormat wav;
    if (auto out = std::unique_ptr<juce::FileOutputStream> (file.createOutputStream()))
    {
        if (auto writer = std::unique_ptr<juce::AudioFormatWriter> (
                wav.createWriterFor (out.get(), sampleRate, (unsigned) numChannels, 24, {}, 0)))
        {
            out.release();                          // writer owns the stream now
            writer->writeFromAudioSampleBuffer (buffer, 0, numSamples);
        }
    }
    return file;
}

// PRJ-FMT — stamp the current project format version on the MOSH_PROJECT node so on-disk
// files are always current. Written without the undo manager (a format stamp, like the
// other MOSH_PROJECT preferences). Idempotent.
void MoshEngine::stampFormatVersion()
{
    mosh::stampFormatVersion (editPtr->state);
}

bool MoshEngine::save()
{
    // PRJ-FMT — a refused (newer-format) project is loaded READ-ONLY: never overwrite the
    // newer file on disk with this build's fallback/empty Edit. Saving resumes only once a
    // different project is loaded (which clears loadError).
    if (loadError.isNotEmpty())
        return false;

    stampFormatVersion();                  // PRJ-FMT — always current on disk
    const bool ok = te::EditFileOperations (edit()).save (false, true, false);
    if (ok)
    {
        dirty = false;                     // on-disk now matches in-memory (gap 1)
        // A3 — the saved Edit now supersedes the crash-recovery journal's unsaved tail, so
        // clear it. Every save path funnels here, so this is the single truncation point.
        // (MoshOps reads the journal into memory at startup BEFORE any save, so this never
        // races recovery.) A render/replay is in progress ⇒ recover_session truncates AFTER.
        session.getChildFile ("recovery-journal.jsonl").deleteFile();
    }
    return ok;
}

// gap 1 — unsaved-changes flag. markDirty on every mutation; cleared on a successful
// save; saveIfDirty is what the GUI auto-save timer + save-on-quit call.
void MoshEngine::markDirty() { dirty = true; }
bool MoshEngine::isDirty() const { return dirty; }
bool MoshEngine::saveIfDirty() { return dirty ? save() : false; }

// A2 — liveness sentinel. Written once the GUI window is live; deleted last on a clean quit.
// Its presence at the next launch (captured by uncleanAtStartup in the ctor) means the prior
// session crashed. A plain empty file — its mere existence is the signal.
void MoshEngine::markSessionRunning()  { session.getChildFile ("session.running").create(); }
void MoshEngine::clearSessionRunning() { session.getChildFile ("session.running").deleteFile(); }

// gap 2 — reopen-last-project. last-project.json = { "last": <abs>, "recent": [<abs>…] }
// in the session dir. The recent list is newest-first, deduped, capped at 10.
void MoshEngine::rememberProject (const juce::File& file)
{
    const auto path = file.getFullPathName();
    auto jsonFile = session.getChildFile ("last-project.json");

    juce::Array<juce::var> recent;
    recent.add (path);                                  // newest first
    if (auto prev = juce::JSON::parse (jsonFile); prev.isObject())
        if (auto* arr = prev.getProperty ("recent", juce::var()).getArray())
            for (auto& p : *arr)
                if (p.toString() != path && recent.size() < 10)
                    recent.add (p);

    auto* o = new juce::DynamicObject();
    o->setProperty ("last", path);
    o->setProperty ("recent", recent);
    jsonFile.replaceWithText (juce::JSON::toString (juce::var (o)));
}

juce::File MoshEngine::startupEditFile() const
{
    const auto fallback = session.getChildFile ("session.tracktionedit");
    if (auto j = juce::JSON::parse (session.getChildFile ("last-project.json")); j.isObject())
    {
        const auto last = j.getProperty ("last", juce::var()).toString();
        if (last.isNotEmpty() && juce::File (last).existsAsFile())
            return juce::File (last);
    }
    return fallback;
}

juce::var MoshEngine::recentProjects() const
{
    juce::Array<juce::var> out;
    if (auto j = juce::JSON::parse (session.getChildFile ("last-project.json")); j.isObject())
        if (auto* arr = j.getProperty ("recent", juce::var()).getArray())
            for (auto& p : *arr)
            {
                juce::File f (p.toString());
                if (f.existsAsFile())
                {
                    auto* e = new juce::DynamicObject();
                    e->setProperty ("path", f.getFullPathName());
                    e->setProperty ("name", f.getFileNameWithoutExtension());
                    out.add (juce::var (e));
                }
            }
    return out;
}

// gap 3 — portable audio references. Set on every (re)wire of the Edit so relative paths
// resolve against the .tracktionedit's directory and absolute (legacy / external) paths
// resolve as-is. With both this and editFileRetriever set (and the edit file on disk),
// Tracktion stores audio refs RELATIVE to the edit — the precondition for portability.
void MoshEngine::wireEditResolvers()
{
    editPtr->editFileRetriever = [this] { return editPath; };
    editPtr->filePathResolver = [this] (const juce::String& path) -> juce::File
    {
        if (juce::File::isAbsolutePath (path))
            return juce::File (path);

        // Resolve a relative ref against the edit file's directory. NOTE the asymmetry we
        // must absorb: Tracktion's setToDirectFileReference (used by relink_clip /
        // mp_commit_track / consolidateAudioInto) stores the string via
        // getRelativePathFrom(editFileRetriever()), and getRelativePathFrom treats the
        // edit *file* path as a *directory* — so it emits one extra "../" (e.g.
        // "../audio/by-hash/<sha>.wav" rather than "audio/by-hash/<sha>.wav"). Resolving
        // that against the file's parent then lands one level too high → a NON-EXISTENT
        // path → the clip reads as source-missing and the offline render HANGS
        // (RenderTask -> getNodes -> ArrangerLauncherSwitchingNode). This was the
        // "export hangs on a multiplayer-consolidated audio clip" bug. So resolve against
        // the parent first (legacy / already-correct refs), then fall back to the
        // edit-file-as-directory base (which matches how the string was computed).
        // (Aside: the WRITE side — setToDirectFileReference on an unsaved edit — trips a
        // Debug-only jassert in Tracktion's findPathFromFile; benign, fires in Debug only,
        // and is the very condition this resolver heals at read time.)
        if (auto byParent = editPath.getParentDirectory().getChildFile (path); byParent.existsAsFile())
            return byParent;
        if (auto byEditAsDir = editPath.getChildFile (path); byEditAsDir.existsAsFile())
            return byEditAsDir;
        return editPath.getParentDirectory().getChildFile (path);   // unchanged default for a genuinely-missing source
    };
}

// gap 3 — make a project self-contained: copy every referenced wave-clip source that
// isn't already inside projectDir into projectDir/audio, and re-point the clip to it with
// a RELATIVE reference (so the project dir can be moved/copied wholesale). Missing sources
// are skipped (left for relink-on-load). Called from saveProjectAs after adopt, when
// editPath is the new on-disk file so the relative reference computes correctly.
void MoshEngine::consolidateAudioInto (const juce::File& projectDir)
{
    auto audioDir = projectDir.getChildFile ("audio");
    audioDir.createDirectory();

    // Copy an external source into audio/ (de-duping by name+size) and return the
    // local destination, or {} if the source is missing / already local. Shared by
    // the wave-clip and sampler-sound passes below.
    auto localiseInto = [&] (const juce::File& src) -> juce::File
    {
        if (! src.existsAsFile() || src.isAChildOf (projectDir))
            return {};                                    // missing (relink) or already local
        auto dest = audioDir.getChildFile (src.getFileName());
        for (int n = 2; dest.existsAsFile() && dest.getSize() != src.getSize(); ++n)
            dest = audioDir.getChildFile (src.getFileNameWithoutExtension()
                                          + "_" + juce::String (n) + src.getFileExtension());
        if (! dest.existsAsFile())
            src.copyFileTo (dest);
        return dest;
    };

    for (auto* t : te::getAudioTracks (*editPtr))
    {
        if (t == nullptr) continue;

        for (auto* c : t->getClips())
            if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                if (auto dest = localiseInto (w->getCurrentSourceFile()); dest != juce::File())
                    // Re-point to a RELATIVE ref so the project dir moves/copies wholesale.
                    // The shared helper stores the path relative to the edit file's PARENT dir
                    // with portable '/' separators (a project saved on Windows must open on a
                    // friend's Mac) — matching the SamplerPlugin sounds below and the
                    // relink/commit paths, and never the edit-FILE-relative "../" form.
                    repointWaveClipSource (*w, dest, editPath.getParentDirectory(), true);

        // DRM-001 — also consolidate SamplerPlugin sounds (the bundled drum kit and any
        // assign_sample'd user files), re-pointing each to a path RELATIVE to the edit
        // so a drum project is portable wholesale. The absolute bundled-kit paths would
        // otherwise break when the project is moved to another machine/install.
        for (auto* p : t->pluginList.getPlugins())
            if (auto* s = dynamic_cast<te::SamplerPlugin*> (p))
                for (int i = 0; i < s->getNumSounds(); ++i)
                    if (auto dest = localiseInto (s->getSoundFile (i).getFile()); dest != juce::File())
                        s->setSoundMedia (i, dest.getRelativePathFrom (editPath.getParentDirectory())
                                                 .replaceCharacter ('\\', '/'));   // portable separators (cross-OS)
    }
}

juce::String MoshEngine::reloadFromFile()
{
    save();
    // PRJ-FMT — temp-load → gate → swap-on-success so a newer-format file on disk never
    // clobbers the live Edit. On refusal keep the current Edit and RETURN the error (the
    // command surfaces it); on success swap it in.
    auto fresh = te::loadEditFromFile (*enginePtr, editPath);
    auto mr = mosh::migrateOrRefuse (fresh->state);
    if (! mr.ok) return mr.error;           // current Edit kept; not latched (it's still valid + saveable)
    loadError.clear();                      // any prior cold-start refusal is now resolved

    editPtr->getTransport().stop (false, false);
    editPtr = std::move (fresh);
    wireEditResolvers();
    dirty = false;                          // freshly loaded from disk (gap 1)
    return {};
}

void MoshEngine::adoptEditFile (const juce::File& file)
{
    editPath = file;
    wireEditResolvers();
}

void MoshEngine::newProject (const juce::File& file)
{
    // Persist the outgoing Edit, then detach it from the device before swapping
    // (a live playback context bound to the old Edit asserts on destruction —
    // mirrors the export render-exclusivity dance).
    save();
    editPtr->getTransport().stop (false, false);
    editPtr->getTransport().freePlaybackContext();
    editPtr.reset();

    file.getParentDirectory().createDirectory();

    // Fresh empty Edit — strip createEmptyEdit's default audio track so Mosh
    // starts empty (every track is an explicit create_track command), matching
    // the cold-session seeding in the ctor.
    editPtr = te::createEmptyEdit (*enginePtr, file);
    juce::Array<te::AudioTrack*> defaults (te::getAudioTracks (*editPtr));
    for (auto* t : defaults)
        editPtr->deleteTrack (t);

    editPtr->getSceneList();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (1);

    editPtr->getUndoManager().clearUndoHistory();
    loadError.clear();                       // PRJ-FMT — a brand-new empty project is valid; resume saving
    adoptEditFile (file);
    save();                                  // write the new empty .tracktionedit to disk
    rememberProject (file);                  // gap 2 — record as last/recent project
}

juce::String MoshEngine::openProject (const juce::File& file)
{
    save();
    // PRJ-FMT — temp-load → gate → swap-on-success. On refusal (newer-format file) keep the
    // CURRENT project loaded + playing and RETURN the error; the open_project command turns
    // that into an error envelope the UI shows. The current project stays saveable.
    auto fresh = te::loadEditFromFile (*enginePtr, file);
    auto mr = mosh::migrateOrRefuse (fresh->state);
    if (! mr.ok) return mr.error;            // current project kept; not latched
    loadError.clear();                       // any prior cold-start refusal is now resolved

    editPtr->getTransport().stop (false, false);
    editPtr->getTransport().freePlaybackContext();
    editPtr = std::move (fresh);
    adoptEditFile (file);
    save();                                  // gap 2 — parity with newProject: persist on adopt (also clears dirty)
    rememberProject (file);                  // gap 2 — record as last/recent project
    return {};
}

bool MoshEngine::saveProjectAs (const juce::File& file)
{
    editPtr->getTransport().stop (false, false);
    file.getParentDirectory().createDirectory();
    // saveAs re-points the Edit's backing file; force-overwrite is safe because
    // the native save dialog (the only caller path) has already confirmed it.
    const bool ok = te::EditFileOperations (*editPtr).saveAs (file, true);
    if (ok)
    {
        adoptEditFile (file);                              // re-points editPath + resolvers (gap 3)
        consolidateAudioInto (file.getParentDirectory()); // gap 3 — copy audio local + re-point relative
        save();                                            // persist the consolidated relative refs (clears dirty)
        rememberProject (file);                            // gap 2 — record as last/recent project
    }
    return ok;
}

// ── PRF-001 — multicore audio thread preference ──────────────────────────────
// behaviourPtr is a MoshEngineBehaviour* (the type is anonymous-namespace-local
// to this TU, stored in the header as the base te::EngineBehaviour*). The cast is
// safe: we constructed exactly that derived type in the ctor.
int MoshEngine::availableCores() const
{
    return juce::jmax (1, juce::SystemStats::getNumCpus());
}

int MoshEngine::audioThreadPref() const
{
    return static_cast<MoshEngineBehaviour*> (behaviourPtr)
               ->audioThreads.load (std::memory_order_relaxed);
}

int MoshEngine::effectiveAudioThreads() const
{
    // The value getNumberOfCPUsToUseForAudio() would return RIGHT NOW — i.e. the
    // resolved core count when 'auto' (pref 0), else the clamped preference. This is
    // what the engine actually feeds setNumThreads(N-1), so it is the honest readout.
    const int pref = audioThreadPref();
    return pref > 0 ? juce::jlimit (1, availableCores(), pref) : availableCores();
}

void MoshEngine::setAudioThreadPref (int n)
{
    static_cast<MoshEngineBehaviour*> (behaviourPtr)
        ->audioThreads.store (n, std::memory_order_relaxed);

    // Re-apply LIVE to any running playback context (no restart). updateNumCPUs()
    // locks the audio callback + context lock and calls setNumThreads on the running
    // graph (a brief audio gap while the thread pool resizes — never a crash).
    // Headless / no device: nothing to update, the preference + readout still hold.
    // Offline renders read getNumberOfCPUsToUseForAudio() fresh at NodeRenderContext
    // construction, so they pick up the new value with no extra call.
    if (audioOpen)
        enginePtr->getDeviceManager().updateNumCPUs();
}

} // namespace mosh
