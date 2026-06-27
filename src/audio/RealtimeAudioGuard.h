#pragma once

// RT-SAFETY TRIPWIRE (debug-only).
//
// "The audio thread never allocates / locks / does file I/O" is a load-bearing claim in
// Mosh (CLAUDE.md prime directives) — but it has been comment-and-code-review discipline
// only. This turns it into an enforced tripwire: in DEBUG builds, wrapping a real-time
// audio callback in MOSH_RT_SCOPE() marks the current thread as "inside the RT callback";
// a global operator new/delete override (RealtimeAudioGuard.cpp) then fires the violation
// handler (jassertfalse by default) if anything heap-allocates while that flag is set.
//
// The flag is thread_local, so the override only ever fires on the exact thread currently
// inside a guarded applyToBuffer. anira's background inference thread (which legitimately
// allocates), the message thread, and service-I/O threads are untouched.
//
// Enabled only when MOSH_RT_GUARD is defined (Debug app + the MoshTests target). In Release
// the whole thing collapses to empty inline no-ops — zero symbols, byte-identical binary.

#include <thread>

namespace mosh::rtguard
{
#if MOSH_RT_GUARD
    // Per-thread depth of nested RT scopes (>0 ⇒ this thread is inside a real-time callback).
    extern thread_local int g_rtDepth;

    inline bool onAudioThreadNow() noexcept { return g_rtDepth > 0; }

    // RAII marker. Reentrancy-safe via a depth counter (not a bool) so nested guarded
    // callbacks behave. Move/copy disabled — strictly scope-bound.
    struct ScopedRealtime
    {
        ScopedRealtime()  noexcept { ++g_rtDepth; }
        ~ScopedRealtime() noexcept { --g_rtDepth; }
        ScopedRealtime (const ScopedRealtime&) = delete;
        ScopedRealtime& operator= (const ScopedRealtime&) = delete;
    };

    // Test seam: total violations observed since process start, and a hook to replace the
    // default jassertfalse handler (so unit tests can COUNT violations instead of aborting).
    long violationCount() noexcept;
    void setViolationHandler (void (*handler)()) noexcept;
#else
    struct ScopedRealtime { ScopedRealtime() noexcept {} };
    inline bool onAudioThreadNow() noexcept { return false; }
#endif
}

#if MOSH_RT_GUARD
 #define MOSH_RT_SCOPE() ::mosh::rtguard::ScopedRealtime _mosh_rt_scope_
#else
 #define MOSH_RT_SCOPE() ((void) 0)
#endif
