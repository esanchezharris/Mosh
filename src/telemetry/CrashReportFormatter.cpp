#include "CrashReportFormatter.h"

namespace mosh::telemetry
{

namespace
{
    constexpr int kMaxNameLen = 63;

    bool isIdentifierChar (juce::juce_wchar c)
    {
        return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    }
}

juce::String sanitizeCommandName (const juce::String& raw)
{
    juce::String out;
    const auto n = juce::jmin (raw.length(), kMaxNameLen);
    for (int idx = 0; idx < n; ++idx)
    {
        const auto c = raw[idx];
        if (! isIdentifierChar (c))
            break; // stop at the first non-identifier char — args/paths/quotes never survive
        out += c;
    }
    return out.isEmpty() ? juce::String ("(unknown)") : out;
}

juce::String formatCrashReport (const CrashContext& ctx)
{
    juce::String s;
    s << "Mosh Crash Report\n";
    s << "==================\n";
    s << "Time (UTC):    " << ctx.timestampIso << "\n";
    s << "App version:   " << ctx.appVersion << "\n";
    s << "OS version:    " << ctx.osVersion << "\n";
    s << "Signal:        " << ctx.signalName;
    if (ctx.signalNumber != 0)
        s << " (" << ctx.signalNumber << ")";
    s << "\n\n";

    s << "Backtrace:\n";
    if (ctx.backtraceLines.isEmpty())
        s << "  (unavailable)\n";
    else
        for (auto& line : ctx.backtraceLines)
            s << "  " << line << "\n";

    // PRIVACY: this section is the ONLY place user activity enters the report, and it
    // is command NAMES ONLY — never args, audio, lyrics, file paths, or project
    // content. Re-sanitise here too (belt-and-suspenders on top of Breadcrumbs::record).
    s << "\nRecent commands (names only, oldest first):\n";
    if (ctx.breadcrumbCommandNames.isEmpty())
        s << "  (none)\n";
    else
        for (auto& name : ctx.breadcrumbCommandNames)
            s << "  " << sanitizeCommandName (name) << "\n";

    return s;
}

} // namespace mosh::telemetry
