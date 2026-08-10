#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>
#include <cmath>
#include <vector>

namespace mosh
{

inline constexpr float clipGainCurveMinDb = -48.0f;
inline constexpr float clipGainCurveMaxDb = 6.0f;
inline constexpr int clipGainCurveMaxPoints = 4096;
inline constexpr double clipGainCurveMaxAbsTimeSec = 7.0 * 24.0 * 60.0 * 60.0;

struct ClipGainCurvePointIn
{
    double t = 0.0;
    float gainDb = 0.0f;
    float curve = 0.0f;
};

struct ClipGainCurveWriteResult
{
    bool ok = false;
    juce::String error;
    std::vector<ClipGainCurvePointIn> points;
};

inline bool isClipGainNumericVar (const juce::var& value)
{
    return value.isDouble() || value.isInt() || value.isInt64();
}

/** Validates one complete clip-gain envelope before any edit mutation. `t` is a
    signed number of seconds from the clip's current visible start. Negative points
    are intentional: they preserve source-relative breakpoints hidden by a head trim.
    `gainDb` is an offset from the clip's static gain and follows the clip-local
    VolumeAndPanPlugin's honest -48..+6 dB range. An empty array clears the envelope. */
inline ClipGainCurveWriteResult parseClipGainCurvePoints (const juce::var& pointsIn)
{
    ClipGainCurveWriteResult result;
    auto fail = [&result] (const juce::String& error)
    {
        result.ok = false;
        result.error = error;
        return result;
    };

    juce::var pointsVar = pointsIn;
    if (pointsIn.isString())
    {
        pointsVar = juce::JSON::parse (pointsIn.toString());
        if (! pointsVar.isArray())
            return fail ("points string must be a JSON array of {t,gainDb} objects");
    }

    auto* points = pointsVar.getArray();
    if (points == nullptr)
        return fail ("points must be an array (or a JSON-encoded array string)");
    if (points->size() > clipGainCurveMaxPoints)
        return fail ("points must contain at most " + juce::String (clipGainCurveMaxPoints) + " items");

    double previousT = 0.0;
    bool first = true;
    for (const auto& pointVar : *points)
    {
        auto* point = pointVar.getDynamicObject();
        if (point == nullptr || ! point->hasProperty ("t") || ! point->hasProperty ("gainDb"))
            return fail ("each point must be an object with numeric t and gainDb");

        const auto tVar = point->getProperty ("t");
        const auto gainVar = point->getProperty ("gainDb");
        const auto curveVar = point->hasProperty ("curve") ? point->getProperty ("curve") : juce::var (0.0);
        if (! isClipGainNumericVar (tVar) || ! isClipGainNumericVar (gainVar)
            || ! isClipGainNumericVar (curveVar))
            return fail ("point t, gainDb, and curve must be numeric");

        const double t = (double) tVar;
        const double gainDb = (double) gainVar;
        const double curve = (double) curveVar;
        if (! std::isfinite (t) || ! std::isfinite (gainDb) || ! std::isfinite (curve))
            return fail ("point t, gainDb, and curve must be finite");
        if (std::abs (t) > clipGainCurveMaxAbsTimeSec)
            return fail ("point t must be within seven days of the visible clip start");
        if (! first && ! (t > previousT))
            return fail ("points must be strictly ascending in t");
        if (gainDb < clipGainCurveMinDb || gainDb > clipGainCurveMaxDb)
            return fail ("point gainDb must be -48..+6");
        if (curve < -1.0 || curve > 1.0)
            return fail ("point curve must be -1..1");

        result.points.push_back ({ t, (float) gainDb, (float) curve });
        previousT = t;
        first = false;
    }

    result.ok = true;
    return result;
}

} // namespace mosh
