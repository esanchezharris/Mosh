#include "AiToolsInstaller.h"
#include "AiTools.h"

#include <cstring>

#if JUCE_MAC || JUCE_LINUX
 #include <fcntl.h>
 #include <signal.h>
 #include <spawn.h>
 #include <sys/wait.h>
 #include <unistd.h>
 #include <vector>
 #include <string>
#endif

namespace mosh
{
using namespace juce;

namespace
{
    const char* stepId (int s)
    {
        static const char* ids[] = { "python", "sketch", "transcribe" };
        return ids[s];
    }

    // Friend copy per step; the log tail goes underneath, verbatim.
    String stepError (int s)
    {
        switch (s)
        {
            case 0:  return "Couldn't download Python for the AI tools. Check your internet and try again.";
            case 1:  return "Couldn't install the beatbox tool. Check your internet and try again.";
            default: return "Couldn't install the transcription tool. Check your internet and try again.";
        }
    }

    File firstExisting (std::initializer_list<File> candidates)
    {
        for (auto& f : candidates)
            if (f != File() && f.existsAsFile())
                return f;
        return {};
    }

    String envOr (const char* key, const String& fallback)
    {
        return SystemStats::getEnvironmentVariable (key, fallback);
    }
}

// ── paths ─────────────────────────────────────────────────────────────────────

AiToolsInstaller::Paths AiToolsInstaller::Paths::forThisApp()
{
    Paths p;
    p.home = File::getSpecialLocation (File::userHomeDirectory);
    const auto app = File::getSpecialLocation (File::currentApplicationFile);
    const auto cwd = File::getCurrentWorkingDirectory();

   #if JUCE_MAC
    if (auto e = envOr ("MOSH_UV", {}); File::isAbsolutePath (e))
        p.uv = firstExisting ({ File (e) });
    else
        p.uv = firstExisting ({ app.getChildFile ("Contents/Helpers/uv/uv"),
                                cwd.getChildFile ("resources/uv/uv") });
   #endif

    // The bundle first: the owner's shared Re-Imagine helper can lag the app.
    File script;
    if (auto e = envOr ("MOSH_SERVICE_SCRIPT", {}); File::isAbsolutePath (e))
        script = firstExisting ({ File (e) });
    if (script == File())
        script = firstExisting ({ app.getChildFile ("Contents/Resources/service/server.py"),
                                  cwd.getChildFile ("service/server.py") });
    if (script != File())
        p.serviceDir = script.getParentDirectory();

    p.pythonDir = p.home.getChildFile ("Library/Mosh/python");
    const auto venvs = envOr ("MOSH_VENVS_DIR", {});
    p.venvsDir = File::isAbsolutePath (venvs) ? File (venvs) : p.home.getChildFile ("Library/Mosh/venvs");
    const auto envDir = envOr ("MOSH_AI_TOOLS_ENV_DIR", {});
    p.envDir = File::isAbsolutePath (envDir) ? File (envDir)
                                             : p.home.getChildFile ("Library/Application Support/Mosh/ai-tools");
    p.cacheDir = p.home.getChildFile ("Library/Caches/Mosh/uv");
    p.logFile = p.home.getChildFile ("Library/Mosh/logs/ai-tools.log");
    return p;
}

AiToolsInstaller::AiToolsInstaller (Paths p) : paths (std::move (p)) {}

AiToolsInstaller::~AiToolsInstaller()
{
    cancelRequested = true;
    if (worker.joinable())
        worker.join();
}

void AiToolsInstaller::setStatusCallback (std::function<void (var)> cb)
{
    const ScopedLock sl (lock);
    statusCallback = std::move (cb);
}

void AiToolsInstaller::waitForIdle()
{
    if (worker.joinable())
        worker.join();
}

// ── status ────────────────────────────────────────────────────────────────────

String AiToolsInstaller::unavailableReason() const
{
   #if ! (JUCE_MAC)
    return "Adding AI tools from the app works on macOS only.";
   #else
    if (! paths.uv.existsAsFile())
        return "This build of Mosh can't add AI tools.";
    if (! paths.serviceDir.getChildFile ("sketch/setup-sketch.sh").existsAsFile()
        || ! paths.serviceDir.getChildFile ("transcribe/setup-transcribe.sh").existsAsFile())
        return "This build of Mosh is missing the AI tools setup.";
    return {};
   #endif
}

var AiToolsInstaller::status() const
{
    const ScopedLock sl (lock);
    const auto reason = unavailableReason();

    Array<var> steps;
    for (int s = 0; s < 3; ++s)
    {
        auto* o = new DynamicObject();
        o->setProperty ("id", stepId (s));
        o->setProperty ("status", stepStatus.getValue (stepId (s), "pending"));
        steps.add (var (o));
    }

    auto* o = new DynamicObject();
    o->setProperty ("available", reason.isEmpty());
    o->setProperty ("state", reason.isEmpty() ? state : String ("unavailable"));
    o->setProperty ("step", currentStep);
    o->setProperty ("steps", steps);
    o->setProperty ("error", reason.isEmpty() ? error : reason);
    o->setProperty ("detail", detail);
    o->setProperty ("sizeEstimateMb", kSizeEstimateMb);
    return var (o);
}

void AiToolsInstaller::setState (const String& s, const String& step, const String& err, const String& det)
{
    std::function<void (var)> cb;
    {
        const ScopedLock sl (lock);
        state = s;
        currentStep = step;
        error = err;
        detail = det;
        cb = statusCallback;
    }
    if (cb) cb (status());
}

void AiToolsInstaller::setStepStatus (Step step, const String& st)
{
    std::function<void (var)> cb;
    {
        const ScopedLock sl (lock);
        stepStatus.set (stepId ((int) step), st);
        cb = statusCallback;
    }
    if (cb) cb (status());
}

String AiToolsInstaller::logTail (int lines) const
{
    StringArray all;
    all.addLines (paths.logFile.loadFileAsString());
    all.removeEmptyStrings();
    const int start = jmax (0, all.size() - lines);
    StringArray tail;
    for (int i = start; i < all.size(); ++i)
        tail.add (all[i]);
    return tail.joinIntoString ("\n");
}

// ── jobs ──────────────────────────────────────────────────────────────────────

void AiToolsInstaller::startJob (std::function<void()> job)
{
    if (busy.exchange (true))
        return;
    if (worker.joinable())
        worker.join();   // the previous job has finished (busy was false)
    cancelRequested = false;
    worker = std::thread ([this, job = std::move (job)]
    {
        job();
        busy = false;
    });
}

var AiToolsInstaller::install()
{
    if (! unavailableReason().isEmpty() || busy)
        return status();
    // A full disk halfway through is the worst way to fail; say it before anything runs.
    auto volume = paths.home;
    while (! volume.exists() && volume != volume.getParentDirectory())
        volume = volume.getParentDirectory();
    if (volume.getBytesFreeOnVolume() < paths.minFreeBytes)
    {
        const auto gb = String ((double) paths.minFreeBytes / (1024.0 * 1024.0 * 1024.0), 1);
        setState ("failed", {}, "Adding AI tools needs about " + gb
                                    + " GB free on this Mac. Free some space and try again.");
        return status();
    }
    startJob ([this] { runInstall(); });
    return status();
}

var AiToolsInstaller::remove()
{
    if (unavailableReason().isEmpty() || readManifest().isObject())
        startJob ([this] { runRemove(); });
    return status();
}

var AiToolsInstaller::cancel()
{
    if (busy && ! cancelRequested.exchange (true))
    {
        {
            const ScopedLock sl (lock);
            if (state == "installing") state = "cancelling";
        }
       #if JUCE_MAC || JUCE_LINUX
        if (const int pg = runningPgid.load(); pg > 0)
            ::killpg (pg, SIGTERM);
       #endif
        std::function<void (var)> cb;
        { const ScopedLock sl (lock); cb = statusCallback; }
        if (cb) cb (status());
    }
    return status();
}

StringPairArray AiToolsInstaller::baseEnv() const
{
    StringPairArray env;
    // Only the uv folder and the base system: never Homebrew, never a user python3.
    env.set ("PATH", paths.uv.getParentDirectory().getFullPathName() + ":/usr/bin:/bin:/usr/sbin:/sbin");
    env.set ("HOME", paths.home.getFullPathName());
    env.set ("MOSH_VENVS_DIR", paths.venvsDir.getFullPathName());
    env.set ("UV_CACHE_DIR", paths.cacheDir.getFullPathName());
    env.set ("UV_NO_CONFIG", "1");
    // Copies, not hard links into the cache: the cache is deleted when the install ends.
    env.set ("UV_LINK_MODE", "copy");
    env.set ("LANG", "en_US.UTF-8");
    return env;
}

File AiToolsInstaller::findManagedInterpreter() const
{
    // uv lays a version out as <install-dir>/cpython-3.11.<n>-<platform>/bin/python3.11.
    auto dirs = paths.pythonDir.findChildFiles (File::findDirectories, false, "cpython-3.11*");
    dirs.sort();
    for (int i = dirs.size(); --i >= 0;)
        if (auto py = dirs[i].getChildFile ("bin/python3.11"); py.existsAsFile())
            return py;
    return {};
}

var AiToolsInstaller::readManifest() const
{
    return JSON::parse (paths.envDir.getChildFile ("installed.json").loadFileAsString());
}

void AiToolsInstaller::recordCreated (const File& dir, const File& python)
{
    auto manifest = readManifest();
    auto* o = manifest.isObject() ? manifest.getDynamicObject() : new DynamicObject();
    if (! manifest.isObject())
        manifest = var (o);
    o->setProperty ("version", 1);
    if (python != File())
        o->setProperty ("python", python.getFullPathName());

    Array<var> created;
    if (auto* existing = o->getProperty ("created").getArray())
        created = *existing;
    if (dir != File() && ! created.contains (dir.getFullPathName()))
        created.add (dir.getFullPathName());
    o->setProperty ("created", created);

    paths.envDir.createDirectory();
    paths.envDir.getChildFile ("installed.json").replaceWithText (JSON::toString (manifest), false, false, "\n");
}

void AiToolsInstaller::runInstall()
{
    paths.logFile.getParentDirectory().createDirectory();
    paths.logFile.appendText ("\n=== Add AI tools " + Time::getCurrentTime().toISO8601 (true) + " ===\n",
                              false, false, "\n");
    {
        const ScopedLock sl (lock);
        stepStatus.clear();
    }
    setState ("installing");

    File python;
    for (auto step : { Step::python, Step::sketch, Step::transcribe })
    {
        if (step != Step::python && python == File())
            python = managedAiToolsPython (paths.envDir);

        if (! runStep (step, python))
        {
            paths.cacheDir.deleteRecursively();
            if (cancelRequested)
                setState ("cancelled");
            else
                setState ("failed", stepId ((int) step), stepError ((int) step), logTail (8));
            return;
        }
    }
    paths.cacheDir.deleteRecursively();
    setState ("done");
}

bool AiToolsInstaller::runStep (Step step, const File& python)
{
    const auto id = stepId ((int) step);
    setState ("installing", id);
    setStepStatus (step, "running");

    const File target = step == Step::python ? paths.pythonDir
                                             : paths.venvsDir.getChildFile (id);
    const bool existedBefore = target.exists();

    StepRun run;
    File interpreter;
    if (step == Step::python)
    {
        interpreter = findManagedInterpreter();
        if (interpreter == File())
        {
            run = spawn ({ paths.uv.getFullPathName(), "python", "install", "3.11",
                           "--install-dir", paths.pythonDir.getFullPathName(), "--no-bin" },
                         baseEnv());
            interpreter = findManagedInterpreter();
        }
        else
        {
            run.exitCode = 0;
        }
        if (run.exitCode == 0 && interpreter == File())
            run.exitCode = 1;   // uv claimed success but left no interpreter we can use
    }
    else
    {
        const auto script = step == Step::sketch ? paths.serviceDir.getChildFile ("sketch/setup-sketch.sh")
                                                 : paths.serviceDir.getChildFile ("transcribe/setup-transcribe.sh");
        run = spawn ({ "/bin/bash", script.getFullPathName(),
                       "--python", python.getFullPathName(),
                       "--env-dir", paths.envDir.getFullPathName() },
                     baseEnv());
    }

    if (run.exitCode != 0 || run.cancelled || cancelRequested)
    {
        // Only what this step made: an owner's venv that was already there stays.
        if (! existedBefore)
            target.deleteRecursively();
        setStepStatus (step, cancelRequested ? "cancelled" : "failed");
        return false;
    }

    if (step == Step::python)
    {
        recordCreated (existedBefore ? File() : target, interpreter);
        // run.sh falls back to this interpreter when nothing more specific is set.
        paths.envDir.getChildFile ("service.env").replaceWithText (
            "# Written by Mosh's Add AI tools install. Sourced by service/run.sh.\n"
            "export MOSH_MANAGED_PYTHON=\"" + interpreter.getFullPathName() + "\"\n",
            false, false, "\n");
    }
    else if (! existedBefore)
    {
        recordCreated (target, {});
    }
    setStepStatus (step, "done");
    return true;
}

void AiToolsInstaller::runRemove()
{
    setState ("removing");
    const auto manifest = readManifest();

    // Delete only the folders this installer made, and only where it makes them, so a
    // hand-edited manifest can never point the delete somewhere else.
    const Array<File> ours { paths.pythonDir,
                             paths.venvsDir.getChildFile ("sketch"),
                             paths.venvsDir.getChildFile ("transcribe") };
    if (auto* created = manifest.getProperty ("created", {}).getArray())
        for (auto& c : *created)
            for (auto& dir : ours)
                if (c.toString() == dir.getFullPathName())
                    dir.deleteRecursively();

    paths.envDir.deleteRecursively();
    paths.cacheDir.deleteRecursively();
    {
        const ScopedLock sl (lock);
        stepStatus.clear();
    }
    setState ("removed");
}

// ── process ───────────────────────────────────────────────────────────────────

AiToolsInstaller::StepRun AiToolsInstaller::spawn (const StringArray& argv, const StringPairArray& env)
{
    StepRun result;
    paths.logFile.appendText ("$ " + argv.joinIntoString (" ") + "\n", false, false, "\n");

   #if JUCE_MAC || JUCE_LINUX
    std::vector<std::string> args, vars;
    for (auto& a : argv) args.push_back (a.toStdString());
    for (auto& k : env.getAllKeys()) vars.push_back ((k + "=" + env[k]).toStdString());
    std::vector<char*> argp, envp;
    for (auto& a : args) argp.push_back (a.data());
    argp.push_back (nullptr);
    for (auto& v : vars) envp.push_back (v.data());
    envp.push_back (nullptr);

    const auto log = paths.logFile.getFullPathName().toStdString();
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init (&fa);
    posix_spawn_file_actions_addopen (&fa, 0, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_addopen (&fa, 1, log.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    posix_spawn_file_actions_adddup2 (&fa, 1, 2);

    // Its own process group: cancel signals the whole group, so uv's children and the
    // setup scripts' pip/uv processes stop too.
    posix_spawnattr_t attr;
    posix_spawnattr_init (&attr);
    posix_spawnattr_setflags (&attr, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup (&attr, 0);

    pid_t pid = 0;
    const int rc = posix_spawn (&pid, argp[0], &fa, &attr, argp.data(), envp.data());
    posix_spawn_file_actions_destroy (&fa);
    posix_spawnattr_destroy (&attr);
    if (rc != 0)
    {
        paths.logFile.appendText ("spawn failed: " + String (strerror (rc)) + "\n", false, false, "\n");
        result.exitCode = 127;
        return result;
    }
    runningPgid = pid;

    int st = 0;
    bool signalled = false;
    int waitedMs = 0;
    for (;;)
    {
        const pid_t done = ::waitpid (pid, &st, WNOHANG);
        if (done == pid) break;
        if (done < 0) { st = 0; break; }
        if (cancelRequested)
        {
            if (! signalled) { ::killpg (pid, SIGTERM); signalled = true; }
            else if ((waitedMs += 50) >= 3000) ::killpg (pid, SIGKILL);
        }
        Thread::sleep (50);
    }
    // Anything the leader left behind in its group goes too when cancelling.
    if (cancelRequested)
        ::killpg (pid, SIGKILL);
    runningPgid = 0;

    result.cancelled = cancelRequested;
    result.exitCode = WIFEXITED (st) ? WEXITSTATUS (st) : 128 + WTERMSIG (st);
   #else
    ignoreUnused (env);
    result.exitCode = 127;
   #endif
    return result;
}
}
