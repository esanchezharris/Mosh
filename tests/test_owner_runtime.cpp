#include <catch2/catch_test_macros.hpp>
#include "brain/LocalBrainProcessRegistry.h"
#include "brain/OwnerRuntime.h"
#include "util/Env.h"
#if JUCE_MAC || JUCE_LINUX
 #include <csignal>
 #include <fcntl.h>
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
    REQUIRE_FALSE (cfg.autoStart);
    REQUIRE (cfg.preferredPort == 8091);
    REQUIRE (cfg.prewarmAfterUnload);
    REQUIRE (cfg.preferredShell == "live");
    REQUIRE (cfg.validationError().isEmpty());
}

TEST_CASE ("owner runtime starts every app session off by default", "[owner-runtime]")
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("enabled", true);
    o->setProperty ("modelPath", "/tmp/a3b-r5-4bit-hd");
    o->setProperty ("pythonRuntime", "/tmp/python3");
    const auto cfg = OwnerRuntimeConfig::fromVar (juce::var (o));
    LocalBrainManager manager (cfg);
    const auto status = manager.status();
    REQUIRE ((bool) status.getProperty ("configured", false));
    REQUIRE (status.getProperty ("state", juce::var()).toString() == "off");
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
namespace
{
juce::File writeOwnershipRecord (const juce::File& directory,
                                 int pid,
                                 const juce::File& pythonRuntime,
                                 const juce::File& modelPath,
                                 int port,
                                 int appPid = 991000,
                                 mode_t mode = 0600)
{
    const auto created = directory.createDirectory();
    REQUIRE ((created.wasOk() || directory.isDirectory()));
    REQUIRE (::chmod (directory.getFullPathName().toRawUTF8(), 0700) == 0);
    auto* record = new juce::DynamicObject();
    record->setProperty ("owner", "Mosh");
    record->setProperty ("user", juce::SystemStats::getLogonName());
    record->setProperty ("appPid", appPid);
    record->setProperty ("pythonRuntime", pythonRuntime.getFullPathName());
    record->setProperty ("modelPath", modelPath.getFullPathName());
    record->setProperty ("host", "127.0.0.1");
    record->setProperty ("port", port);
    record->setProperty ("pid", pid);
    const auto file = directory.getChildFile (juce::String (pid) + ".json");
    REQUIRE (file.replaceWithText (juce::JSON::toString (juce::var (record), true)));
    REQUIRE (::chmod (file.getFullPathName().toRawUTF8(), mode) == 0);
    return file;
}

pid_t spawnModelFixture (const juce::File& pythonRuntime,
                         const juce::File& modelPath,
                         int port,
                         bool exactModel)
{
    const auto pid = ::fork();
    REQUIRE (pid >= 0);
    if (pid == 0)
    {
        const int nullFd = ::open ("/dev/null", O_WRONLY);
        if (nullFd >= 0)
        {
            (void) ::dup2 (nullFd, STDOUT_FILENO);
            (void) ::dup2 (nullFd, STDERR_FILENO);
            ::close (nullFd);
        }
        const auto commandModel = exactModel
            ? modelPath.getFullPathName()
            : modelPath.getSiblingFile ("different-model").getFullPathName();
        ::execl (MOSH_LOCAL_BRAIN_FIXTURE_PATH,
                 pythonRuntime.getFullPathName().toRawUTF8(),
                 "-m", "mlx_lm.server",
                 "--model", commandModel.toRawUTF8(),
                 "--host", "127.0.0.1",
                 "--port", juce::String (port).toRawUTF8(),
                 static_cast<char*> (nullptr));
        _exit (127);
    }
    juce::Thread::sleep (100);
    return pid;
}
}

TEST_CASE ("owned process records require private exact Mosh identity", "[owner-runtime]")
{
    auto root = juce::File::createTempFile ("mosh-owned-record");
    root.deleteFile();
    const auto records = root.getChildFile ("records");
    const juce::File pythonRuntime (MOSH_LOCAL_BRAIN_FIXTURE_PATH);
    const auto modelPath = root.getChildFile ("model");
    REQUIRE (modelPath.createDirectory().wasOk());
    const LocalBrainExpectedProcess expected { pythonRuntime, modelPath, "127.0.0.1", 8091 };

    const auto valid = writeOwnershipRecord (records, 991001, pythonRuntime, modelPath, 8091);
    REQUIRE (LocalBrainProcessRegistry::recordMatchesExpected (valid, expected));
    REQUIRE (::chmod (valid.getFullPathName().toRawUTF8(), 0644) == 0);
    REQUIRE_FALSE (LocalBrainProcessRegistry::recordMatchesExpected (valid, expected));

    root.deleteRecursively();
}

TEST_CASE ("startup reaping removes stale records and recovers exact crash orphans", "[owner-runtime]")
{
    auto root = juce::File::createTempFile ("mosh-orphan-recovery");
    root.deleteFile();
    const auto records = root.getChildFile ("records");
    const juce::File pythonRuntime (MOSH_LOCAL_BRAIN_FIXTURE_PATH);
    const auto modelPath = root.getChildFile ("model");
    REQUIRE (modelPath.createDirectory().wasOk());
    const auto stale = writeOwnershipRecord (records, 991002, pythonRuntime, modelPath, 8091);
    const auto orphanPid = spawnModelFixture (pythonRuntime, modelPath, 8091, true);
    const auto orphanRecord = writeOwnershipRecord (records, (int) orphanPid, pythonRuntime, modelPath, 8091);
    const auto result = LocalBrainProcessRegistry::reapOwnedProcesses (records, 500);

    REQUIRE (result.terminated == 1);
    REQUIRE (result.staleRemoved == 1);
    REQUIRE_FALSE (stale.existsAsFile());
    REQUIRE_FALSE (orphanRecord.existsAsFile());
    int status = 0;
    REQUIRE (::waitpid (orphanPid, &status, 0) == orphanPid);
    REQUIRE (WIFSIGNALED (status));
    root.deleteRecursively();
}

TEST_CASE ("startup reaping refuses to kill a process whose live command mismatches its record", "[owner-runtime]")
{
    auto root = juce::File::createTempFile ("mosh-mismatched-process");
    root.deleteFile();
    const auto records = root.getChildFile ("records");
    const juce::File pythonRuntime (MOSH_LOCAL_BRAIN_FIXTURE_PATH);
    const auto modelPath = root.getChildFile ("model");
    REQUIRE (modelPath.createDirectory().wasOk());
    const auto strangerPid = spawnModelFixture (pythonRuntime, modelPath, 8091, false);
    const auto record = writeOwnershipRecord (records, (int) strangerPid, pythonRuntime, modelPath, 8091);
    const auto result = LocalBrainProcessRegistry::reapOwnedProcesses (records, 500);

    REQUIRE (result.terminated == 0);
    REQUIRE (result.ignored == 1);
    REQUIRE (::kill (strangerPid, 0) == 0);
    REQUIRE (record.existsAsFile());
    REQUIRE (::kill (strangerPid, SIGKILL) == 0);
    int status = 0;
    REQUIRE (::waitpid (strangerPid, &status, 0) == strangerPid);
    root.deleteRecursively();
}

TEST_CASE ("startup reaping leaves a model owned by a live Mosh process alone", "[owner-runtime]")
{
    auto root = juce::File::createTempFile ("mosh-live-owner");
    root.deleteFile();
    const auto records = root.getChildFile ("records");
    const juce::File pythonRuntime (MOSH_LOCAL_BRAIN_FIXTURE_PATH);
    const auto modelPath = root.getChildFile ("model");
    REQUIRE (modelPath.createDirectory().wasOk());
    const auto modelPid = spawnModelFixture (pythonRuntime, modelPath, 8091, true);
    const auto record = writeOwnershipRecord (
        records, (int) modelPid, pythonRuntime, modelPath, 8091, (int) ::getpid());

    const auto result = LocalBrainProcessRegistry::reapOwnedProcesses (records, 500);

    REQUIRE (result.terminated == 0);
    REQUIRE (result.ignored == 1);
    REQUIRE (::kill (modelPid, 0) == 0);
    REQUIRE (record.existsAsFile());
    REQUIRE (::kill (modelPid, SIGKILL) == 0);
    int status = 0;
    REQUIRE (::waitpid (modelPid, &status, 0) == modelPid);
    root.deleteRecursively();
}

TEST_CASE ("manual start is idempotent and a busy preferred port fails without fallback", "[owner-runtime]")
{
    auto root = juce::File::createTempFile ("mosh-fixed-port");
    root.deleteFile();
    REQUIRE (root.createDirectory().wasOk());
    const auto modelPath = root.getChildFile ("model");
    REQUIRE (modelPath.createDirectory().wasOk());
    const auto configFile = root.getChildFile ("owner-runtime.json");
    REQUIRE (configFile.replaceWithText ("{}"));
    REQUIRE (::chmod (configFile.getFullPathName().toRawUTF8(), 0600) == 0);
    juce::StreamingSocket occupied;
    REQUIRE (occupied.createListener (18091, "127.0.0.1") >= 0);

    OwnerRuntimeConfig config;
    config.enabled = true;
    config.sourceFile = configFile;
    config.modelPath = modelPath;
    config.modelPathRaw = modelPath.getFullPathName();
    config.pythonRuntime = juce::File ("/usr/bin/yes");
    config.pythonRuntimeRaw = "/usr/bin/yes";
    config.preferredPort = 18091;
    const auto runtime = root.getChildFile ("runtime");
    mosh::setEnvVar ("MOSH_LOCAL_BRAIN_RUNTIME_DIR", runtime.getFullPathName().toRawUTF8());
    {
        LocalBrainManager manager (config);
        REQUIRE (manager.startAsync());
        REQUIRE_FALSE (manager.startAsync());

        for (int tries = 0; tries < 100; ++tries)
        {
            if (manager.status().getProperty ("state", juce::var()).toString() == "error") break;
            juce::Thread::sleep (20);
        }
        const auto status = manager.status();
        REQUIRE (status.getProperty ("state", juce::var()).toString() == "error");
        REQUIRE (status.getProperty ("error", juce::var()).toString().contains ("18091"));
        REQUIRE (manager.stopAsync());
        for (int tries = 0; tries < 100; ++tries)
        {
            if (manager.status().getProperty ("state", juce::var()).toString() == "off") break;
            juce::Thread::sleep (20);
        }
        REQUIRE (manager.status().getProperty ("state", juce::var()).toString() == "off");
    }
    mosh::unsetEnvVar ("MOSH_LOCAL_BRAIN_RUNTIME_DIR");
    root.deleteRecursively();
}
#endif
