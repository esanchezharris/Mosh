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
