#pragma once

#include <juce_core/juce_core.h>

namespace mosh::telemetry
{

/**
    Process-wide crash handling. Call installCrashHandler() ONCE, as early as
    possible — src/Main.cpp installs it as the very first statement of
    MoshApplication::initialise() (see the coordination note there: this is the
    ONLY line this module adds to Main.cpp).

    What it does, in order:
      1. Installs std::set_terminate (uncaught C++ exceptions) and, on
         macOS/Linux, POSIX signal handlers for SIGSEGV/SIGABRT/SIGBUS/SIGILL/
         SIGFPE (sigaction, SA_RESETHAND semantics via an explicit reset-and-
         reraise so the OS's own crash reporter / core dump still fires
         afterwards — this handler is ADDITIVE, not a replacement).
      2. On a crash, writes a MINIMAL local report to
         TelemetryConfig::diagnosticsDir() (~/Library/Mosh/diagnostics/ by
         default): signal, backtrace, app version, macOS version, and the
         redacted command-NAME-only breadcrumb trail (Breadcrumbs +
         CrashReportFormatter). This ALWAYS happens, opt-in or not — it is a
         local file only, written with no network I/O whatsoever from inside the
         handler (see PRIVACY.md — "always" here means "always written to your
         own disk", never "always sent anywhere").
      3. If (and only if) TelemetryConfig::isOptedIn() at install time, also
         bootstraps the opt-in usage counters (Telemetry::onAppLaunch()) — launch
         count, session length, command histogram — and, on a FUTURE launch,
         opportunistically uploads any still-local crash reports the same way
         Telemetry::flush() uploads counters: only if MOSH_TELEMETRY_URL is set.
         Never uploads from inside the signal handler itself.

    SIGNAL-SAFETY NOTE: this is a MINIMAL, pragmatic implementation, not a
    textbook-strict async-signal-safe one. It follows common real-world practice
    (as specified by the task this module was built against): backtrace() +
    backtrace_symbols() (the latter calls malloc internally) and snprintf() for
    formatting, both of which POSIX does not officially guarantee safe inside a
    signal handler but which are extremely widely used in shipped crash handlers
    in practice. The one piece of shared mutable state the handler touches
    (Breadcrumbs' ring) is protected with try_lock so it can never deadlock the
    crashing thread. Directory creation, path resolution, and the opt-in check
    all happen at install() time — NOT inside the handler.
*/
void installCrashHandler();

/** Test/diagnostic hook: format + write a report exactly as installCrashHandler()'s
    signal path would, WITHOUT touching signal state or crashing anything. Returns
    the file written. Used by tests/test_telemetry.cpp to prove the write path
    deterministically (and reused by the real signal handler internally). */
juce::File writeCrashReportForTests (int signalNumber, const char* signalName,
                                      const juce::StringArray& fakeBreadcrumbs);

#if JUCE_MAC || JUCE_LINUX
/** Test-only (MOSH_TESTING builds): install the handler pointed at whatever
    TelemetryConfig::root() currently resolves to (honors MOSH_TELEMETRY_DIR),
    bypassing installCrashHandler()'s one-time-only guard so a test can
    re-install after changing the env override. Used by the fork+SIGSEGV live
    test, which needs a scratch directory rather than the real
    ~/Library/Mosh/diagnostics/. */
void installCrashHandlerForTests();
#endif

} // namespace mosh::telemetry
