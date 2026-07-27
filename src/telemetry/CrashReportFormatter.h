#pragma once

#include <juce_core/juce_core.h>

namespace mosh::telemetry
{

/**
    Pure text formatting for the local crash report — no I/O, no signal-handling,
    no allocation policy concerns beyond ordinary juce::String usage (this runs
    OUTSIDE the signal handler: CrashHandler builds a CrashContext from
    already-captured, already-safe data and calls formatCrashReport() from a
    normal stack frame after the fact — see CrashHandler.cpp's writeCrashReport()).

    REDACTION CONTRACT (privacy is the point):
      • breadcrumbCommandNames must contain MoshOps command NAMES ONLY. Every
        entry is re-sanitised by sanitizeCommandName() before it is embedded in
        the report text, so even a caller that accidentally hands this a raw
        "command {\"trackId\":\"...\"}" blob (full args, a file path, lyrics
        text, anything) can only ever contribute the leading identifier token —
        never the rest. This is belt-and-suspenders: Breadcrumbs::record()
        ALSO sanitises at the recording boundary (see Breadcrumbs.h), so a
        redaction failure would need to happen at BOTH layers independently.
      • Nothing else on CrashContext accepts free-form user/project content by
        design — there is no field for args, file paths, audio, or lyrics.
*/
struct CrashContext
{
    int signalNumber = 0;
    juce::String signalName;              // e.g. "SIGSEGV", or "uncaught_exception"
    juce::String appVersion;
    juce::String osVersion;
    juce::String timestampIso;            // ISO-8601 UTC, e.g. "2026-07-17T12:34:56Z"
    juce::StringArray backtraceLines;     // raw backtrace_symbols() lines (binary/offsets only)
    juce::StringArray breadcrumbCommandNames; // last-N MoshOps command names, oldest first
};

/** Reduce a raw string to a safe "command name" token: the leading run of
    [A-Za-z0-9_] characters, truncated to a sane max length. Everything from the
    first non-identifier character onward (a space, '{', '(', '"', a path
    separator, …) is dropped. Empty / all-non-identifier input maps to
    "(unknown)" so the report never silently loses a slot. This is the single
    redaction primitive both Breadcrumbs::record() and formatCrashReport() use. */
juce::String sanitizeCommandName (const juce::String& raw);

/** Render the MINIMAL local crash report text described in docs/telemetry/PRIVACY.md:
    signal, app/OS version, a timestamp, the backtrace, and the redacted breadcrumb
    trail. Deterministic given its input (no clock/env reads) — safe to unit test. */
juce::String formatCrashReport (const CrashContext& ctx);

} // namespace mosh::telemetry
