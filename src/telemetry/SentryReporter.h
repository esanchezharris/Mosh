#pragma once

#include <juce_core/juce_core.h>

namespace mosh::telemetry
{

/**
    FS-K3 — Sentry Native SDK (crashpad backend, out-of-process handler).

    BUILD-GATED OFF BY DEFAULT. This translation unit is compiled unconditionally,
    but every SDK call lives behind `#if MOSH_HAVE_SENTRY`, which is defined only
    when the app is configured with `-DMOSH_ENABLE_SENTRY=ON` (see cmake/Sentry.cmake).
    The default build therefore links no sentry-native, fetches nothing at configure
    time, and compiles this file down to the no-op branch — the same "gates its body,
    not its existence" shape RaveEngine.cpp uses for anira (see tests/CMakeLists.txt).
    That is what keeps every --selftest / Catch2 / vitest baseline byte-for-byte
    unaffected by this lane, and it is why the pure helpers below are testable in
    MoshTests, which never defines MOSH_HAVE_SENTRY.

    CONSENT — reused, not rebuilt. PR #406 already shipped the single opt-in bit
    (TelemetryConfig::isOptedIn(): presence of ~/Library/Mosh/telemetry.optin,
    default ABSENT = opted out) plus the UI toggle and the `set_telemetry_optin`
    WebBridge seam that writes it. Sentry reads that same bit and adds NO second
    consent flag and no new MoshOps command. Opted out (the default) => init() is an
    immediate no-op: no database directory, no handler process, no network.

    ── What client-side PII control actually is here (verified against the 0.15.4
       header, NOT assumed) ────────────────────────────────────────────────────────
    With the *crashpad* backend on macOS the crash payload is a minidump written and
    uploaded by the out-of-process handler. sentry.h is explicit that neither hook
    can rewrite it:
      • `on_crash`   — "does not work with crashpad on macOS";
      • `before_send`— replaced by on_crash for crash events, and in any case not in
                       crashpad's out-of-process upload path.
    So "PII scrubbing on crash payloads" CANNOT mean "rewrite the minidump in a
    callback". It means, and is implemented as, two things that do work:

      1. MINIMISE AT SOURCE — the only thing that reliably keeps data out of a
         minidump is never putting it in the process's Sentry state. init() sets no
         user context, attaches no environment block and no files, and calls
         sentry_remove_user() to drop the identifier the SDK attaches by itself (see
         the note at that call — it reached the wire before this was added, and
         before_send cannot remove it). Breadcrumbs are already command-NAMES-only
         (#406, Breadcrumbs + sanitizeCommandName). A captured crash event ends up
         carrying only: event_id, level, platform, release, environment, SDK version.
         (There is no send_default_pii(0) call to point at: that setter is
         Nintendo-Switch-only in sentry.h — `#ifdef SENTRY_PLATFORM_NX` — and does
         not compile on macOS.)
      2. SCRUB EVERY EVENT WE CAN REACH — scrubEvent() is installed as `before_send`,
         which DOES run for every non-crash event (anything captured explicitly), and
         is applied to the context object init() attaches. This is the tested path.

    A minidump still contains stack memory by construction — that is what a crash
    report IS. It is why this whole feature is opt-in AND build-gated off, and why
    docs/telemetry/PRIVACY.md says so plainly rather than implying the minidump is
    scrubbed.

    THREADING / TIER WALL: crashpad is out-of-process. In-process code only INSTALLS
    the handler once, at startup, from CrashHandler::installCommon() — the same
    single entry point #406 established. There are zero Sentry calls on the audio
    thread and no allocation in any RT path; nothing in this module is reachable from
    applyToBuffer().
*/

// ─── Pure helpers — ALWAYS compiled, no SDK required (this is the tested core) ───

/** Replace absolute home paths with "~" anywhere in `text`: "/Users/<name>/…" and
    "/home/<name>/…" both collapse to "~/…". Catches the single most common way a
    real name leaks into a report (a project path, a dylib path, a temp file). Every
    string that survives scrubEvent() is passed through this. */
juce::String scrubText (const juce::String& text);

/** True if a field with this NAME must be dropped wholesale rather than scrubbed:
    anything matching *_KEY / *TOKEN* / *SECRET* / *PASSWORD* / *CREDENTIAL* /
    Authorization / Cookie / Set-Cookie, and the per-install identifier
    (installId / install_id), which is a correlation handle we deliberately do not
    ship to a third party. Case-insensitive — Sentry event keys are not normalised. */
bool isSensitiveKey (const juce::String& key);

/** Recursively scrub an event tree: any object member whose NAME isSensitiveKey() is
    dropped entirely (not blanked — absent), and every surviving string value is
    rewritten through scrubText(). Objects and arrays are walked to arbitrary depth.
    Pure: no I/O, no clock, no env reads — which is what makes it directly unit
    testable in MoshTests with no DSN, no network, and no SDK linked. */
juce::var scrubEvent (const juce::var& event);

/** The DSN this build would use, or an empty string if none is configured.
    Resolution order: the MOSH_SENTRY_DSN environment variable, then a bundled
    Resources/sentry.dsn file. A DSN is a PUBLIC client-side ingest key and may ship;
    the dSYM-UPLOAD auth token is a secret and must never be in the bundle (that is
    what scripts/release/upload-dsyms.sh keeps env-only). Empty is the current real
    state: FS-K3's Sentry project is BLOCKED-ON-OWNER. */
juce::String sentryDsn();

/** Whether initSentryReporter() would actually start the SDK: requires BOTH the
    #406 opt-in bit AND a configured DSN. Opt-out therefore wins unconditionally,
    even with a DSN present. Callable (and tested) in the default no-SDK build. */
bool wouldInitialise();

/** True only in a `-DMOSH_ENABLE_SENTRY=ON` build. Lets tests and the selftest state
    plainly which branch they are exercising instead of guessing. */
bool isSentryCompiledIn();

/** Crashpad's database/attachment directory: <TelemetryConfig::root()>/crashpad,
    i.e. ~/Library/Mosh/crashpad by default (MOSH_TELEMETRY_DIR relocates it for
    tests). Never under ~/Documents — iCloud evicts file contents (CLAUDE.md). */
juce::File crashpadDatabaseDir();

// ─── Gated lifecycle — no-ops unless MOSH_HAVE_SENTRY ────────────────────────────

/** Start the SDK if wouldInitialise(). Called once from
    CrashHandler::installCommon(), AFTER that function's POSIX handlers are in
    place. Idempotent. A no-op in the default build. */
void initSentryReporter();

/** Flush + close the SDK if it was started. Safe to call when it was not. */
void shutdownSentryReporter();

} // namespace mosh::telemetry
