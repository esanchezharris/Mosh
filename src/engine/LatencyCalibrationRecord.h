#pragma once

// The persisted result of a measured round-trip latency calibration, and
// the pure decisions Mosh makes with it. Engine-free on purpose (juce_core
// only) so MoshTests can pin the maths without linking MoshEngine.
//
// A record is machine/device state, not project intent: it lives beside
// last-project.json in the session dir, not in the .tracktionedit.
//
// How it is applied (see MoshEngine::applyLatencyCalibrationToDevices):
// Tracktion already adds the DEVICE-REPORTED input+output latency
// (DeviceManager::getRecordAdjustmentSamples) plus graph PDC when it lands a
// take. So only the RESIDUAL — measured minus device-reported — is pushed
// through WaveInputDevice::setRecordAdjustmentMs. Pushing the whole measured
// value would double-compensate.
//
// Honour rule: a record is only trusted at the sample rate it was measured
// at and on the same device pair. Otherwise it is STALE and 0 ms is pushed —
// a wrong calibration is worse than none (Moshpit M005-25 audit F3).

#include <juce_core/juce_core.h>

#include <cmath>
#include <cstdint>
#include <optional>

namespace mosh::latency
{
struct CalibrationRecord
{
    std::int64_t frames = 0;           // measured output→room→input round trip
    double sampleRate = 0.0;           // rate the measurement was taken at
    double confidence = 0.0;           // detector confidence in [0,1]
    juce::String measuredAt;           // ISO-8601 UTC
    juce::String inputDevice;
    juce::String outputDevice;
    juce::String method { "farina-sweep-v1" };

    [[nodiscard]] double milliseconds() const noexcept
    {
        return sampleRate > 0.0 ? 1000.0 * (double) frames / sampleRate : 0.0;
    }

    [[nodiscard]] juce::var toVar() const
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("frames",       (juce::int64) frames);
        o->setProperty ("sampleRate",   sampleRate);
        o->setProperty ("confidence",   confidence);
        o->setProperty ("measuredAt",   measuredAt);
        o->setProperty ("inputDevice",  inputDevice);
        o->setProperty ("outputDevice", outputDevice);
        o->setProperty ("method",       method);
        return juce::var (o);
    }

    // Fails closed: anything malformed, negative, non-finite, or out of the
    // ±500 ms band Tracktion's record adjustment accepts is refused.
    [[nodiscard]] static std::optional<CalibrationRecord> fromVar (const juce::var& v)
    {
        if (! v.isObject())
            return std::nullopt;
        CalibrationRecord r;
        const auto framesVar = v.getProperty ("frames", juce::var());
        const auto rateVar   = v.getProperty ("sampleRate", juce::var());
        if (! (framesVar.isInt() || framesVar.isInt64() || framesVar.isDouble())
            || ! (rateVar.isDouble() || rateVar.isInt() || rateVar.isInt64()))
            return std::nullopt;
        r.frames     = (std::int64_t) (juce::int64) framesVar;
        r.sampleRate = (double) rateVar;
        r.confidence = (double) v.getProperty ("confidence", 0.0);
        r.measuredAt   = v.getProperty ("measuredAt", "").toString();
        r.inputDevice  = v.getProperty ("inputDevice", "").toString();
        r.outputDevice = v.getProperty ("outputDevice", "").toString();
        r.method       = v.getProperty ("method", "farina-sweep-v1").toString();
        if (! std::isfinite (r.sampleRate) || r.sampleRate <= 0.0)
            return std::nullopt;
        if (r.frames < 0)
            return std::nullopt;
        if (! std::isfinite (r.confidence) || r.confidence < 0.0 || r.confidence > 1.0)
            return std::nullopt;
        if (r.milliseconds() > kMaxAdjustmentMs)
            return std::nullopt;
        return r;
    }

    // Tracktion clamps WaveInputDevice::setRecordAdjustmentMs to ±500 ms.
    static constexpr double kMaxAdjustmentMs = 500.0;
};

/** The value to push to WaveInputDevice::setRecordAdjustmentMs: measured
    minus what Tracktion already compensates from the device's own report.
    May be negative (a device that over-reports); clamped to the band. */
[[nodiscard]] inline double residualMs (const CalibrationRecord& r,
                                        std::int64_t deviceReportedSamples) noexcept
{
    if (r.sampleRate <= 0.0)
        return 0.0;
    const auto residualFrames = (double) (r.frames - deviceReportedSamples);
    const auto ms = 1000.0 * residualFrames / r.sampleRate;
    return juce::jlimit (-CalibrationRecord::kMaxAdjustmentMs,
                          CalibrationRecord::kMaxAdjustmentMs, ms);
}

/** A record is honoured only at the rate it was measured at and on the same
    device pair. Rates compare within 0.5 Hz (CoreAudio reports e.g. 44100.0
    exactly, but be tolerant of float formatting). Empty device names in the
    record match anything (older/partial records), never the reverse. */
[[nodiscard]] inline bool isHonored (const CalibrationRecord& r,
                                     double currentSampleRate,
                                     const juce::String& currentInputDevice,
                                     const juce::String& currentOutputDevice) noexcept
{
    if (r.sampleRate <= 0.0 || currentSampleRate <= 0.0)
        return false;
    if (std::abs (r.sampleRate - currentSampleRate) > 0.5)
        return false;
    if (r.inputDevice.isNotEmpty() && r.inputDevice != currentInputDevice)
        return false;
    if (r.outputDevice.isNotEmpty() && r.outputDevice != currentOutputDevice)
        return false;
    return true;
}
} // namespace mosh::latency
