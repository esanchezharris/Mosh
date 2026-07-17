// export_audio range/section + delay-tail policy (G1) — pure, engine-free
// resolution + validation math. Header-only, juce_core ONLY (NO tracktion) so
// tests/test_export_range.cpp runs it hermetically, mirroring DrumPattern.h's
// posture. cmdExportAudio (MoshOps.cpp) calls this, then converts the resolved
// seconds into tracktion TimePosition/TimeDuration — that conversion (and the
// actual render) stays out of this header on purpose.
//
// Invariants covered (docs/reality-pack/mosh_daw_reality_model.md):
//  78 — "Render captures the intended range: full arrangement, selected
//        section, or battle loop."
//  81 — "Reverb/delay tails are included or cut according to an explicit tail
//        policy."
#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{

struct ExportRangeResult
{
    bool ok = false;
    juce::String error;

    juce::String rangeKind;      // "full" | "loop" | "custom" (only meaningful when ok)
    double rangeStart = 0.0;     // seconds
    double rangeEnd = 0.0;       // seconds

    juce::String tailKind;       // "cut" | "include" (only meaningful when ok)
    double tailSeconds = 0.0;    // seconds; 0 when tailKind == "cut"
};

/** Resolve + validate export_audio's optional {range,start,end,tail,tailSeconds}
    args. Every `has*` flag mirrors `args.hasProperty(...)` at the call site — the
    default ("full" range / "cut" tail) applies ONLY when the arg is absent, exactly
    matching `args.getProperty (name, defaultValue)`'s semantics (an explicitly-passed
    empty string is NOT the same as "absent" and is rejected as an invalid enum).

    editLenSeconds: edit.getLength().inSeconds() (the caller may clamp upstream; this
        function additionally floors it to >= 0.01 so a degenerate/empty edit can't
        produce a divide-by-zero-shaped custom range).
    loopStartSeconds/loopEndSeconds: the transport's current loop range in seconds
        (may be {0,0} = no loop configured). */
inline ExportRangeResult resolveExportRange (double editLenSeconds,
                                              double loopStartSeconds, double loopEndSeconds,
                                              bool hasRange, const juce::String& rangeValue,
                                              bool hasStart, double startValue,
                                              bool hasEnd, double endValue,
                                              bool hasTail, const juce::String& tailValue,
                                              bool hasTailSeconds, double tailSecondsValue)
{
    ExportRangeResult out;
    const double editLen = juce::jmax (0.01, editLenSeconds);

    juce::String rangeKind = hasRange ? rangeValue.trim().toLowerCase() : juce::String();
    const bool hasCustomBounds = hasStart && hasEnd;
    if (rangeKind.isEmpty())
        rangeKind = hasCustomBounds ? "custom" : "full";   // presence of start+end implies custom
    if (rangeKind != "full" && rangeKind != "loop" && rangeKind != "custom")
    {
        out.error = "range must be 'full', 'loop', or 'custom'";
        return out;
    }

    double rStart = 0.0, rEnd = editLen;
    if (rangeKind == "loop")
    {
        rStart = loopStartSeconds;
        rEnd   = loopEndSeconds;
        if (rEnd - rStart < 0.01)
        {
            out.error = "range 'loop' requested but no loop region is set";
            return out;
        }
    }
    else if (rangeKind == "custom")
    {
        if (! hasCustomBounds)
        {
            out.error = "range 'custom' requires 'start' and 'end' (seconds)";
            return out;
        }
        rStart = juce::jlimit (0.0, editLen, startValue);
        rEnd   = juce::jlimit (0.0, editLen, endValue);
        if (rEnd - rStart < 0.01)
        {
            out.error = "export range is empty: end must be > start (within the edit)";
            return out;
        }
    }

    const juce::String tailKind = (hasTail ? tailValue.trim().toLowerCase() : juce::String ("cut"));
    if (tailKind != "cut" && tailKind != "include")
    {
        out.error = "tail must be 'cut' or 'include'";
        return out;
    }
    const double tailSeconds = tailKind == "include"
        ? juce::jlimit (0.05, 30.0, hasTailSeconds ? tailSecondsValue : 2.0)
        : 0.0;

    out.ok = true;
    out.rangeKind = rangeKind;
    out.rangeStart = rStart;
    out.rangeEnd = rEnd;
    out.tailKind = tailKind;
    out.tailSeconds = tailSeconds;
    return out;
}

} // namespace mosh
