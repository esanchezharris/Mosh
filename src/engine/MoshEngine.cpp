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
    applyRequestedAudioOutputDevice();

    // Session directory: a stable per-app-data folder so save/reload round-trips.
    // The harness gets an isolated "session-selftest" dir so it can't be polluted
    // by (or clobber) a real GUI session — see freshSession below.
    session = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
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
    if (editPtr != nullptr)
        editPtr->getTransport().stop (false, false);
    editPtr.reset();
    enginePtr.reset();
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
    if (requested.isEmpty())
        return;

    auto& tracktionDevices = enginePtr->getDeviceManager();
    auto& devices = tracktionDevices.deviceManager;

    juce::String matchedType;
    juce::String matchedOutput;
    for (auto* type : devices.getAvailableDeviceTypes())
    {
        type->scanForDevices();
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
            break;
        }
    }

    if (matchedOutput.isEmpty())
    {
        audioError = "Requested audio output device not found: " + requested;
        DBG (audioError);
        return;
    }

    auto setup = devices.getAudioDeviceSetup();
    devices.setCurrentAudioDeviceType (matchedType, true);
    setup.outputDeviceName = matchedOutput;
    setup.inputDeviceName.clear();
    setup.inputChannels.clear();
    setup.useDefaultInputChannels = true;
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

} // namespace mosh
