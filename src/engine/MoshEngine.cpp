#include "MoshEngine.h"

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
    };
}

MoshEngine::MoshEngine (bool openAudioDevice, bool freshSession)
{
    audioOpen = openAudioDevice
                && ! juce::SystemStats::getEnvironmentVariable ("MOSH_NO_AUDIO", {}).isNotEmpty();

    // 3-arg construction so we can disable auto device-init in no-audio mode
    // (the device opens during the Engine ctor otherwise — 01 §5).
    enginePtr = std::make_unique<te::Engine> (
        juce::String ("Mosh"),
        std::make_unique<te::UIBehaviour>(),
        std::make_unique<MoshEngineBehaviour> (audioOpen));
    applyPreferredOrSaneOutputDevice();

    if (audioOpen)
    {
        // The engine's first MIDI-device apply runs on a deferred timer and
        // calls clearAllContextDevices(), which KILLS a running transport — if
        // it lands mid-play, the first play after launch goes silent (a race
        // the live-audio smoke caught). Force the apply to completion now,
        // before any playback exists; the periodic re-checks then no-op unless
        // hardware actually changes.
        enginePtr->getDeviceManager().rescanMidiDeviceList();
        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (150);
    }

    // Session directory: a stable per-app-data folder so save/reload round-trips.
    // The harness gets an isolated "session-selftest" dir so it can't be polluted
    // by (or clobber) a real GUI session — see freshSession below.
    // MOSH_SESSION_DIR overrides outright: the replay harness runs N parallel
    // app instances, each in its own throwaway dir (phase0 §4 batch mode).
    const auto sessionOverride = juce::SystemStats::getEnvironmentVariable ("MOSH_SESSION_DIR", {});
    session = sessionOverride.isNotEmpty()
                  ? juce::File (sessionOverride)
                  : juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                        .getChildFile ("Mosh")
                        .getChildFile (freshSession ? "session-selftest" : "session");
    session.createDirectory();
    session.getChildFile ("audio").createDirectory();
    editPath = session.getChildFile ("session.tracktionedit");

    // The harness saves + reloads internally; wipe any prior run's persisted edit
    // so it always starts cold and is idempotent across repeated --selftest runs.
    if (freshSession)
        editPath.deleteFile();

    if (editPath.existsAsFile())
    {
        // Persisted session: load it (tracks/clips/RenderLayers come back).
        editPtr = te::loadEditFromFile (*enginePtr, editPath);
    }
    else
    {
        // Fresh session. createEmptyEdit seeds a default audio track; Mosh starts
        // empty so every track is an explicit create_track command (clean undo +
        // gate semantics).
        editPtr = te::createEmptyEdit (*enginePtr, editPath);
        juce::Array<te::AudioTrack*> defaults (te::getAudioTracks (*editPtr));
        for (auto* t : defaults)
            editPtr->deleteTrack (t);

        editPtr->getSceneList();

        if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
            mm->runDispatchLoopUntil (1);

        editPtr->getUndoManager().clearUndoHistory();
    }
    editPtr->editFileRetriever = [this] { return editPath; };
}

MoshEngine::~MoshEngine()
{
    stopAudition();          // unhook the SoundPlayer before the device dies
    if (editPtr != nullptr)
        editPtr->getTransport().stop (false, false);
    editPtr.reset();
    enginePtr.reset();
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording inputs (Stage 19). Same scan/switch pattern as the output side;
// the input opens ALONGSIDE the current output device, with the deferred
// MIDI-apply settle (it would otherwise kill the next play — Stage 14 lesson).
// ─────────────────────────────────────────────────────────────────────────────
juce::StringArray MoshEngine::listAudioInputDevices()
{
    juce::StringArray names;
    if (! audioOpen)
        return names;
    auto& devices = enginePtr->getDeviceManager().deviceManager;
    for (auto* type : devices.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        names.addArray (type->getDeviceNames (true));
    }
    names.removeDuplicates (true);
    return names;
}

juce::String MoshEngine::currentAudioInputDevice()
{
    if (! audioOpen)
        return {};
    return enginePtr->getDeviceManager().deviceManager.getAudioDeviceSetup().inputDeviceName;
}

juce::String MoshEngine::setAudioInputDevice (const juce::String& requested)
{
    if (! audioOpen)
        return "audio is disabled";

    auto& devices = enginePtr->getDeviceManager().deviceManager;
    juce::String matched;
    for (auto* type : devices.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        for (auto& name : type->getDeviceNames (true))
            if (name.equalsIgnoreCase (requested))
            {
                matched = name;
                break;
            }
        if (matched.isNotEmpty())
            break;
    }
    if (matched.isEmpty())
        return "audio input device not found: " + requested;

    auto setup = devices.getAudioDeviceSetup();
    setup.inputDeviceName = matched;
    setup.useDefaultInputChannels = true;
    if (auto error = devices.setAudioDeviceSetup (setup, true); error.isNotEmpty())
        return error;

    enginePtr->getDeviceManager().rescanWaveDeviceList();
    enginePtr->getDeviceManager().rescanMidiDeviceList();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (150);
    return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Crate audition (Stage 18): preview files through the SAME device the engine
// plays on, without touching the edit. SoundPlayer has no stop() — stopping is
// unhooking the callback and dropping the player.
// ─────────────────────────────────────────────────────────────────────────────
bool MoshEngine::auditionFile (const juce::File& f)
{
    if (! audioOpen || ! f.existsAsFile())
        return false;

    auto& dm = enginePtr->getDeviceManager().deviceManager;
    if (auditioner == nullptr)
    {
        auditioner = std::make_unique<juce::SoundPlayer>();
        dm.addAudioCallback (auditioner.get());
    }
    auditioner->play (f);
    return true;
}

void MoshEngine::stopAudition()
{
    if (auditioner == nullptr)
        return;
    if (enginePtr != nullptr)
        enginePtr->getDeviceManager().deviceManager.removeAudioCallback (auditioner.get());
    auditioner.reset();
}

void MoshEngine::ensurePlaybackContext()
{
    if (audioOpen)
        edit().getTransport().ensureContextAllocated();
}

void MoshEngine::applyRequestedAudioOutputDevice()
{
    if (! audioOpen)
        return;

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

// ─────────────────────────────────────────────────────────────────────────────
// Audio output device control (Stage 14). Rung 1's GUI silence: the machine's
// default output was BlackHole — a virtual loopback sink with no speakers —
// and Mosh inherited it without a word. Resolution order at startup:
// env override (tests) > persisted user preference > never-sit-on-a-pure-sink.
// ─────────────────────────────────────────────────────────────────────────────
bool MoshEngine::looksLikeVirtualSink (const juce::String& deviceName)
{
    const auto n = deviceName.toLowerCase();
    // Pure capture sinks only — multi-output/aggregate devices can still reach
    // speakers, so they are NOT listed here.
    for (auto* tag : { "blackhole", "soundflower", "loopback", "vb-cable",
                       "vb-audio", "zoomaudiodevice", "teams audio" })
        if (n.contains (tag))
            return true;
    return false;
}

juce::File MoshEngine::devicePrefFile() const
{
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
               .getChildFile ("Mosh").getChildFile ("audio-device.json");
}

juce::StringArray MoshEngine::listAudioOutputDevices()
{
    juce::StringArray names;
    if (! audioOpen)
        return names;
    auto& devices = enginePtr->getDeviceManager().deviceManager;
    for (auto* type : devices.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        names.addArray (type->getDeviceNames (false));
    }
    names.removeDuplicates (true);
    return names;
}

juce::String MoshEngine::currentAudioOutputDevice()
{
    if (! audioOpen)
        return {};
    if (auto* d = enginePtr->getDeviceManager().deviceManager.getCurrentAudioDevice())
        return d->getName();
    return {};
}

juce::String MoshEngine::switchOutputDevice (const juce::String& requested)
{
    if (! audioOpen)
        return "audio is disabled";

    auto& devices = enginePtr->getDeviceManager().deviceManager;
    juce::String matchedType, matchedOutput;
    for (auto* type : devices.getAvailableDeviceTypes())
    {
        type->scanForDevices();
        for (auto& name : type->getDeviceNames (false))
            if (name.equalsIgnoreCase (requested))
            {
                matchedType = type->getTypeName();
                matchedOutput = name;
                break;
            }
        if (matchedOutput.isNotEmpty())
            break;
    }
    if (matchedOutput.isEmpty())
        return "audio output device not found: " + requested;

    auto setup = devices.getAudioDeviceSetup();
    devices.setCurrentAudioDeviceType (matchedType, true);
    setup.outputDeviceName = matchedOutput;
    setup.useDefaultOutputChannels = true;
    if (auto error = devices.setAudioDeviceSetup (setup, true); error.isNotEmpty())
        return error;

    enginePtr->getDeviceManager().rescanWaveDeviceList();
    // Settle the MIDI-device apply the device restart schedules — it would
    // otherwise land mid-play and kill the transport (see ctor note).
    enginePtr->getDeviceManager().rescanMidiDeviceList();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (150);
    return {};
}

juce::String MoshEngine::setAudioOutputDevice (const juce::String& name)
{
    auto err = switchOutputDevice (name);
    if (err.isEmpty())
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("output", name);
        devicePrefFile().getParentDirectory().createDirectory();
        devicePrefFile().replaceWithText (juce::JSON::toString (juce::var (o)) + "\n");
        audioWarning.clear();
    }
    return err;
}

void MoshEngine::applyPreferredOrSaneOutputDevice()
{
    if (! audioOpen)
        return;

    // 1. Env overrides win outright (tests use these, incl. loopback input).
    const auto envOut = juce::SystemStats::getEnvironmentVariable ("MOSH_AUDIO_OUTPUT_DEVICE", {}).trim();
    const auto envIn  = juce::SystemStats::getEnvironmentVariable ("MOSH_AUDIO_INPUT_DEVICE", {}).trim();
    if (envOut.isNotEmpty() || envIn.isNotEmpty())
    {
        applyRequestedAudioOutputDevice();
        return;
    }

    // 2. Persisted user preference (set via set_audio_output, machine-local).
    if (auto pref = juce::JSON::parse (devicePrefFile().loadFileAsString())
                        .getProperty ("output", juce::var()).toString().trim();
        pref.isNotEmpty())
        if (switchOutputDevice (pref).isEmpty())
            return;                 // pref device gone → fall through to policy

    // 3. Policy: never default to a pure virtual sink while a real output exists.
    auto& devices = enginePtr->getDeviceManager().deviceManager;
    auto* current = devices.getCurrentAudioDevice();
    if (current == nullptr || ! looksLikeVirtualSink (current->getName()))
        return;

    const auto sinkName = current->getName();
    for (auto& name : listAudioOutputDevices())
        if (! looksLikeVirtualSink (name))
        {
            if (switchOutputDevice (name).isEmpty())
            {
                audioWarning = "System default output is " + sinkName
                             + " (a virtual sink) - Mosh switched to " + name
                             + ". Pick a different device in the topbar to override.";
                DBG (audioWarning);
            }
            return;
        }
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

bool MoshEngine::save()
{
    return te::EditFileOperations (edit()).save (false, true, false);
}

void MoshEngine::reloadFromFile()
{
    save();
    editPtr->getTransport().stop (false, false);
    editPtr.reset();
    editPtr = te::loadEditFromFile (*enginePtr, editPath);
    editPtr->editFileRetriever = [this] { return editPath; };
}

void MoshEngine::resetEmpty()
{
    editPtr->getTransport().stop (false, false);
    editPtr.reset();
    editPath.deleteFile();
    editPtr = te::createEmptyEdit (*enginePtr, editPath);
    // Same cold start as the ctor: no default track, clean undo history.
    juce::Array<te::AudioTrack*> defaults (te::getAudioTracks (*editPtr));
    for (auto* t : defaults)
        editPtr->deleteTrack (t);
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (1);
    editPtr->getUndoManager().clearUndoHistory();
    editPtr->editFileRetriever = [this] { return editPath; };
}

} // namespace mosh
