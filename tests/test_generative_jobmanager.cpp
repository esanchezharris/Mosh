#include <catch2/catch_test_macros.hpp>
#include "generative/GenerativeJobManager.h"
#include <cstdlib>
#include <thread>
#include <vector>
#include <atomic>

// Concurrency smoke for GenerativeJobManager's thread-safe read surface.
//
// MoshOps drives this manager from many detached worker threads (render poll / transcribe /
// sketch / lyric-gen / analyze / skeleton / corpus-add) AND the message thread reads
// serviceBuild() while fingerprinting. Before the stateLock/spawnLock fix, the non-atomic
// juce::String members (baseUrl, svcBuild) were read on one thread while reassigned on
// another — a torn COW refcount / use-after-free. The manager now copies those Strings under
// a CriticalSection.
//
// A DETERMINISTIC data-race proof needs ThreadSanitizer (or a live service to drive the
// svcBuild WRITE); this hermetic unit test instead pins the CONTRACT and guards regressions:
//   * it forces the refactored class to compile + link into the unit target, and
//   * it stresses the public read paths (serviceBuild() + isHealthy()) from many threads to
//     assert the locking neither deadlocks nor crashes.
// isHealthy() is pointed at a dead port (fast connection-refused on loopback) so it never
// spawns the Python service and stays hermetic.
namespace
{
    struct ScopedEnv
    {
        const char* key;
        juce::String prev;
        bool had = false;
        ScopedEnv (const char* k, const juce::String& v) : key (k)
        {
            if (auto* p = std::getenv (k)) { prev = p; had = true; }
           #if JUCE_WINDOWS
            _putenv_s (k, v.toRawUTF8());
           #else
            ::setenv (k, v.toRawUTF8(), 1);
           #endif
        }
        ~ScopedEnv()
        {
           #if JUCE_WINDOWS
            _putenv_s (key, had ? prev.toRawUTF8() : "");
           #else
            if (had) ::setenv (key, prev.toRawUTF8(), 1); else ::unsetenv (key);
           #endif
        }
    };
}

TEST_CASE ("GenerativeJobManager read surface is concurrency-safe", "[generative][concurrency]")
{
    // Aim the manager at a port nothing listens on, so isHealthy() fails fast (refused) and
    // never triggers a spawn — keeps the test hermetic and quick.
    ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
    ScopedEnv port ("MOSH_SERVICE_PORT", "59991");

    mosh::GenerativeJobManager mgr;

    // No service is up, so no /health probe ever succeeds → svcBuild is never written and
    // stays empty. Any torn read here would surface as a crash under a sanitizer / in the wild.
    constexpr int kThreads = 8;
    constexpr int kIters   = 200;
    std::atomic<int> healthyCount { 0 };

    std::vector<std::thread> pool;
    pool.reserve (kThreads);
    for (int t = 0; t < kThreads; ++t)
    {
        pool.emplace_back ([&, t]
        {
            for (int i = 0; i < kIters; ++i)
            {
                if (t % 2 == 0)
                {
                    // Reader: mirrors the message-thread fingerprint read.
                    auto b = mgr.serviceBuild();
                    REQUIRE (b.isEmpty());
                }
                else
                {
                    // Failed probe: drives the currentBaseUrl() read path (and the not-taken
                    // svcBuild write branch). 1ms connect timeout → immediate refused connect.
                    if (mgr.isHealthy (1))
                        healthyCount.fetch_add (1);
                }
            }
        });
    }
    for (auto& th : pool)
        th.join();

    // Nothing was listening, so no probe should have reported healthy, and the build id read
    // by every reader thread stayed the (empty) initial value without tearing.
    CHECK (healthyCount.load() == 0);
    CHECK (mgr.serviceBuild().isEmpty());
}
