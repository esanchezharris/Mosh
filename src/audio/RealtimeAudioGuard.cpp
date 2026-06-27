#include "audio/RealtimeAudioGuard.h"

// Self-gating: in Release (MOSH_RT_GUARD undefined) this TU compiles to NOTHING — no global
// operator new/delete override, no symbols, the binary is byte-unaffected.
#if MOSH_RT_GUARD

#include <atomic>
#include <cstdlib>
#include <new>
#include <juce_core/juce_core.h>

namespace mosh::rtguard
{
    // Constant-initialised (zero / captureless-lambda-to-pointer is constexpr in C++17), so
    // there is NO static-init-order hazard even though we replace the global allocator: any
    // allocation during static init sees g_rtDepth == 0 and is ignored.
    thread_local int g_rtDepth = 0;

    namespace
    {
        std::atomic<long> g_violations { 0 };
        void (*g_handler)() = [] { jassertfalse; };   // default: break in the debugger
    }

    long violationCount() noexcept { return g_violations.load (std::memory_order_relaxed); }
    void setViolationHandler (void (*handler)()) noexcept { g_handler = handler; }

    // The hot check. Returns immediately unless THIS thread is inside a guarded RT scope, so
    // the only cost on every other thread is one thread-local read per allocation (debug only).
    inline void rtCheck() noexcept
    {
        if (onAudioThreadNow())
        {
            g_violations.fetch_add (1, std::memory_order_relaxed);
            if (g_handler != nullptr) g_handler();
        }
    }
}

// ── Global replaceable allocation functions (debug build only) ───────────────────────────
// We override the standard throwing new/new[] (which catches the transitive heap traffic the
// comment-only discipline tries to prevent: std::vector/juce::String/std::function temporaries
// etc.) plus the matching deletes. Aligned/nothrow forms are intentionally NOT overridden —
// the default nothrow new routes through the throwing new (so it is still checked), and aligned
// allocations are rare in RT code; keeping the set minimal avoids platform aligned-free pitfalls.
void* operator new (std::size_t n)
{
    ::mosh::rtguard::rtCheck();
    if (void* p = std::malloc (n != 0 ? n : 1)) return p;
    throw std::bad_alloc{};
}

void* operator new[] (std::size_t n)
{
    ::mosh::rtguard::rtCheck();
    if (void* p = std::malloc (n != 0 ? n : 1)) return p;
    throw std::bad_alloc{};
}

void operator delete (void* p) noexcept            { std::free (p); }
void operator delete[] (void* p) noexcept          { std::free (p); }
void operator delete (void* p, std::size_t) noexcept   { std::free (p); }
void operator delete[] (void* p, std::size_t) noexcept { std::free (p); }

#endif // MOSH_RT_GUARD
