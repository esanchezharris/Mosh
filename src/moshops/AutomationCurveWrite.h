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
#include <cmath>
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

struct AutomationCurveReplaceRangeResult
{
    bool ok = false;
    juce::String error;
    double start = 0.0;
    double end = 0.0;
};

// ADVERSARIAL-REVIEW FIX — o->getProperty("t")/("v") were cast straight to (double) with no
// type check. juce::var's numeric cast operator silently coerces a non-numeric var (e.g. a
// JSON string, bool, or null) to 0.0 instead of failing, so a malformed point like
// {"t":"oops","v":0.5} was silently accepted as {t:0.0,v:0.5} rather than rejected — the
// DrumPattern.h-style "validate the WHOLE input before mutating anything" discipline this
// file's header comment claims. The TypeScript mock is already stricter here
// (`typeof rec.t === "number"`, ui/src/bridge.mock.ts write_automation_curve) so native and
// mock disagreed on the same malformed input. isNumericVar() closes the gap.
inline bool isNumericVar (const juce::var& v)
{
    return v.isDouble() || v.isInt() || v.isInt64();
}

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

        const juce::var tVar = o->getProperty ("t");
        const juce::var vVar = o->getProperty ("v");
        if (! isNumericVar (tVar))
            return fail ("point \"t\" must be numeric (got " + tVar.toString() + ")");
        if (! isNumericVar (vVar))
            return fail ("point \"v\" must be numeric (got " + vVar.toString() + ")");

        const double t = (double) tVar;
        const double v = (double) vVar;
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

/** Optional replaceStart/replaceEnd let an editor replace the union of the OLD and NEW
    curve bounds after moving an edge point. Without them, replacement keeps the original
    [first-new-point,last-new-point] behavior. Both bounds are required together and must
    cover every new point so the command remains honest about the region it replaces. */
inline AutomationCurveReplaceRangeResult parseAutomationCurveReplaceRange (
    const juce::var& args,
    const std::vector<AutomationCurvePointIn>& points)
{
    AutomationCurveReplaceRangeResult r;
    auto fail = [&r] (const juce::String& error) {
        r.ok = false;
        r.error = error;
        return r;
    };
    if (points.empty()) return fail ("points must be validated before replacement bounds");

    auto* object = args.getDynamicObject();
    if (object == nullptr) return fail ("automation curve args must be an object");
    const bool hasStart = object->hasProperty ("replaceStart");
    const bool hasEnd = object->hasProperty ("replaceEnd");
    if (hasStart != hasEnd)
        return fail ("replaceStart and replaceEnd must be provided together");

    r.start = points.front().t;
    r.end = points.back().t;
    if (hasStart)
    {
        const auto startVar = object->getProperty ("replaceStart");
        const auto endVar = object->getProperty ("replaceEnd");
        if (! isNumericVar (startVar) || ! isNumericVar (endVar))
            return fail ("replaceStart and replaceEnd must be numeric");
        r.start = (double) startVar;
        r.end = (double) endVar;
    }

    if (! std::isfinite (r.start) || ! std::isfinite (r.end))
        return fail ("replacement bounds must be finite");
    if (r.start < 0.0 || r.end < r.start)
        return fail ("replacement bounds must satisfy 0 <= replaceStart <= replaceEnd");
    if (r.start > points.front().t || r.end < points.back().t)
        return fail ("replacement bounds must cover every new point");

    r.ok = true;
    return r;
}

} // namespace mosh
