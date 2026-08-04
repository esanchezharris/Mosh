#include "CrashHandler.h"
#include "TelemetryConfig.h"
#include "Breadcrumbs.h"
#include "CrashReportFormatter.h"
#include "Telemetry.h"
#include "SentryReporter.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <exception>

#if JUCE_MAC || JUCE_LINUX
 #include <execinfo.h>
 #include <unistd.h>
 #include <fcntl.h>
 #include <signal.h>
#endif

namespace mosh::telemetry
{

namespace
{
    std::atomic<bool> g_installed { false };

    // Precomputed at install time (a normal, non-signal call) and cached in fixed
    // buffers so the signal handler path never allocates to read them.
    constexpr size_t kSmallBufLen = 512;
    constexpr size_t kPathBufLen  = 1024;
    char g_appVersion[kSmallBufLen] = {};
    char g_osVersion[kSmallBufLen]  = {};
    char g_reportDir[kPathBufLen]   = {};

    void copyBounded (char* dst, size_t dstLen, const juce::String& src)
    {
        const auto utf8 = src.toRawUTF8();
        std::strncpy (dst, utf8, dstLen - 1);
        dst[dstLen - 1] = '\0';
    }

    juce::String currentAppVersion()
    {
       #ifdef MOSH_VERSION_STRING
        return juce::String (MOSH_VERSION_STRING);
       #else
        return juce::String ("dev"); // MoshTests doesn't define MOSH_VERSION_STRING
       #endif
    }

    // Refreshes the cached buffers from the CURRENT TelemetryConfig (honors
    // MOSH_TELEMETRY_DIR at the moment this runs). Safe to call from any normal
    // (non-signal) context; called at install time and again by the test-only
    // report writer so tests can point it at a fresh scratch dir per case.
    void refreshCachedContext()
    {
        TelemetryConfig::diagnosticsDir(); // ensure it exists
        copyBounded (g_reportDir, sizeof (g_reportDir), TelemetryConfig::diagnosticsDir().getFullPathName());
        copyBounded (g_appVersion, sizeof (g_appVersion), currentAppVersion());
        copyBounded (g_osVersion, sizeof (g_osVersion), juce::SystemStats::getOperatingSystemName());
    }

   #if JUCE_MAC || JUCE_LINUX
    const char* signalName (int sig)
    {
        switch (sig)
        {
            case SIGSEGV: return "SIGSEGV";
            case SIGABRT: return "SIGABRT";
            case SIGBUS:  return "SIGBUS";
            case SIGILL:  return "SIGILL";
            case SIGFPE:  return "SIGFPE";
            default:      return "SIGNAL";
        }
    }
   #endif

    // ISO-8601 UTC timestamp. time()/gmtime_r()/snprintf() are the pragmatic,
    // widely-used-in-practice choices documented in CrashHandler.h's signal-safety
    // note (not textbook-strict async-signal-safe, but bounded and simple).
    juce::String isoTimestampNow()
    {
        std::time_t t = std::time (nullptr);
        std::tm tmv {};
       #if JUCE_WINDOWS
        gmtime_s (&tmv, &t);
       #else
        gmtime_r (&t, &tmv);
       #endif
        char buf[32];
        std::snprintf (buf, sizeof (buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
                        tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                        tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
        return juce::String (buf);
    }

    // Raw POSIX write — no juce::File/FILE* buffering, so this is safe to call
    // from the signal handler as well as from ordinary code (writeCrashReportForTests
    // reuses it too, for exactly one write code path to reason about / test).
    void rawWriteFile (const char* path, const juce::String& text)
    {
       #if JUCE_MAC || JUCE_LINUX
        const int fd = ::open (path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd < 0)
            return;
        const auto utf8 = text.toRawUTF8();
        const auto len = std::strlen (utf8);
        size_t written = 0;
        while (written < len)
        {
            const auto n = ::write (fd, utf8 + written, len - written);
            if (n <= 0)
                break;
            written += (size_t) n;
        }
        ::close (fd);
       #else
        // No POSIX signal-handler path on Windows (see header) — this branch only
        // runs from writeCrashReportForTests()/std::terminate, never a signal
        // handler, so ordinary juce::File I/O is fine here.
        juce::File (juce::String (path)).replaceWithText (text);
       #endif
    }

    juce::StringArray captureBacktrace()
    {
        juce::StringArray lines;
       #if JUCE_MAC || JUCE_LINUX
        void* frames[64];
        const int n = ::backtrace (frames, 64);
        char** symbols = ::backtrace_symbols (frames, n); // malloc'd — see signal-safety note
        if (symbols != nullptr)
        {
            for (int i = 0; i < n; ++i)
                lines.add (juce::String (symbols[i]));
            // Deliberately not freed: free() is not async-signal-safe, and the
            // process is about to terminate via the re-raised signal anyway.
        }
       #endif
        return lines;
    }

    long currentPid()
    {
       #if JUCE_MAC || JUCE_LINUX
        return (long) ::getpid();
       #elif JUCE_WINDOWS
        return (long) ::GetCurrentProcessId();
       #else
        return 0;
       #endif
    }

    // The one report-building path, shared by the real signal handler and the
    // test hook. Pure juce::String work + one rawWriteFile() call.
    juce::File buildAndWriteReport (int signalNumber, const char* sigName,
                                     const juce::StringArray& backtraceLines,
                                     const juce::StringArray& breadcrumbNames)
    {
        CrashContext ctx;
        ctx.signalNumber = signalNumber;
        ctx.signalName   = sigName;
        ctx.appVersion   = juce::String (g_appVersion);
        ctx.osVersion    = juce::String (g_osVersion);
        ctx.timestampIso = isoTimestampNow();
        ctx.backtraceLines = backtraceLines;
        ctx.breadcrumbCommandNames = breadcrumbNames;

        const auto text = formatCrashReport (ctx);

        char path[kPathBufLen + 64];
        std::snprintf (path, sizeof (path), "%s/crash-%ld-%ld.txt",
                        g_reportDir, currentPid(), (long) std::time (nullptr));
        rawWriteFile (path, text);
        return juce::File (juce::String (path));
    }

    void handleCrash (int signalNumber, const char* sigName)
    {
        Breadcrumbs::Slot slots[Breadcrumbs::kCapacity];
        const int n = Breadcrumbs::snapshot (slots, Breadcrumbs::kCapacity);
        juce::StringArray names;
        for (int i = 0; i < n; ++i)
            names.add (juce::String (slots[i].name));

        buildAndWriteReport (signalNumber, sigName, captureBacktrace(), names);
    }

   #if JUCE_MAC || JUCE_LINUX
    void onPosixSignal (int sig)
    {
        handleCrash (sig, signalName (sig));
        // Reset to default disposition and re-raise: this handler is ADDITIVE, not
        // a replacement for the OS's own crash reporter / core dump, and it also
        // guards against an infinite loop if the handler itself were to re-fault.
        ::signal (sig, SIG_DFL);
        ::raise (sig);
    }
   #endif

    void onTerminate()
    {
        handleCrash (0, "uncaught_exception");
        std::abort();
    }

    void installCommon()
    {
        refreshCachedContext();
        std::set_terminate (&onTerminate);

       #if JUCE_MAC || JUCE_LINUX
        struct sigaction sa {};
        sa.sa_handler = &onPosixSignal;
        sigemptyset (&sa.sa_mask);
        sa.sa_flags = 0;
        for (int sig : { SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE })
            ::sigaction (sig, &sa, nullptr);
       #endif

        // Opt-in-gated telemetry bootstrap. Telemetry::onAppLaunch() re-checks
        // TelemetryConfig::isOptedIn() itself and is a pure no-op when it's false —
        // no file, no thread, no network. See docs/telemetry/PRIVACY.md.
        Telemetry::onAppLaunch();

        // FS-K3 — Sentry (crashpad) reporter. A no-op in the default build
        // (MOSH_HAVE_SENTRY undefined) and, even in a -DMOSH_ENABLE_SENTRY=ON
        // build, a no-op unless the SAME TelemetryConfig::isOptedIn() bit above is
        // set AND a DSN is configured. No second consent flag, no new command.
        //
        // ORDER MATTERS, and not in the direction you'd guess. This runs LAST, after
        // the POSIX handlers are installed, but on macOS that does NOT make our
        // handlers win: crashpad installs a MACH exception port, and Mach exceptions
        // are serviced before BSD signal delivery. So for a hardware fault
        // (SIGSEGV/SIGBUS/SIGILL/SIGFPE) crashpad takes the crash and the local
        // report above may not be written; software-raised signals (abort(), an
        // uncaught C++ exception) still travel the BSD path and produce both. This
        // is measured, not assumed — see docs/first-stranger-program/lanes/fs-k3.md
        // gate G5, which asserts on both artifacts. It only ever applies to a
        // Sentry-ON build; the shipped default build is unaffected.
        initSentryReporter();
    }
}

void installCrashHandler()
{
    if (g_installed.exchange (true))
        return; // idempotent
    installCommon();
}

juce::File writeCrashReportForTests (int signalNumber, const char* sigName,
                                      const juce::StringArray& fakeBreadcrumbs)
{
    // Always refresh from the CURRENT TelemetryConfig — tests may point
    // MOSH_TELEMETRY_DIR at a fresh scratch dir between cases, and this is an
    // ordinary (non-signal) call so recomputing is fine.
    refreshCachedContext();
    return buildAndWriteReport (signalNumber, sigName, {}, fakeBreadcrumbs);
}

#if JUCE_MAC || JUCE_LINUX
void installCrashHandlerForTests()
{
    // Test-only: bypasses the g_installed guard so a test can re-install after
    // changing MOSH_TELEMETRY_DIR. Not thread-safe against a concurrent real
    // installCrashHandler() call — acceptable for a single-threaded test harness.
    installCommon();
}
#endif

} // namespace mosh::telemetry
