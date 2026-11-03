#include <catch2/catch_test_macros.hpp>
#include "generative/AiTools.h"
#include "generative/AiToolsInstaller.h"
#include <limits>

#if JUCE_MAC || JUCE_LINUX
 #include <signal.h>
#endif

// "Add AI tools" (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.3). The installer runs the
// REAL setup scripts (copied from service/) against a fake uv, so these cases cover the
// whole chain except the network: managed Python, then the beatbox venv, then the
// transcription venv. The fake uv reads its mode from a file beside it, because the
// installer hands its children a minimal environment on purpose.
namespace
{
    using juce::File;
    using juce::String;

    const char* kFakeUv = R"SH(#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
mode="$(cat "$here/mode" 2>/dev/null)"
echo "$*" >> "$here/uv.log"
mkdir -p "$UV_CACHE_DIR" && echo cached > "$UV_CACHE_DIR/marker"
hang() { sleep 60 & echo $! > "$here/sleeper.pid"; wait; }
case "$1" in
  python)
    [ "$mode" = fail-python ] && { echo "error: fake download refused" >&2; exit 3; }
    [ "$mode" = hang-python ] && hang
    dest="$5"
    mkdir -p "$dest/cpython-3.11.9-macos-aarch64-none/bin"
    printf '#!/bin/sh\necho "Python 3.11.9"\n' > "$dest/cpython-3.11.9-macos-aarch64-none/bin/python3.11"
    chmod +x "$dest/cpython-3.11.9-macos-aarch64-none/bin/python3.11"
    ;;
  venv)
    for last; do :; done
    mkdir -p "$last/bin"
    printf '#!/bin/sh\nexit 0\n' > "$last/bin/python"
    chmod +x "$last/bin/python"
    ;;
  pip)
    case "$*" in
      *librosa*)
        [ "$mode" = fail-sketch ] && { echo "error: fake librosa wheel missing" >&2; exit 4; }
        [ "$mode" = hang-sketch ] && hang ;;
      *basic-pitch*)
        [ "$mode" = fail-transcribe ] && { echo "error: fake basic-pitch wheel missing" >&2; exit 5; } ;;
    esac
    ;;
esac
exit 0
)SH";

    struct Box
    {
        juce::TemporaryFile dir;
        File root() const { return dir.getFile(); }
        File home() const { return root().getChildFile ("home"); }
        File bin() const { return root().getChildFile ("Mosh.app/Contents/Helpers/uv"); }
        File service() const { return root().getChildFile ("Mosh.app/Contents/Resources/service"); }
        mosh::AiToolsInstaller::Paths paths;

        Box()
        {
            root().createDirectory();
            bin().createDirectory();
            auto uv = bin().getChildFile ("uv");
            uv.replaceWithText (kFakeUv, false, false, "\n");
            uv.setExecutePermission (true);

            const File repo (MOSH_SOURCE_DIR_STRING);
            for (auto rel : { "sketch/setup-sketch.sh", "transcribe/setup-transcribe.sh" })
            {
                auto dst = service().getChildFile (rel);
                dst.getParentDirectory().createDirectory();
                repo.getChildFile ("service").getChildFile (rel).copyFileTo (dst);
            }

            paths.uv = uv;
            paths.serviceDir = service();
            paths.home = home();
            paths.pythonDir = home().getChildFile ("Library/Mosh/python");
            paths.venvsDir = home().getChildFile ("Library/Mosh/venvs");
            paths.envDir = home().getChildFile ("Library/Application Support/Mosh/ai-tools");
            paths.cacheDir = home().getChildFile ("Library/Caches/Mosh/uv");
            paths.logFile = home().getChildFile ("Library/Mosh/logs/ai-tools.log");
        }
        ~Box() { root().deleteRecursively(); }

        void mode (const String& m) const { bin().getChildFile ("mode").replaceWithText (m, false, false, "\n"); }
        String uvLog() const { return bin().getChildFile ("uv.log").loadFileAsString(); }
        File managedPy() const { return paths.pythonDir.getChildFile ("cpython-3.11.9-macos-aarch64-none/bin/python3.11"); }
        File venv (const char* name) const { return paths.venvsDir.getChildFile (name); }

        void healthyVenv (const char* name) const
        {
            auto py = venv (name).getChildFile ("bin/python");
            py.getParentDirectory().createDirectory();
            py.replaceWithText ("#!/bin/sh\nexit 0\n", false, false, "\n");
            py.setExecutePermission (true);
        }

        mosh::AiToolsStatus probe() const
        {
            mosh::AiToolsProbeInputs in;
            in.home = home();
            in.env = [] (const char*) { return String(); };
            in.xcodeSelectLink = root().getChildFile ("no-xcode-link");
            in.commandLineToolsPython = root().getChildFile ("no-clt/python3");
            in.macStubPython = true;
            return mosh::probeAiTools (in);
        }
    };

    String stepStatus (const juce::var& status, const char* id)
    {
        if (auto* steps = status.getProperty ("steps", {}).getArray())
            for (auto& s : *steps)
                if (s.getProperty ("id", {}).toString() == id)
                    return s.getProperty ("status", {}).toString();
        return {};
    }

    juce::StringArray created (const Box& box)
    {
        juce::StringArray out;
        auto manifest = juce::JSON::parse (box.paths.envDir.getChildFile ("installed.json").loadFileAsString());
        if (auto* a = manifest.getProperty ("created", {}).getArray())
            for (auto& v : *a) out.add (v.toString());
        return out;
    }

    template <typename Pred>
    bool waitFor (Pred pred, int ms = 10000)
    {
        for (int waited = 0; waited < ms; waited += 20)
        {
            if (pred()) return true;
            juce::Thread::sleep (20);
        }
        return pred();
    }
}

TEST_CASE ("AI tools installer: a build without uv says so and installs nothing", "[ai-tools]")
{
    Box box;
    auto paths = box.paths;
    paths.uv = box.root().getChildFile ("missing/uv");
    mosh::AiToolsInstaller installer (paths);

    auto st = installer.install();
    installer.waitForIdle();
    CHECK_FALSE ((bool) st.getProperty ("available", true));
    CHECK (st.getProperty ("state", {}).toString() == "unavailable");
   #if JUCE_MAC
    CHECK (st.getProperty ("error", {}).toString() == "This build of Mosh can't add AI tools.");
   #endif
    CHECK_FALSE (box.home().exists());
    CHECK (box.uvLog().isEmpty());
}

#if JUCE_MAC
TEST_CASE ("AI tools installer: a full install uses only the managed Python and stays out of the bundle", "[ai-tools]")
{
    Box box;
    REQUIRE_FALSE (box.probe().on());

    mosh::AiToolsInstaller installer (box.paths);
    juce::StringArray seen;
    juce::CriticalSection seenLock;
    installer.setStatusCallback ([&] (juce::var s)
    {
        const juce::ScopedLock sl (seenLock);
        seen.addIfNotAlreadyThere (s.getProperty ("state", {}).toString());
    });

    installer.install();
    installer.waitForIdle();
    const auto st = installer.status();
    INFO (box.paths.logFile.loadFileAsString());
    REQUIRE (st.getProperty ("state", {}).toString() == "done");
    for (auto id : { "python", "sketch", "transcribe" })
        CHECK (stepStatus (st, id) == "done");
    CHECK (seen.contains ("installing"));
    CHECK (seen.contains ("done"));

    // uv downloaded Python into our folder, without putting it on ~/.local/bin.
    CHECK (box.uvLog().contains ("python install 3.11 --install-dir " + box.paths.pythonDir.getFullPathName() + " --no-bin"));
    // Both venvs were built from that interpreter.
    CHECK (box.uvLog().contains ("venv --python " + box.managedPy().getFullPathName() + " " + box.venv ("sketch").getFullPathName()));
    CHECK (box.uvLog().contains ("venv --python " + box.managedPy().getFullPathName() + " " + box.venv ("transcribe").getFullPathName()));

    // Pointers live in the env dir; nothing is written next to the bundled scripts.
    const auto env = box.paths.envDir;
    CHECK (env.getChildFile ("service.env").loadFileAsString().contains ("MOSH_MANAGED_PYTHON=\"" + box.managedPy().getFullPathName() + "\""));
    CHECK (env.getChildFile ("sketch.env").loadFileAsString().contains ("SKETCH_PY="));
    CHECK (env.getChildFile ("transcribe.env").loadFileAsString().contains ("BASIC_PITCH_PY="));
    CHECK_FALSE (box.service().getChildFile ("sketch/.sketch.env").exists());
    CHECK_FALSE (box.service().getChildFile ("transcribe/.transcribe.env").exists());

    // The manifest names exactly what was created; the download cache is gone.
    const auto made = created (box);
    CHECK (made.contains (box.paths.pythonDir.getFullPathName()));
    CHECK (made.contains (box.venv ("sketch").getFullPathName()));
    CHECK (made.contains (box.venv ("transcribe").getFullPathName()));
    CHECK_FALSE (box.paths.cacheDir.exists());

    // The probe now sees the tools, through the managed Python and with no developer tools.
    const auto probe = box.probe();
    CHECK (probe.on());
    CHECK (probe.pythonSource == "managed");
    CHECK (probe.transcribe);
}

TEST_CASE ("AI tools installer: a failed step removes only what it made, and a retry resumes", "[ai-tools]")
{
    SECTION ("python")
    {
        Box box;
        box.mode ("fail-python");
        mosh::AiToolsInstaller installer (box.paths);
        installer.install();
        installer.waitForIdle();
        const auto st = installer.status();
        CHECK (st.getProperty ("state", {}).toString() == "failed");
        CHECK (st.getProperty ("step", {}).toString() == "python");
        CHECK (st.getProperty ("error", {}).toString()
               == "Couldn't download Python for the AI tools. Check your internet and try again.");
        CHECK (st.getProperty ("detail", {}).toString().contains ("fake download refused"));
        CHECK (stepStatus (st, "python") == "failed");
        CHECK (stepStatus (st, "sketch") == "pending");
        CHECK_FALSE (box.paths.pythonDir.exists());
        CHECK_FALSE (box.paths.envDir.getChildFile ("installed.json").exists());
        CHECK_FALSE (box.paths.cacheDir.exists());
        CHECK_FALSE (box.probe().python);
    }
    SECTION ("sketch, then a retry that does not download Python again")
    {
        Box box;
        box.mode ("fail-sketch");
        mosh::AiToolsInstaller installer (box.paths);
        installer.install();
        installer.waitForIdle();
        auto st = installer.status();
        CHECK (st.getProperty ("state", {}).toString() == "failed");
        CHECK (st.getProperty ("step", {}).toString() == "sketch");
        CHECK (st.getProperty ("error", {}).toString()
               == "Couldn't install the beatbox tool. Check your internet and try again.");
        CHECK (st.getProperty ("detail", {}).toString().contains ("fake librosa wheel missing"));
        CHECK (box.managedPy().existsAsFile());          // the finished step stays
        CHECK_FALSE (box.venv ("sketch").exists());      // the half-made venv does not
        CHECK_FALSE (box.venv ("transcribe").exists());

        box.mode ("");
        installer.install();
        installer.waitForIdle();
        st = installer.status();
        CHECK (st.getProperty ("state", {}).toString() == "done");
        CHECK (box.uvLog().indexOf ("python install") == box.uvLog().lastIndexOf ("python install"));
        CHECK (box.probe().on());
    }
    SECTION ("transcribe")
    {
        Box box;
        box.mode ("fail-transcribe");
        mosh::AiToolsInstaller installer (box.paths);
        installer.install();
        installer.waitForIdle();
        const auto st = installer.status();
        CHECK (st.getProperty ("state", {}).toString() == "failed");
        CHECK (st.getProperty ("step", {}).toString() == "transcribe");
        CHECK (st.getProperty ("error", {}).toString()
               == "Couldn't install the transcription tool. Check your internet and try again.");
        CHECK (box.venv ("sketch").exists());
        CHECK_FALSE (box.venv ("transcribe").exists());
        // Beatbox works without transcription: the tools count as on.
        CHECK (box.probe().on());
        CHECK_FALSE (box.probe().transcribe);
    }
}

TEST_CASE ("AI tools installer: cancel stops the whole process group and cleans up", "[ai-tools]")
{
    for (auto hangIn : { "python", "sketch" })
    {
        DYNAMIC_SECTION ("cancelled during " << hangIn)
        {
            Box box;
            box.mode (String ("hang-") + hangIn);
            mosh::AiToolsInstaller installer (box.paths);
            installer.install();

            const auto pidFile = box.bin().getChildFile ("sleeper.pid");
            REQUIRE (waitFor ([&] { return pidFile.existsAsFile() && pidFile.loadFileAsString().trim().isNotEmpty(); }));
            const int sleeper = pidFile.loadFileAsString().trim().getIntValue();
            REQUIRE (sleeper > 0);

            // A second install while one runs does nothing.
            CHECK (installer.install().getProperty ("state", {}).toString() == "installing");

            const auto t0 = juce::Time::getMillisecondCounter();
            installer.cancel();
            installer.waitForIdle();
            CHECK (juce::Time::getMillisecondCounter() - t0 < 5000);

            CHECK (installer.status().getProperty ("state", {}).toString() == "cancelled");
            CHECK (stepStatus (installer.status(), hangIn) == "cancelled");
            // The grandchild sleep was in the step's process group, so it is gone too.
            CHECK (waitFor ([&] { return ::kill (sleeper, 0) != 0; }, 2000));
            if (String (hangIn) == "python")
                CHECK_FALSE (box.paths.pythonDir.exists());
            else
            {
                CHECK (box.managedPy().existsAsFile());
                CHECK_FALSE (box.venv ("sketch").exists());
            }
            CHECK_FALSE (box.paths.cacheDir.exists());
        }
    }
}

TEST_CASE ("AI tools installer: too little free space refuses before anything runs", "[ai-tools]")
{
    Box box;
    auto paths = box.paths;
    paths.minFreeBytes = std::numeric_limits<juce::int64>::max();
    mosh::AiToolsInstaller installer (paths);
    const auto st = installer.install();
    installer.waitForIdle();
    CHECK (st.getProperty ("state", {}).toString() == "failed");
    CHECK (st.getProperty ("error", {}).toString().contains ("GB free on this Mac"));
    CHECK (box.uvLog().isEmpty());
    CHECK_FALSE (paths.pythonDir.exists());
}

// Hidden: the real pinned uv and the real network, into a scratch home. Run by hand:
//   MOSH_AI_TOOLS_REAL_HOME=<empty dir> MoshTests "[.ai-tools-real]"
TEST_CASE ("AI tools installer: a real install with the pinned uv", "[.ai-tools-real]")
{
    const auto homePath = juce::SystemStats::getEnvironmentVariable ("MOSH_AI_TOOLS_REAL_HOME", {});
    const File uv = File (MOSH_SOURCE_DIR_STRING).getChildFile ("resources/uv/uv");
    if (! File::isAbsolutePath (homePath) || ! uv.existsAsFile())
    {
        WARN ("set MOSH_AI_TOOLS_REAL_HOME and run scripts/fetch-uv.sh");
        return;
    }
    const File home (homePath);
    mosh::AiToolsInstaller::Paths paths;
    paths.uv = uv;
    paths.serviceDir = File (MOSH_SOURCE_DIR_STRING).getChildFile ("service");
    paths.home = home;
    paths.pythonDir = home.getChildFile ("Library/Mosh/python");
    paths.venvsDir = home.getChildFile ("Library/Mosh/venvs");
    paths.envDir = home.getChildFile ("Library/Application Support/Mosh/ai-tools");
    paths.cacheDir = home.getChildFile ("Library/Caches/Mosh/uv");
    paths.logFile = home.getChildFile ("Library/Mosh/logs/ai-tools.log");

    mosh::AiToolsInstaller installer (paths);
    installer.install();
    installer.waitForIdle();
    INFO (paths.logFile.loadFileAsString().getLastCharacters (3000));
    REQUIRE (installer.status().getProperty ("state", {}).toString() == "done");
    CHECK_FALSE (paths.cacheDir.exists());
    CHECK_FALSE (paths.serviceDir.getChildFile ("sketch/.sketch.env").getLastModificationTime()
                 > juce::Time::getCurrentTime() - juce::RelativeTime::minutes (30));

    mosh::AiToolsProbeInputs in;
    in.home = home;
    in.env = [] (const char*) { return juce::String(); };
    in.xcodeSelectLink = home.getChildFile ("no-xcode-link");
    in.commandLineToolsPython = home.getChildFile ("no-clt/python3");
    const auto probe = mosh::probeAiTools (in);
    CHECK (probe.on());
    CHECK (probe.transcribe);
    CHECK (probe.pythonSource == "managed");

    installer.remove();
    installer.waitForIdle();
    CHECK_FALSE (paths.pythonDir.exists());
    CHECK_FALSE (paths.venvsDir.getChildFile ("sketch").exists());
    CHECK_FALSE (paths.venvsDir.getChildFile ("transcribe").exists());
}

TEST_CASE ("AI tools installer: remove deletes only what the installer created", "[ai-tools]")
{
    Box box;
    // The owner already had a transcription venv: setup-transcribe.sh validates it and
    // installs nothing, so the installer did not create it and must not delete it.
    box.healthyVenv ("transcribe");
    const auto ownerFile = box.venv ("transcribe").getChildFile ("owner.txt");
    ownerFile.replaceWithText ("mine");

    mosh::AiToolsInstaller installer (box.paths);
    installer.install();
    installer.waitForIdle();
    REQUIRE (installer.status().getProperty ("state", {}).toString() == "done");
    CHECK_FALSE (created (box).contains (box.venv ("transcribe").getFullPathName()));

    // A tampered manifest cannot point the delete anywhere else.
    const auto elsewhere = box.home().getChildFile ("Documents/song.mosh");
    elsewhere.getParentDirectory().createDirectory();
    elsewhere.replaceWithText ("keep");
    auto manifest = juce::JSON::parse (box.paths.envDir.getChildFile ("installed.json").loadFileAsString());
    manifest.getProperty ("created", {}).getArray()->add (elsewhere.getParentDirectory().getFullPathName());
    box.paths.envDir.getChildFile ("installed.json").replaceWithText (juce::JSON::toString (manifest));

    installer.remove();
    installer.waitForIdle();
    CHECK (installer.status().getProperty ("state", {}).toString() == "removed");
    CHECK_FALSE (box.paths.pythonDir.exists());
    CHECK_FALSE (box.venv ("sketch").exists());
    CHECK_FALSE (box.paths.envDir.exists());
    CHECK (ownerFile.existsAsFile());
    CHECK (elsewhere.existsAsFile());
    CHECK_FALSE (box.probe().python);
}
#endif
