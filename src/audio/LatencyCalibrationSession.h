#pragma once

// The calibration runner's registration lifecycle behind a registrar
// seam so the three defect shapes Moshpit's audits found (quit, reload,
// device-change) are headlessly provable. The structural guarantee is
// the destructor: an in-flight calibration ALWAYS deregisters before the
// runner is freed. All methods are message-thread only; the registered
// callback is driven by the audio thread.
//
// PROVENANCE: ported from Moshpit apps/recorder/CalibrationController.h
// at commit af8b6b7 (M006-04 / R005-13, accepted). Renamed
// CalibrationSession to avoid a clash with Mosh's Controller vocabulary.

#include "audio/LatencyCalibrationRunner.h"

#include <memory>
#include <optional>

namespace mosh::latency
{
struct AudioCallbackRegistrar
{
    virtual ~AudioCallbackRegistrar() = default;
    virtual void add(juce::AudioIODeviceCallback* callback) = 0;
    virtual void remove(juce::AudioIODeviceCallback* callback) = 0;
};

class CalibrationSession final
{
public:
    explicit CalibrationSession(AudioCallbackRegistrar& registrarToUse)
        : registrar(registrarToUse)
    {
    }

    ~CalibrationSession() { cancel(); }

    [[nodiscard]] bool running() const noexcept
    {
        return runner != nullptr;
    }

    // Refuses a second start while a pass is in flight.
    bool start(double sampleRate, juce::File debugDumpFile = {})
    {
        if (runner != nullptr)
            return false;
        runner = std::make_unique<CalibrationRunner>();
        runner->begin(sampleRate);
        runner->setDebugDumpFile(std::move(debugDumpFile));
        registrar.add(runner.get());
        return true;
    }

    void cancel()
    {
        if (runner == nullptr)
            return;
        registrar.remove(runner.get());
        runner.reset();
    }

    // Returns the measurement once the pass has completed, having
    // deregistered the callback FIRST (measure runs off the audio thread
    // against quiescent buffers). Empty while idle or running.
    [[nodiscard]] std::optional<CalibrationResult> pollFinished()
    {
        if (runner == nullptr || !runner->finished())
            return std::nullopt;
        registrar.remove(runner.get());
        const auto measured = runner->measure();
        runner.reset();
        return measured;
    }

private:
    AudioCallbackRegistrar& registrar;
    std::unique_ptr<CalibrationRunner> runner;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CalibrationSession)
};

// The production registrar over a juce::AudioDeviceManager.
class DeviceManagerRegistrar final : public AudioCallbackRegistrar
{
public:
    explicit DeviceManagerRegistrar(juce::AudioDeviceManager& manager)
        : deviceManager(manager)
    {
    }

    void add(juce::AudioIODeviceCallback* callback) override
    {
        deviceManager.addAudioCallback(callback);
    }

    void remove(juce::AudioIODeviceCallback* callback) override
    {
        deviceManager.removeAudioCallback(callback);
    }

private:
    juce::AudioDeviceManager& deviceManager;
};
} // namespace mosh::latency
