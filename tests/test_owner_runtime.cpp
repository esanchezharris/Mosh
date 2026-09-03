#include <catch2/catch_test_macros.hpp>
#include "brain/OwnerRuntime.h"
#include "util/Env.h"
#if JUCE_MAC || JUCE_LINUX
 #include <csignal>
 #include <sys/stat.h>
 #include <sys/wait.h>
 #include <unistd.h>
#endif

using namespace mosh;

TEST_CASE ("owner runtime config accepts an exact local-only model", "[owner-runtime]")
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("enabled", true);
    o->setProperty ("modelPath", "/tmp/a3b-r5-4bit-hd");
    o->setProperty ("pythonRuntime", "/tmp/python3");
    o->setProperty ("preferredPort", 8091);
    o->setProperty ("stableAudioReleaseIdle", 0.99);
    o->setProperty ("prewarmAfterUnload", true);
    o->setProperty ("preferredShell", "live");
    const auto cfg = OwnerRuntimeConfig::fromVar (juce::var (o));
    REQUIRE (cfg.enabled);
    REQUIRE (cfg.preferredPort == 8091);
    REQUIRE (cfg.prewarmAfterUnload);
    REQUIRE (cfg.preferredShell == "live");
    REQUIRE (cfg.validationError().isEmpty());
}

TEST_CASE ("owner runtime config fails closed for remote or missing model paths", "[owner-runtime]")
{
    auto* remote = new juce::DynamicObject();
    remote->setProperty ("enabled", true);
    remote->setProperty ("modelPath", "https://example.test/model");
    remote->setProperty ("pythonRuntime", "/tmp/python3");
    REQUIRE (OwnerRuntimeConfig::fromVar (juce::var (remote)).validationError().isNotEmpty());

    auto* missing = new juce::DynamicObject();
    missing->setProperty ("enabled", true);
    missing->setProperty ("modelPath", "/tmp/model");
    REQUIRE (OwnerRuntimeConfig::fromVar (juce::var (missing)).validationError().isNotEmpty());
}

TEST_CASE ("owner runtime default port stays clear of the owner's standing agents", "[owner-runtime]")
{
    // 8091 is permanently held by a personal launchd KeepAlive mlx agent on the
    // owner machine (2026-09-01 orphan incident): the default must not start the
    // scan inside that contended range. Explicit config still wins (test above).
    REQUIRE (OwnerRuntimeConfig::fromVar (juce::var()).preferredPort == 8491);
    auto* o = new juce::DynamicObject();
    o->setProperty ("preferredPort", 9200);
    REQUIRE (OwnerRuntimeConfig::fromVar (juce::var (o)).preferredPort == 9200);
}

TEST_CASE ("owned-brain identification never matches the owner's standing mlx agents", "[owner-runtime]")
{
    const juce::String model = "/models/mosh-fused-r5";
    REQUIRE (LocalBrainManager::commandLooksLikeOwnedBrain (
        "/venvs/sft/bin/python -m mlx_lm.server --model /models/mosh-fused-r5 --host 127.0.0.1 --port 8491",
        model));
    REQUIRE (LocalBrainManager::commandLooksLikeOwnedBrain (
        "python /app/Resources/service/sft/launch_local_brain.py /run/local-brain.pid /venvs/sft/bin/python /models/mosh-fused-r5 8491",
        model));
    // The owner's launchd Qwen agent is ALSO mlx_lm.server — a different model
    // path must never be treated as ours (it must never be adopted or signalled).
    REQUIRE_FALSE (LocalBrainManager::commandLooksLikeOwnedBrain (
        "/opt/omp/bin/python -m mlx_lm.server --model /models/qwen3-4b --host 127.0.0.1 --port 8091", model));
    REQUIRE_FALSE (LocalBrainManager::commandLooksLikeOwnedBrain ("/usr/bin/top", model));
    REQUIRE_FALSE (LocalBrainManager::commandLooksLikeOwnedBrain ("", model));
    REQUIRE_FALSE (LocalBrainManager::commandLooksLikeOwnedBrain (
        "python -m mlx_lm.server --model /models/mosh-fused-r5", ""));
}

static juce::DynamicObject* makeHandshake()
{
    auto* h = new juce::DynamicObject();
    h->setProperty ("owner", "Mosh");
    h->setProperty ("pid", 4242);
    h->setProperty ("port", 8491);
    h->setProperty ("modelPath", "/models/exact");
    h->setProperty ("pythonRuntime", "/venvs/sft/bin/python");
    return h;
}

TEST_CASE ("handshake adoption requires the exact owner identity", "[owner-runtime]")
{
    const juce::String model = "/models/exact", py = "/venvs/sft/bin/python";
    REQUIRE (LocalBrainManager::handshakeMatches (juce::var (makeHandshake()), 8491, model, py));
    { auto* h = makeHandshake(); h->setProperty ("owner", "NotMosh");
      REQUIRE_FALSE (LocalBrainManager::handshakeMatches (juce::var (h), 8491, model, py)); }
    { auto* h = makeHandshake(); h->setProperty ("modelPath", "/models/other");
      REQUIRE_FALSE (LocalBrainManager::handshakeMatches (juce::var (h), 8491, model, py)); }
    { auto* h = makeHandshake(); h->setProperty ("pythonRuntime", "/other/python");
      REQUIRE_FALSE (LocalBrainManager::handshakeMatches (juce::var (h), 8491, model, py)); }
    { auto* h = makeHandshake(); h->setProperty ("pid", 0);
      REQUIRE_FALSE (LocalBrainManager::handshakeMatches (juce::var (h), 8491, model, py)); }
    REQUIRE_FALSE (LocalBrainManager::handshakeMatches (juce::var (makeHandshake()), 8492, model, py));
    REQUIRE_FALSE (LocalBrainManager::handshakeMatches (juce::var(), 8491, model, py));
}

TEST_CASE ("spawn ledger round-trips owned pids and skips garbage", "[owner-runtime]")
{
    juce::String text;
    text << LocalBrainManager::spawnLedgerLine (101, 8491, "/models/a");
    text << "not json\n";
    text << LocalBrainManager::spawnLedgerLine (102, 8492, "/models/b");
    text << LocalBrainManager::spawnLedgerLine (0, 8493, "/models/c"); // pid<=1 rows are noise
    const auto rows = LocalBrainManager::parseSpawnLedger (text);
    REQUIRE (rows.size() == 2);
    REQUIRE ((int) rows[0].getProperty ("pid", -1) == 101);
    REQUIRE ((int) rows[0].getProperty ("port", -1) == 8491);
    REQUIRE ((int) rows[1].getProperty ("pid", -1) == 102);
    REQUIRE (rows[1].getProperty ("modelPath", juce::var()).toString() == "/models/b");
    REQUIRE (LocalBrainManager::parseSpawnLedger ({}).isEmpty());
}

TEST_CASE ("model identity requires the exact configured path", "[owner-runtime]")
{
    auto* row = new juce::DynamicObject(); row->setProperty ("id", "/models/exact");
    juce::Array<juce::var> data; data.add (juce::var (row));
    auto* root = new juce::DynamicObject(); root->setProperty ("data", data);
    const juce::var response (root); // one owner across both identity probes
    REQUIRE (LocalBrainManager::modelsResponseMatches (response, "/models/exact"));
    REQUIRE_FALSE (LocalBrainManager::modelsResponseMatches (response, "/models/lookalike"));
}

TEST_CASE ("Finder owner config fails closed unless it is mode 600", "[owner-runtime]")
{
    auto dir = juce::File::createTempFile ("mosh-owner-runtime");
    dir.deleteFile();
    REQUIRE (dir.createDirectory().wasOk());
    const auto file = dir.getChildFile ("owner-runtime.json");
    REQUIRE (file.replaceWithText (R"json({"enabled":true,"modelPath":"/tmp/model","pythonRuntime":"/tmp/python","preferredShell":"live"})json"));
    mosh::setEnvVar ("MOSH_OWNER_RUNTIME_CONFIG", file.getFullPathName().toRawUTF8());
   #if JUCE_MAC || JUCE_LINUX
    REQUIRE (::chmod (file.getFullPathName().toRawUTF8(), 0644) == 0);
    REQUIRE (OwnerRuntimeConfig::load().validationError() == "owner runtime config must have mode 600");
    REQUIRE (::chmod (file.getFullPathName().toRawUTF8(), 0600) == 0);
   #endif
    const auto loaded = OwnerRuntimeConfig::load();
    REQUIRE (loaded.enabled);
    REQUIRE (loaded.preferredShell == "live");
    REQUIRE (loaded.validationError().isEmpty());
    mosh::unsetEnvVar ("MOSH_OWNER_RUNTIME_CONFIG");
    dir.deleteRecursively();
}

#if JUCE_MAC || JUCE_LINUX
TEST_CASE ("owned-process shutdown refuses strangers and terminates only verified children", "[owner-runtime]")
{
    int readyPipe[2] = { -1, -1 };
    REQUIRE (::pipe (readyPipe) == 0);
    const auto pid = ::fork();
    REQUIRE (pid >= 0);
    if (pid == 0)
    {
        ::close (readyPipe[0]);
        ::signal (SIGTERM, SIG_DFL);
        const char ready = '1';
        (void) ::write (readyPipe[1], &ready, 1);
        ::close (readyPipe[1]);
        for (;;) ::pause();
    }
    ::close (readyPipe[1]);
    char ready = 0;
    REQUIRE (::read (readyPipe[0], &ready, 1) == 1);
    ::close (readyPipe[0]);
    REQUIRE (ready == '1');
    REQUIRE_FALSE (LocalBrainManager::terminateOwnedProcess ((int) pid, false, 20));
    REQUIRE (::kill (pid, 0) == 0);
    REQUIRE (LocalBrainManager::terminateOwnedProcess ((int) pid, true, 500));
    int status = 0;
    REQUIRE (::waitpid (pid, &status, 0) == pid);
    REQUIRE (WIFSIGNALED (status));
}
#endif
