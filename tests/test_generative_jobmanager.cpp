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
    // NB: Catch2's REQUIRE/CHECK are NOT thread-safe (they race a shared result counter), so the
    // worker threads record into atomics only — every assertion runs on the main thread post-join.
    constexpr int kThreads = 8;
    constexpr int kIters   = 200;
    std::atomic<int> healthyCount   { 0 };   // probes that (wrongly) reported healthy
    std::atomic<int> nonEmptyBuilds { 0 };   // reads that saw a non-empty svcBuild (torn/unexpected)

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
                    if (mgr.serviceBuild().isNotEmpty())
                        nonEmptyBuilds.fetch_add (1);
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
    CHECK (healthyCount.load()   == 0);
    CHECK (nonEmptyBuilds.load() == 0);
    CHECK (mgr.serviceBuild().isEmpty());
}

// A confirmed playtest-blocker: on a guest Mac with no working python3 (or a broken venv),
// the spawned child dies almost instantly, but ensureServiceRunning()'s warmup loop had NO
// liveness check on the child — it polled blindly for up to ~30s (150 x 200ms Thread::sleep)
// regardless. Opening the Gen inspector fires THREE such calls back-to-back (list_colors,
// list_transform_targets, list_loras), all synchronously on the message thread via
// execute_command → MoshOps::execute → cmdList*() → jobManager.ensureServiceRunning() — so a
// single Gen-tab open could beachball the whole app for ~90s, repeated on every re-open.
//
// This test spawns a REAL python3 (present on the test machine) running a throwaway script
// that exits immediately — the "child dies right away" failure mode — and asserts
// ensureServiceRunning() returns unavailable in well under a second, not ~30s. It also proves
// the failure is cached for a short backoff window: a second call right after the first must
// not re-spawn a fresh child (the counter file the script writes is touched only once).
TEST_CASE ("ensureServiceRunning bails fast when the spawned child dies immediately", "[generative][spawn]")
{
    juce::File tmpDir = juce::File::createTempFile ("mosh-dead-child");
    tmpDir.deleteFile();
    tmpDir.createDirectory();
    struct Cleanup { juce::File d; ~Cleanup() { d.deleteRecursively(); } } cleanup { tmpDir };

    auto counterFile = tmpDir.getChildFile ("spawn_count.txt");
    const juce::String counterPath = counterFile.getFullPathName().replace ("\\", "\\\\");

    // No "run.sh" sibling next to this script, so ensureServiceRunning's POSIX fallback execs
    // the literal system `python3` directly on it (see GenerativeJobManager.cpp) — a real
    // interpreter that dies right away, exactly like a broken/absent-venv guest install.
    // Each invocation appends one line to counterFile before exiting, so the test can prove
    // the failure-backoff window prevents a second spawn.
    auto script = tmpDir.getChildFile ("server.py");
    script.replaceWithText (
        juce::String ("import sys\n")
        + "with open(\"" + counterPath + "\", \"a\") as f:\n"
        + "    f.write(\"1\\n\")\n"
        + "sys.exit(1)\n");

    ScopedEnv host   ("MOSH_SERVICE_HOST", "127.0.0.1");
    ScopedEnv port   ("MOSH_SERVICE_PORT", "59993");            // nothing listens here
    ScopedEnv svc    ("MOSH_SERVICE_SCRIPT", script.getFullPathName());

    mosh::GenerativeJobManager mgr;

    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    const bool ok = mgr.ensureServiceRunning();
    const auto elapsedMs = juce::Time::getMillisecondCounterHiRes() - t0;

    CHECK_FALSE (ok);
    // The old code's ceiling was ~30000ms (150 x 200ms); the early-bail must land far under
    // that. Generous bound for slow CI machines while still proving the freeze is gone.
    CHECK (elapsedMs < 5000.0);

    // Immediately call again: within the failure backoff window this must return fast AND
    // without spawning a second child.
    const auto t1 = juce::Time::getMillisecondCounterHiRes();
    const bool ok2 = mgr.ensureServiceRunning();
    const auto elapsedMs2 = juce::Time::getMillisecondCounterHiRes() - t1;

    CHECK_FALSE (ok2);
    CHECK (elapsedMs2 < 1000.0);

    // The backoff must have skipped a second spawn attempt entirely: the script ran exactly
    // once (one "1\n" line), not twice.
    const auto spawns = juce::StringArray::fromLines (counterFile.loadFileAsString());
    const int spawnCount = [&] { int n = 0; for (auto& l : spawns) if (l.trim().isNotEmpty()) ++n; return n; }();
    CHECK (spawnCount == 1);
}
