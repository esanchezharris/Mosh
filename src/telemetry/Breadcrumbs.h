#pragma once

#include <juce_core/juce_core.h>
#include <mutex>

namespace mosh::telemetry
{

/**
    A fixed-capacity ring buffer of the last N MoshOps command NAMES ONLY.

    Recorded from WebBridge's `execute_command` native function (the one chokepoint
    every UI- and agent-issued command passes through) on the message thread; read
    back by CrashHandler after a crash, which may be handling a signal raised on
    ANY thread (the audio thread, a background job thread, …).

    PRIVACY: record() takes a raw string and immediately reduces it to a safe
    "command name" token via sanitizeCommandName() (CrashReportFormatter.h) BEFORE
    it is copied into the ring — so even if a caller passes a full command blob
    (name + args), only the leading identifier token is ever retained. Nothing
    else this type touches (args, file paths, audio, lyrics, project content) is
    ever stored.

    SAFETY: fixed-size storage, no heap allocation on either path. The single
    std::mutex protects the ring; record() takes it unconditionally (a normal,
    very short critical section on the message thread), while snapshot() — the
    path a signal handler may call — uses try_lock and simply returns "nothing new
    since last time" (0 slots) if the lock is held, so a crash can NEVER deadlock
    waiting on a breadcrumb. Reading fewer/no breadcrumbs is an acceptable
    degradation; blocking forever inside a signal handler is not.
*/
class Breadcrumbs
{
public:
    static constexpr int kCapacity  = 16;
    static constexpr int kMaxNameLen = 63;

    struct Slot
    {
        char name[kMaxNameLen + 1] = {};
    };

    /** Record one command name (already-sanitized to a safe token; overwrites the
        oldest slot once the ring is full). Safe to call only from a normal
        (non-signal-handler) context — takes the mutex unconditionally. */
    static void record (const juce::String& rawCommandName);

    /** Copy up to `outCapacity` slots (oldest-first) into `out`; returns the count
        actually written. Signal-handler-safe: never blocks (try_lock), never
        allocates, never throws. Returns 0 if the lock could not be taken (the
        message thread happened to be mid-record at the exact moment of the crash —
        vanishingly rare, and simply means the report's breadcrumb section reads
        "(none)" rather than risking a deadlock). */
    static int snapshot (Slot* out, int outCapacity) noexcept;

    /** Test-only: clear the ring back to empty and reset the write cursor. */
    static void resetForTests();

private:
    static std::mutex mutex_;
    static Slot ring_[kCapacity];
    static int count_;   // number of valid slots (0..kCapacity)
    static int next_;    // next write index (wraps)
};

} // namespace mosh::telemetry
