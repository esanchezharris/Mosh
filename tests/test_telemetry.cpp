#include <catch2/catch_test_macros.hpp>

#include "telemetry/Breadcrumbs.h"
#include "telemetry/CrashHandler.h"
#include "telemetry/CrashReportFormatter.h"
#include "telemetry/Telemetry.h"
#include "telemetry/TelemetryConfig.h"
#include "util/Env.h"

#if JUCE_MAC || JUCE_LINUX
 #include <csignal>
 #include <sys/wait.h>
 #include <unistd.h>
#endif

using namespace mosh::telemetry;

// ─────────────────────────────────────────────────────────────────────────────
// Opt-in, privacy-respecting crash reporting + telemetry (src/telemetry/). See
// docs/telemetry/PRIVACY.md for the full data/redaction/opt-in contract this
// pins. Two requirements carry the most weight and get the most direct coverage:
//   (a) the crash-report FORMATTER redacts — a fake breadcrumb carrying full
//       args/paths/lyrics must survive as a command NAME ONLY.
//   (b) telemetry is OFF by default — no file write, no network attempt, not even
//       a call into the (injected, never-real) uploader, when the opt-in flag
//       file is absent.
// ─────────────────────────────────────────────────────────────────────────────

namespace
{
    // One RAII fixture for every test below: points MOSH_TELEMETRY_DIR at a fresh
    // scratch directory (NEVER the real ~/Library/Mosh) and resets the
    // process-global Telemetry/Breadcrumbs statics on both entry AND exit — exit
    // matters because a failed REQUIRE unwinds the stack via an exception, which
    // would otherwise skip manual end-of-test cleanup and leak dirty state into
    // whichever test case Catch2 runs next in this same process.
    struct TelemetryTestFixture
    {
        juce::File dir;

        explicit TelemetryTestFixture (const juce::String& leaf)
            : dir (juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile (leaf))
        {
            dir.deleteRecursively();
            dir.createDirectory();
            mosh::setEnvVar ("MOSH_TELEMETRY_DIR", dir.getFullPathName().toRawUTF8());
            mosh::unsetEnvVar ("MOSH_TELEMETRY_URL");
            Telemetry::resetForTests();
            Breadcrumbs::resetForTests();
        }

        ~TelemetryTestFixture()
        {
            Telemetry::resetForTests();
            Breadcrumbs::resetForTests();
            TelemetryConfig::setOptedIn (false);
            mosh::unsetEnvVar ("MOSH_TELEMETRY_URL");
            mosh::unsetEnvVar ("MOSH_TELEMETRY_DIR");
            dir.deleteRecursively();
        }
    };
}

// ── sanitizeCommandName — the redaction primitive ────────────────────────────

TEST_CASE ("sanitizeCommandName keeps only the leading identifier token", "[telemetry][redaction]")
{
    REQUIRE (sanitizeCommandName ("move_clip") == "move_clip");
    REQUIRE (sanitizeCommandName ("move_clip {\"trackId\":\"secret-track\"}") == "move_clip");
    REQUIRE (sanitizeCommandName ("create_track/../../etc/passwd") == "create_track");
    REQUIRE (sanitizeCommandName ("set_lyric_line(\"my private lyrics\")") == "set_lyric_line");
    REQUIRE (sanitizeCommandName ("render_layer?seed=42") == "render_layer");
    REQUIRE (sanitizeCommandName ("") == "(unknown)");
    REQUIRE (sanitizeCommandName ("   leading space") == "(unknown)");
    REQUIRE (sanitizeCommandName ("{not a command at all}") == "(unknown)");
}

TEST_CASE ("sanitizeCommandName truncates pathological input", "[telemetry][redaction]")
{
    const juce::String huge (juce::String::repeatedString ("a", 500));
    const auto out = sanitizeCommandName (huge);
    REQUIRE (out.length() <= Breadcrumbs::kMaxNameLen);
    REQUIRE (out.isNotEmpty());
}

// ── formatCrashReport — gate requirement (a) ─────────────────────────────────

TEST_CASE ("crash report formatter redacts breadcrumbs to command names only", "[telemetry][redaction]")
{
    CrashContext ctx;
    ctx.signalNumber = 11;
    ctx.signalName   = "SIGSEGV";
    ctx.appVersion   = "1.2.3";
    ctx.osVersion    = "macOS 15.1";
    ctx.timestampIso = "2026-07-17T12:00:00Z";
    ctx.backtraceLines.add ("0   Mosh   0x0000000104f2a3d0 mosh::telemetry::testCrash() + 32");

    // Fake breadcrumbs carrying full args — a trackId, unreleased lyric text, and
    // a filesystem path — exactly the shape a bug elsewhere might accidentally
    // hand this formatter. None of it may survive into the rendered report.
    ctx.breadcrumbCommandNames.add ("move_clip {\"trackId\":\"abc123\",\"deltaSeconds\":3.2}");
    ctx.breadcrumbCommandNames.add ("set_lyric_line {\"text\":\"my secret unreleased lyrics\"}");
    ctx.breadcrumbCommandNames.add ("import_clip {\"path\":\"/Users/producer/Desktop/unreleased-track.wav\"}");

    const auto report = formatCrashReport (ctx);

    // The clean command names ARE present …
    REQUIRE (report.contains ("move_clip"));
    REQUIRE (report.contains ("set_lyric_line"));
    REQUIRE (report.contains ("import_clip"));
    // … non-breadcrumb context still renders …
    REQUIRE (report.contains ("SIGSEGV"));
    REQUIRE (report.contains ("1.2.3"));
    REQUIRE (report.contains ("macOS 15.1"));

    // … but NONE of the args/content leaked through.
    REQUIRE_FALSE (report.contains ("trackId"));
    REQUIRE_FALSE (report.contains ("abc123"));
    REQUIRE_FALSE (report.contains ("deltaSeconds"));
    REQUIRE_FALSE (report.contains ("secret"));
    REQUIRE_FALSE (report.contains ("unreleased"));
    REQUIRE_FALSE (report.contains ("/Users/producer"));
    REQUIRE_FALSE (report.contains (".wav"));
    REQUIRE_FALSE (report.contains ("{"));
    REQUIRE_FALSE (report.contains ("\""));
}

// FS-B2a — a NEW class of payload now lives in the command log's args: the user's own
// words, carried on an agent turn's batch_begin marker (turn provenance for skill
// mining). It is local-only by design. This pins the boundary: even if a future change
// fed the formatter a breadcrumb built from a whole log line, the utterance must not
// survive into a crash report — the report stays command NAMES only.
TEST_CASE ("crash report never leaks a turn utterance", "[telemetry][redaction]")
{
    CrashContext ctx;
    ctx.signalName   = "SIGSEGV";
    ctx.appVersion   = "1.2.3";
    ctx.osVersion    = "macOS 15.1";
    ctx.timestampIso = "2026-07-28T12:00:00Z";

    ctx.breadcrumbCommandNames.add (
        "batch_begin {\"name\":\"darker hook\",\"turn_id\":\"t-1\","
        "\"utterance\":\"make the hook sound like my unreleased demo\",\"source\":\"voice\"}");
    ctx.breadcrumbCommandNames.add ("create_track {\"name\":\"Lead\"}");

    const auto report = formatCrashReport (ctx);

    REQUIRE (report.contains ("batch_begin"));   // the name still renders …
    REQUIRE (report.contains ("create_track"));
    REQUIRE_FALSE (report.contains ("utterance"));            // … none of the ask does
    REQUIRE_FALSE (report.contains ("make the hook"));
    REQUIRE_FALSE (report.contains ("unreleased"));
    REQUIRE_FALSE (report.contains ("turn_id"));
    REQUIRE_FALSE (report.contains ("source"));
    REQUIRE_FALSE (report.contains ("voice"));
}

TEST_CASE ("formatCrashReport degrades gracefully with no backtrace/breadcrumbs", "[telemetry]")
{
    CrashContext ctx;
    ctx.signalName = "uncaught_exception";
    const auto report = formatCrashReport (ctx);
    REQUIRE (report.contains ("(none)"));
    REQUIRE (report.contains ("(unavailable)"));
}

// ── Breadcrumbs — redacts AT the recording boundary too (belt-and-suspenders) ─

TEST_CASE ("Breadcrumbs records and reads back sanitized names, oldest-first", "[telemetry][redaction]")
{
    Breadcrumbs::resetForTests();
    Breadcrumbs::record ("create_track");
    Breadcrumbs::record ("move_clip {\"trackId\":\"secret\"}");
    Breadcrumbs::record ("render_layer");

    Breadcrumbs::Slot slots[Breadcrumbs::kCapacity];
    const int n = Breadcrumbs::snapshot (slots, Breadcrumbs::kCapacity);
    REQUIRE (n == 3);
    REQUIRE (juce::String (slots[0].name) == "create_track");
    REQUIRE (juce::String (slots[1].name) == "move_clip"); // args stripped on the way in
    REQUIRE (juce::String (slots[2].name) == "render_layer");
    Breadcrumbs::resetForTests();
}

TEST_CASE ("Breadcrumbs ring wraps, keeping only the most recent kCapacity entries", "[telemetry]")
{
    Breadcrumbs::resetForTests();
    for (int i = 0; i < Breadcrumbs::kCapacity + 5; ++i)
        Breadcrumbs::record ("cmd_" + juce::String (i));

    Breadcrumbs::Slot slots[Breadcrumbs::kCapacity];
    const int n = Breadcrumbs::snapshot (slots, Breadcrumbs::kCapacity);
    REQUIRE (n == Breadcrumbs::kCapacity);
    REQUIRE (juce::String (slots[0].name) == "cmd_5"); // 0..4 evicted
    REQUIRE (juce::String (slots[Breadcrumbs::kCapacity - 1].name)
             == "cmd_" + juce::String (Breadcrumbs::kCapacity + 4));
    Breadcrumbs::resetForTests();
}

// ── TelemetryConfig — the opt-in flag is a plain presence file, off by default ─

TEST_CASE ("TelemetryConfig opt-in is a plain presence flag, absent by default", "[telemetry][off-by-default]")
{
    TelemetryTestFixture fx ("mosh-telemetry-config-test");
    REQUIRE_FALSE (TelemetryConfig::isOptedIn());
    REQUIRE_FALSE (TelemetryConfig::optInFile().existsAsFile());

    TelemetryConfig::setOptedIn (true);
    REQUIRE (TelemetryConfig::isOptedIn());
    REQUIRE (TelemetryConfig::optInFile().existsAsFile());

    TelemetryConfig::setOptedIn (false);
    REQUIRE_FALSE (TelemetryConfig::isOptedIn());
    REQUIRE_FALSE (TelemetryConfig::optInFile().existsAsFile());
}

TEST_CASE ("TelemetryConfig::installId mints once and persists across calls", "[telemetry]")
{
    TelemetryTestFixture fx ("mosh-telemetry-id-test");
    const auto first = TelemetryConfig::installId();
    REQUIRE (first.isNotEmpty());
    REQUIRE (TelemetryConfig::installId() == first);
}

TEST_CASE ("TelemetryConfig::installId reuses the engine's session identity when present", "[telemetry]")
{
    TelemetryTestFixture fx ("mosh-telemetry-id-reuse-test");
    auto sessionDir = fx.dir.getChildFile ("session");
    sessionDir.createDirectory();
    sessionDir.getChildFile ("identity.json").replaceWithText ("{\"installId\":\"reused-id-123\"}");

    REQUIRE (TelemetryConfig::installId() == "reused-id-123");
}

// ── Telemetry — gate requirement (b): OFF by default ─────────────────────────

TEST_CASE ("Telemetry touches no file and no network when opted out (the default)", "[telemetry][off-by-default]")
{
    TelemetryTestFixture fx ("mosh-telemetry-offdefault-test");
    REQUIRE_FALSE (TelemetryConfig::isOptedIn()); // nobody created the optin file

    Telemetry::onAppLaunch();
    REQUIRE_FALSE (Telemetry::isRunningForTests());

    Telemetry::onCommand ("move_clip"); // must be a silent, stateless no-op

    bool uploaderCalled = false;
    Telemetry::flush ([&] (const juce::String&, const juce::String&)
    {
        uploaderCalled = true;
        return true;
    });

    REQUIRE_FALSE (uploaderCalled);
    REQUIRE_FALSE (Telemetry::isRunningForTests());
    REQUIRE_FALSE (fx.dir.getChildFile ("telemetry").getChildFile ("state.json").existsAsFile());
    // Opting out never even creates the module's own state directory.
    REQUIRE_FALSE (fx.dir.getChildFile ("telemetry").isDirectory());
}

TEST_CASE ("Telemetry counts commands and persists locally when opted in, with no endpoint configured", "[telemetry]")
{
    TelemetryTestFixture fx ("mosh-telemetry-optedin-test");
    TelemetryConfig::setOptedIn (true);

    Telemetry::onAppLaunch();
    REQUIRE (Telemetry::isRunningForTests());

    Telemetry::onCommand ("move_clip");
    Telemetry::onCommand ("move_clip");
    Telemetry::onCommand ("render_layer");

    bool uploaderCalled = false;
    Telemetry::flush ([&] (const juce::String&, const juce::String&)
    {
        uploaderCalled = true;
        return true;
    });

    auto stateFile = fx.dir.getChildFile ("telemetry").getChildFile ("state.json");
    REQUIRE (stateFile.existsAsFile());
    auto parsed = juce::JSON::parse (stateFile.loadFileAsString());
    REQUIRE ((int) parsed.getProperty ("launches", 0) >= 1);
    REQUIRE ((int) parsed.getProperty ("commandCounts", juce::var()).getProperty ("move_clip", 0) == 2);
    REQUIRE ((int) parsed.getProperty ("commandCounts", juce::var()).getProperty ("render_layer", 0) == 1);

    // Local-only: no MOSH_TELEMETRY_URL was configured, so the uploader is never called.
    REQUIRE_FALSE (uploaderCalled);
}

TEST_CASE ("Telemetry uploads only when BOTH opted in and MOSH_TELEMETRY_URL is set (via an injected uploader — never real network)",
           "[telemetry]")
{
    TelemetryTestFixture fx ("mosh-telemetry-upload-test");
    TelemetryConfig::setOptedIn (true);
    mosh::setEnvVar ("MOSH_TELEMETRY_URL", "https://example.invalid/ingest");

    Telemetry::onAppLaunch();
    Telemetry::onCommand ("accept_render");

    juce::String seenUrl, seenBody;
    bool called = false;
    Telemetry::flush ([&] (const juce::String& url, const juce::String& body)
    {
        called  = true;
        seenUrl = url;
        seenBody = body;
        return true;
    });

    REQUIRE (called);
    REQUIRE (seenUrl == "https://example.invalid/ingest");
    REQUIRE (seenBody.contains ("accept_render"));
    // The upload payload is the same shape as local state — install id + counts —
    // never raw args (there are none to leak: onCommand only ever receives
    // already-sanitized names, per WebBridge.cpp's execute_command hook).
    REQUIRE_FALSE (seenBody.contains ("trackId"));
}

TEST_CASE ("Telemetry stops within one flush after a mid-session opt-out", "[telemetry]")
{
    TelemetryTestFixture fx ("mosh-telemetry-midsession-optout-test");
    TelemetryConfig::setOptedIn (true);
    Telemetry::onAppLaunch();
    REQUIRE (Telemetry::isRunningForTests());

    TelemetryConfig::setOptedIn (false); // the user flips the Settings toggle off mid-session

    bool uploaderCalled = false;
    Telemetry::flush ([&] (const juce::String&, const juce::String&)
    {
        uploaderCalled = true;
        return true;
    });

    REQUIRE_FALSE (Telemetry::isRunningForTests());
    REQUIRE_FALSE (uploaderCalled);
}

// ── writeCrashReportForTests — the same write path the real handler uses ─────

TEST_CASE ("writeCrashReportForTests writes a redacted report under diagnosticsDir", "[telemetry][redaction]")
{
    TelemetryTestFixture fx ("mosh-telemetry-writereport-test");

    juce::StringArray dirty;
    dirty.add ("set_lyric_line {\"text\":\"unreleased lyrics here\"}");
    dirty.add ("import_clip {\"path\":\"/Users/producer/secret.wav\"}");

    auto file = writeCrashReportForTests (11, "SIGSEGV", dirty);
    REQUIRE (file.existsAsFile());
    REQUIRE (file.getParentDirectory() == TelemetryConfig::diagnosticsDir());

    const auto content = file.loadFileAsString();
    REQUIRE (content.contains ("SIGSEGV"));
    REQUIRE (content.contains ("set_lyric_line"));
    REQUIRE (content.contains ("import_clip"));
    REQUIRE_FALSE (content.contains ("unreleased"));
    REQUIRE_FALSE (content.contains ("secret.wav"));
    REQUIRE_FALSE (content.contains ("/Users/producer"));
}

// ── Live-crash path: fork a child, trigger a REAL SIGSEGV, and prove the actual
//    signal handler (not just the deterministic test hook above) writes a
//    redacted report. macOS/Linux only — Windows has no POSIX signal handlers
//    here (see CrashHandler.h); fork() doesn't exist there either. ────────────

#if JUCE_MAC || JUCE_LINUX
TEST_CASE ("a real SIGSEGV in a forked child is caught and writes a redacted local report",
           "[telemetry][live-crash]")
{
    TelemetryTestFixture fx ("mosh-telemetry-livecrash-test");

    // A breadcrumb the CHILD inherits via fork() — proves the REAL signal handler
    // (not the test hook) redacts breadcrumbs pulled from the live ring.
    Breadcrumbs::record ("set_lyric_line {\"text\":\"do not leak this lyric\"}");

    const pid_t pid = fork();
    REQUIRE (pid >= 0);

    if (pid == 0)
    {
        // CHILD PROCESS: install fresh handlers against the scratch dir (bypassing
        // the one-shot guard so this is deterministic regardless of whether some
        // earlier test in this binary already called installCrashHandler()), then
        // genuinely fault. No Catch2 assertions here — this process is about to
        // die; everything is checked by the PARENT after waitpid().
        installCrashHandlerForTests();
        volatile int* bad = nullptr;
        *bad = 1;             // real SIGSEGV, caught by the sigaction handler
        _exit (99);            // unreachable if the handler + re-raise worked
    }

    int status = 0;
    REQUIRE (waitpid (pid, &status, 0) == pid);
    REQUIRE (WIFSIGNALED (status));
    REQUIRE (WTERMSIG (status) == SIGSEGV);

    auto diag = TelemetryConfig::diagnosticsDir();
    auto reports = diag.findChildFiles (juce::File::findFiles, false, "crash-*.txt");
    REQUIRE (reports.size() == 1);

    const auto content = reports[0].loadFileAsString();
    REQUIRE (content.contains ("SIGSEGV"));
    REQUIRE (content.contains ("set_lyric_line"));
    REQUIRE_FALSE (content.contains ("do not leak"));
    REQUIRE_FALSE (content.contains ("{"));
}
#endif
