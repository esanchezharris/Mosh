// G10 — automation record-arm mode string parsing. Header-only, juce_core only (NO
// tracktion) so tests/test_automation_mode.cpp runs it hermetically — mirrors the
// DrumPattern.h twin-parser precedent (a pure validator MoshOps.cpp's engine-coupled
// cmdSetTrackAutomationMode maps onto te::AutomationMode via a trivial parallel switch).
//
// The 4 values mirror tracktion_engine's te::AutomationMode 1:1 BY NAME (read/touch/
// latch/write; tracktion_AutomationMode.h) — deliberately kept in lockstep so the
// MoshOps.cpp switch is a mechanical one-to-one mapping, not a translation.
#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{

enum class AutomationRecordMode { read, touch, latch, write };

struct AutomationModeParseResult
{
    bool ok = false;
    juce::String error;
    AutomationRecordMode mode = AutomationRecordMode::read;
};

/** Case-insensitive, trimmed match against "read"|"touch"|"latch"|"write". */
inline AutomationModeParseResult parseAutomationRecordMode (const juce::String& raw)
{
    AutomationModeParseResult r;
    const auto s = raw.trim().toLowerCase();
    if (s == "read")  { r.ok = true; r.mode = AutomationRecordMode::read;  return r; }
    if (s == "touch") { r.ok = true; r.mode = AutomationRecordMode::touch; return r; }
    if (s == "latch") { r.ok = true; r.mode = AutomationRecordMode::latch; return r; }
    if (s == "write") { r.ok = true; r.mode = AutomationRecordMode::write; return r; }
    r.error = "mode must be one of read|touch|latch|write (got \"" + raw + "\")";
    return r;
}

inline const char* automationRecordModeToString (AutomationRecordMode m)
{
    switch (m)
    {
        case AutomationRecordMode::read:  return "read";
        case AutomationRecordMode::touch: return "touch";
        case AutomationRecordMode::latch: return "latch";
        case AutomationRecordMode::write: return "write";
    }
    return "read";
}

} // namespace mosh
