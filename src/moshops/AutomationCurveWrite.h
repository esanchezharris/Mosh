// G10 — write_automation_curve's bulk point-array validator. Header-only, juce_core +
// juce_data_structures only (NO tracktion) so tests/test_automation_curve_write.cpp runs
// it hermetically — mirrors the DrumPattern.h twin-parser precedent (validate the WHOLE
// input before MoshOps.cpp mutates anything, so a rejected call touches nothing).
//
// The agent catalog has no array/object ArgType (see commands.ts), so the LLM-callable
// form of `points` is a JSON-encoded string; the UI/tests form is a native array. Both
// are accepted here — the same "flat string OR object" duality add_drum_pattern's
// `pattern` arg already established (DrumPattern.h).
#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>
#include <vector>

namespace mosh
{

struct AutomationCurvePointIn { double t = 0.0; float v = 0.0f; float curve = 0.0f; };

struct AutomationCurveWriteResult
{
    bool ok = false;
    juce::String error;
    std::vector<AutomationCurvePointIn> points;   // validated, ascending in t (input order)
};

/** pointsIn: a juce::var array of {t, v, curve?} objects, OR a JSON-encoded string of the
    same shape (the agent-catalog form). t must be >= 0 and strictly ascending across the
    array; v must be 0..1 (normalised, like every other automation command's value arg);
    curve is optional (default 0), must be -1..1 (AutomationCurve's own bezier-amount range). */
inline AutomationCurveWriteResult parseAutomationCurvePoints (const juce::var& pointsIn)
{
    AutomationCurveWriteResult r;
    auto fail = [&r] (const juce::String& e) { r.ok = false; r.error = e; return r; };

    juce::var pointsVar = pointsIn;
    if (pointsIn.isString())
    {
        pointsVar = juce::JSON::parse (pointsIn.toString());
        if (! pointsVar.isArray())
            return fail ("points string must be a JSON array of {t,v} objects");
    }

    auto* arr = pointsVar.getArray();
    if (arr == nullptr || arr->isEmpty())
        return fail ("points must be a non-empty array (or a JSON-encoded array string)");

    double lastT = 0.0;
    bool first = true;
    for (const auto& pv : *arr)
    {
        auto* o = pv.getDynamicObject();
        if (o == nullptr)
            return fail ("each point must be an object {t, v, curve?}");
        if (! o->hasProperty ("t") || ! o->hasProperty ("v"))
            return fail ("each point needs \"t\" and \"v\"");

        const double t = (double) o->getProperty ("t");
        const double v = (double) o->getProperty ("v");
        const double c = o->hasProperty ("curve") ? (double) o->getProperty ("curve") : 0.0;

        if (t < 0.0)
            return fail ("point t must be >= 0 (got " + juce::String (t) + ")");
        if (! first && ! (t > lastT))
            return fail ("points must be strictly ascending in t (got " + juce::String (t)
                         + " after " + juce::String (lastT) + ")");
        if (v < 0.0 || v > 1.0)
            return fail ("point v must be 0..1 (got " + juce::String (v) + ")");
        if (c < -1.0 || c > 1.0)
            return fail ("point curve must be -1..1 (got " + juce::String (c) + ")");

        r.points.push_back ({ t, (float) v, (float) c });
        lastT = t;
        first = false;
    }

    r.ok = true;
    return r;
}

} // namespace mosh
