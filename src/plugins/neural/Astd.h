#pragma once

#include <algorithm>
#include <cmath>
#include <map>
#include <string>

// ASTD — quality-aware slider reparameterization (04 §6, 05 §6). Every
// over-driveable neural param is a 0–100 UI control mapped to a raw range that is
// clamped below the point production quality collapses. Lab mode unlocks the raw
// range beyond the clamp. ONE shared impl for both tiers (Tier A inserts + Tier B
// generative colors). Dependency-free (std only) so it's unit-testable and usable
// from the C++ engine and the service-facing code alike.
namespace mosh::astd
{
/** Per-(model,param) safe-range descriptor. The collapse point `safeMax` is
    calibrated offline by sweeping the param and scoring with the judge panel
    (05 §7); here we just store/apply it. */
struct Range
{
    float rawMin = 0.0f;
    float rawMax = 1.0f;   ///< full raw range upper bound
    float safeMax = 1.0f;  ///< quality-collapse clamp (<= rawMax); default range top

    /** Map a 0–100 UI value to a raw param value. In normal mode the top of the
        range is `safeMax` (never reaches collapse); Lab mode opens it to `rawMax`. */
    float toRaw (float ui0to100, bool labMode) const
    {
        const float t = std::clamp (ui0to100, 0.0f, 100.0f) / 100.0f;
        const float top = labMode ? rawMax : safeMax;
        return rawMin + t * (top - rawMin);
    }

    /** Inverse: raw → 0–100 UI (against the active top). */
    float toUi (float raw, bool labMode) const
    {
        const float top = labMode ? rawMax : safeMax;
        if (std::abs (top - rawMin) < 1e-9f) return 0.0f;
        return std::clamp ((raw - rawMin) / (top - rawMin), 0.0f, 1.0f) * 100.0f;
    }

    /** The raw value at the clamp (UI 100 in normal mode). */
    float clampedRawMax() const { return safeMax; }
};

/** A registry of safe ranges keyed by "<modelId>:<paramId>". Falls back to an
    identity 0–1 range (safe == full) for unknown params. */
class Registry
{
public:
    void set (const std::string& modelId, const std::string& paramId, Range r)
    {
        ranges[key (modelId, paramId)] = r;
    }

    Range get (const std::string& modelId, const std::string& paramId) const
    {
        auto it = ranges.find (key (modelId, paramId));
        return it != ranges.end() ? it->second : Range{};
    }

    bool has (const std::string& modelId, const std::string& paramId) const
    {
        return ranges.count (key (modelId, paramId)) > 0;
    }

private:
    static std::string key (const std::string& m, const std::string& p) { return m + ":" + p; }
    std::map<std::string, Range> ranges;
};

} // namespace mosh::astd
