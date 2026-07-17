#pragma once

#include <juce_core/juce_core.h>
#include <functional>

namespace mosh::telemetry
{

/**
    Anonymous, OPT-IN-ONLY usage counters: launch count, session length, and a
    command-name histogram. See docs/telemetry/PRIVACY.md for the exact data shape
    and retention. Companion to CrashHandler (crashes) — this covers ordinary,
    non-crashing usage.

    THE GATE: every public entry point checks TelemetryConfig::isOptedIn() (or the
    in-memory flag onAppLaunch() sets from it) BEFORE touching a file or a socket.
    Opted out (default) ⇒ onAppLaunch()/onCommand()/flush() are all immediate
    no-ops — no file read, no file write, no network attempt, not even a call
    into the injectable `Uploader`. This is what the Catch2 "telemetry is OFF by
    default" test pins.

    State persists to `<root>/telemetry/state.json` (TelemetryConfig::
    telemetryStateDir()) — a single small JSON object, overwritten (not appended)
    on each flush: {installId, launches, totalSessionSeconds, commandCounts}.

    Upload is pluggable + best-effort: `flush()` only ever calls its Uploader when
    BOTH isOptedIn() AND the MOSH_TELEMETRY_URL environment variable are set. The
    default uploader POSTs via juce::URL; tests inject a spy so no test ever makes
    a real network call (see tests/test_telemetry.cpp).

    Threading: in a normal (non-MOSH_TESTING) build, onAppLaunch() starts one
    detached background thread that calls flush() on a fixed interval so session
    length + the histogram are captured without needing a clean-shutdown hook
    (Main.cpp's shutdown() is out of scope for this module — see CLAUDE.md
    coordination note). Under MOSH_TESTING, that thread is never started —
    tests call flush() directly for fully deterministic, timing-free assertions.
*/
class Telemetry
{
public:
    /** (url, jsonBody) -> true on a successful send. Injectable for tests. */
    using Uploader = std::function<bool (const juce::String& url, const juce::String& jsonBody)>;

    /** Production default: POSTs jsonBody to url via juce::URL. Never called by
        flush() unless both isOptedIn() and MOSH_TELEMETRY_URL are set. */
    static bool defaultUploader (const juce::String& url, const juce::String& jsonBody);

    /** Call once at process start. No-op (immediately) unless
        TelemetryConfig::isOptedIn(). When opted in: resolves the install id,
        loads/increments the persisted launch count, marks the session start
        time, and (outside MOSH_TESTING builds) starts the background flush
        thread. Idempotent — a second call in the same process is a no-op. */
    static void onAppLaunch();

    /** Record one command execution into the in-memory histogram. Cheap
        in-memory-only no-op unless onAppLaunch() has already run (opted-in) this
        process — never touches TelemetryConfig::isOptedIn() itself (that file
        stat happens once, at onAppLaunch()/flush() time) so this can be called on
        every single command without extra filesystem cost. `name` must already be
        a sanitized command name (see CrashReportFormatter::sanitizeCommandName —
        WebBridge's execute_command hook passes the same sanitized value it hands
        Breadcrumbs::record(), so this module never even receives raw args). */
    static void onCommand (const juce::String& sanitizedCommandName);

    /** Re-checks isOptedIn(): if it has flipped to false since onAppLaunch()
        (mid-session opt-out via Settings), clears in-memory state and stops —
        no further file/network activity until a future onAppLaunch(). Otherwise
        persists the current counters to state.json and, IFF MOSH_TELEMETRY_URL is
        set, calls `uploader` with the same payload. Called periodically by the
        background thread in production; tests call it directly. */
    static void flush (Uploader uploader = &defaultUploader);

    // ── test-only ────────────────────────────────────────────────────────────
    static void resetForTests();
    static bool isRunningForTests();
    static juce::var stateForTests();
};

} // namespace mosh::telemetry
