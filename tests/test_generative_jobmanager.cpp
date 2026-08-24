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

// GEN-WARMUP — the dead-child test above proves the fast-bail path; this proves the OTHER
// half of the same warmup loop still works: a child that stays alive and takes a real few
// hundred ms before it can answer /health (spawn + interpreter import +, for SA3/MLX, model
// load) must be waited out, not abandoned. Spawns a real python3 running a throwaway
// http.server script that sleeps briefly (simulating that cold-start window) before it starts
// answering GET /health — a "slow but eventually healthy" service, as distinct from both the
// already-covered dead-child case and an instantly-healthy one.
TEST_CASE ("ensureServiceRunning waits out a slow-but-alive cold start instead of giving up", "[generative][spawn]")
{
    juce::File tmpDir = juce::File::createTempFile ("mosh-slow-warmup");
    tmpDir.deleteFile();
    tmpDir.createDirectory();
    struct Cleanup { juce::File d; ~Cleanup() { d.deleteRecursively(); } } cleanup { tmpDir };

    auto script = tmpDir.getChildFile ("server.py");
    script.replaceWithText (
        "import http.server, os, time\n"
        "time.sleep(0.6)\n"   // the simulated cold-start window (import + warmup)
        "port = int(os.environ.get('MOSH_SERVICE_PORT', '0'))\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        if self.path == '/health':\n"
        "            body = b'{\"ok\": true, \"build\": \"warmup-test\"}'\n"
        "            self.send_response(200)\n"
        "            self.send_header('Content-Type', 'application/json')\n"
        "            self.send_header('Content-Length', str(len(body)))\n"
        "            self.end_headers()\n"
        "            self.wfile.write(body)\n"
        "        else:\n"
        "            self.send_response(404); self.end_headers()\n"
        "    def log_message(self, *a): pass\n"
        "http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()\n");

    ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
    ScopedEnv port ("MOSH_SERVICE_PORT", "59994");
    ScopedEnv svc  ("MOSH_SERVICE_SCRIPT", script.getFullPathName());

    mosh::GenerativeJobManager mgr;

    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    const bool ok = mgr.ensureServiceRunning();
    const auto elapsedMs = juce::Time::getMillisecondCounterHiRes() - t0;

    CHECK (ok);
    // Must have actually waited PAST the simulated cold-start sleep (proves the warmup loop
    // didn't just get lucky on an instant retry) ...
    CHECK (elapsedMs >= 500.0);
    // ... but well under the ~30s ceiling — the 200ms poll granularity should catch the
    // service within a second or so of it opening the port. Generous bound for slow CI.
    CHECK (elapsedMs < 10000.0);
    CHECK (mgr.serviceBuild() == "warmup-test");

    // The manager's destructor kills the child it spawned (cancel-on-close, 05 §4) — no
    // manual teardown needed here, matching the dead-child test above.
}

// GEN-WARMUP — cancelJob() used to be pure fire-and-forget: the POST result was never read,
// so a /cancel that never reached a dead service looked identical to a real one. This proves
// both new behaviours: (1) a totally unreachable service (nothing listening — the "service
// was killed mid-cancel" case from the ticket's verify steps) makes cancelJob() report
// failure rather than silently claiming success, and (2) a single dropped/malformed response
// is retried once and a real acknowledgement on that retry is still reported as success.
TEST_CASE ("cancelJob verifies the /cancel acknowledgement instead of firing-and-forgetting", "[generative][cancel]")
{
    SECTION ("unreachable service — both the initial attempt and the retry fail")
    {
        ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
        ScopedEnv port ("MOSH_SERVICE_PORT", "59996");   // nothing listens here

        mosh::GenerativeJobManager mgr;
        CHECK_FALSE (mgr.cancelJob ("job-1"));
    }

    SECTION ("first response is malformed, second is a real acknowledgement — the retry saves it")
    {
        juce::File tmpDir = juce::File::createTempFile ("mosh-cancel-retry");
        tmpDir.deleteFile();
        tmpDir.createDirectory();
        struct Cleanup { juce::File d; ~Cleanup() { d.deleteRecursively(); } } cleanup { tmpDir };

        auto script = tmpDir.getChildFile ("server.py");
        script.replaceWithText (
            "import http.server, os\n"
            "port = int(os.environ.get('MOSH_SERVICE_PORT', '0'))\n"
            "count = {'n': 0}\n"
            "class H(http.server.BaseHTTPRequestHandler):\n"
            "    def do_POST(self):\n"
            "        length = int(self.headers.get('Content-Length', 0))\n"
            "        self.rfile.read(length)\n"
            "        count['n'] += 1\n"
            "        if count['n'] == 1:\n"
            "            body = b'not json'\n"   // first attempt: reaches the service, but the
                                                  // ack itself is bad — proves cancelJob() checks
                                                  // the RESPONSE, not just reachability.
            "        else:\n"
            "            body = b'{\"ok\": true}'\n"
            "        self.send_response(200)\n"
            "        self.send_header('Content-Length', str(len(body)))\n"
            "        self.end_headers()\n"
            "        self.wfile.write(body)\n"
            "    def log_message(self, *a): pass\n"
            "http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()\n");

        ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
        ScopedEnv port ("MOSH_SERVICE_PORT", "59997");
        ScopedEnv svc  ("MOSH_SERVICE_SCRIPT", script.getFullPathName());

        // cancelJob() doesn't spawn — it only POSTs — so bring the fake service up first via
        // a plain child process start (no ensureServiceRunning() health handshake needed;
        // the HTTP server is ready to accept as soon as the socket bind returns).
        juce::ChildProcess proc;
        const juce::String shell = "MOSH_SERVICE_PORT=59997 exec python3 " + script.getFullPathName().quoted();
        REQUIRE (proc.start (juce::StringArray { "/bin/sh", "-c", shell }));
        struct ProcCleanup { juce::ChildProcess& p; ~ProcCleanup() { if (p.isRunning()) p.kill(); } } procCleanup { proc };
        // Wait for the socket rather than assuming a fixed interpreter startup time; the
        // owner machine may be deliberately busy while this hermetic suite runs.
        bool ready = false;
        for (int attempt = 0; attempt < 40 && proc.isRunning(); ++attempt)
        {
            juce::StreamingSocket probe;
            if (probe.connect ("127.0.0.1", 59997, 100))
            {
                ready = true;
                probe.close();
                break;
            }
            juce::Thread::sleep (50);
        }
        REQUIRE (ready);

        mosh::GenerativeJobManager mgr;
        CHECK (mgr.cancelJob ("job-1"));
    }
}
