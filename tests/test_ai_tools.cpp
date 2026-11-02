#include <catch2/catch_test_macros.hpp>
#include "generative/AiTools.h"
#include "generative/GenerativeJobManager.h"
#include "training/TrainingJobManager.h"
#include <cstdlib>
#include <map>
#include <string>

// Optional AI tools (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md). The probe decides from
// files alone whether a usable Python and the feature venvs exist, and the job managers
// refuse to spawn the Python service when they don't — so a Mac without the Command Line
// Tools never meets the "install developer tools" dialog.
namespace
{
    using juce::File;

    struct Sandbox
    {
        juce::TemporaryFile dir;
        File root() const { return dir.getFile(); }
        Sandbox() { root().createDirectory(); }
        ~Sandbox() { root().deleteRecursively(); }

        File touch (const juce::String& rel) const
        {
            auto f = root().getChildFile (rel);
            f.getParentDirectory().createDirectory();
            f.replaceWithText ("#!/bin/sh\n");
            return f;
        }
    };

    struct Probe
    {
        const Sandbox& box;
        std::map<std::string, juce::String> envVars;
        bool macStub = true;

        mosh::AiToolsStatus run() const
        {
            mosh::AiToolsProbeInputs in;
            in.home = box.root().getChildFile ("home");
            in.env = [this] (const char* k) {
                auto it = envVars.find (k);
                return it == envVars.end() ? juce::String() : it->second;
            };
            in.xcodeSelectLink = box.root().getChildFile ("var/db/xcode_select_link");
            in.commandLineToolsPython = box.root().getChildFile ("Library/Developer/CommandLineTools/usr/bin/python3");
            in.macStubPython = macStub;
            return mosh::probeAiTools (in);
        }
    };

    struct ScopedEnv
    {
        const char* key;
        juce::String prev;
        bool had = false;
        ScopedEnv (const char* k, const juce::String& v) : key (k)
        {
            if (auto* p = std::getenv (k)) { prev = p; had = true; }
            ::setenv (k, v.toRawUTF8(), 1);
        }
        ~ScopedEnv() { if (had) ::setenv (key, prev.toRawUTF8(), 1); else ::unsetenv (key); }
    };
}

TEST_CASE ("AI tools probe: a fresh Mac has nothing", "[aitools]")
{
    Sandbox box;
    const auto s = Probe { box }.run();
    CHECK_FALSE (s.python);      // no Xcode, no Command Line Tools: python3 is the stub
    CHECK_FALSE (s.sketch);
    CHECK_FALSE (s.transcribe);
    CHECK_FALSE (s.sa3);
    CHECK_FALSE (s.on());
    CHECK (s.toVar().getProperty ("state", {}).toString() == "off");
    CHECK (s.toVar().getProperty ("pack", {}).getProperty ("python", {}).toString() == "missing");
}

TEST_CASE ("AI tools probe: python sources, in run.sh's order", "[aitools]")
{
    Sandbox box;

    SECTION ("the Command Line Tools make /usr/bin/python3 real")
    {
        box.touch ("Library/Developer/CommandLineTools/usr/bin/python3");
        const auto s = Probe { box }.run();
        CHECK (s.python);
        CHECK (s.pythonSource == "clt");
    }
    SECTION ("so does Xcode, through the xcode-select link")
    {
        box.touch ("Xcode.app/Contents/Developer/usr/bin/python3");
        auto link = box.root().getChildFile ("var/db/xcode_select_link");
        link.getParentDirectory().createDirectory();
        REQUIRE (box.root().getChildFile ("Xcode.app/Contents/Developer").createSymbolicLink (link, true));
        const auto s = Probe { box }.run();
        CHECK (s.pythonSource == "xcode");
    }
    SECTION ("an xcode-select link to a dir without python3 is not enough")
    {
        box.root().getChildFile ("Empty.app/Contents/Developer").createDirectory();
        auto link = box.root().getChildFile ("var/db/xcode_select_link");
        link.getParentDirectory().createDirectory();
        REQUIRE (box.root().getChildFile ("Empty.app/Contents/Developer").createSymbolicLink (link, true));
        CHECK_FALSE (Probe { box }.run().python);
    }
    SECTION ("MOSH_SERVICE_PYTHON counts only when the file exists")
    {
        Probe p { box };
        p.envVars["MOSH_SERVICE_PYTHON"] = box.root().getChildFile ("nope/python").getFullPathName();
        CHECK_FALSE (p.run().python);
        p.envVars["MOSH_SERVICE_PYTHON"] = box.touch ("py/bin/python").getFullPathName();
        CHECK (p.run().pythonSource == "explicit");
    }
    SECTION ("the SA3 venv is a python and turns sa3 on, unless MOSH_ENABLE_SA3=0")
    {
        box.touch ("home/AI/stable-audio-3/optimized/mlx/.venv/bin/python");
        Probe p { box };
        auto s = p.run();
        CHECK (s.sa3);
        CHECK (s.pythonSource == "sa3");
        p.envVars["MOSH_ENABLE_SA3"] = "0";
        s = p.run();
        CHECK_FALSE (s.sa3);
        CHECK_FALSE (s.python);
    }
    SECTION ("SA3_MLX_DIR moves where the SA3 venv is looked for")
    {
        Probe p { box };
        p.envVars["SA3_MLX_DIR"] = box.root().getChildFile ("elsewhere").getFullPathName();
        box.touch ("elsewhere/.venv/bin/python");
        CHECK (p.run().sa3);
    }
    SECTION ("off macOS, python3 is never a stub")
    {
        Probe p { box };
        p.macStub = false;
        CHECK (p.run().pythonSource == "system");
    }
}

TEST_CASE ("AI tools probe: feature venvs follow server.py's lookup", "[aitools]")
{
    Sandbox box;
    box.touch ("Library/Developer/CommandLineTools/usr/bin/python3");
    Probe p { box };

    CHECK_FALSE (p.run().on());   // python alone is not "on": nothing a friend opted into

    box.touch ("home/Library/Mosh/venvs/sketch/bin/python");
    auto s = p.run();
    CHECK (s.sketch);
    CHECK (s.on());
    CHECK_FALSE (s.transcribe);   // transcription is optional inside the pack

    p.envVars["MOSH_VENVS_DIR"] = box.root().getChildFile ("venvs2").getFullPathName();
    CHECK_FALSE (p.run().sketch); // the explicit root replaces the default one
    box.touch ("venvs2/transcribe/bin/python");
    CHECK (p.run().transcribe);

    p.envVars["SKETCH_PY"] = box.touch ("custom/sketch-python").getFullPathName();
    CHECK (p.run().sketch);       // the feature's own pointer wins
}

TEST_CASE ("No usable python: the generative service is refused before any spawn", "[aitools][generative]")
{
    // A service script whose launcher leaves a marker when it runs. The refusal must mean
    // NO process ever started — the whole point is that the python3 stub never runs.
    Sandbox box;
    const auto marker = box.root().getChildFile ("spawned");
    box.touch ("svc/server.py");
    // "\n" line endings: JUCE's replaceWithText defaults to "\r\n", which makes bash
    // touch a file named "spawned\r" and the control below fail for the wrong reason.
    box.root().getChildFile ("svc/run.sh")
        .replaceWithText ("#!/bin/bash\ntouch " + marker.getFullPathName().quoted() + "\n", false, false, "\n");

    ScopedEnv script ("MOSH_SERVICE_SCRIPT", box.root().getChildFile ("svc/server.py").getFullPathName());
    ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
    ScopedEnv port ("MOSH_SERVICE_PORT", "59993");   // nothing listens: never healthy

    SECTION ("refused: no spawn, and callers get the AI-tools message")
    {
        mosh::GenerativeJobManager mgr;
        mgr.setAiToolsProbeForTesting ([] { return mosh::AiToolsStatus {}; });
        CHECK_FALSE (mgr.ensureServiceRunning());
        CHECK (mgr.refusedForMissingAiTools());
        CHECK (mgr.unavailableReason ("generative service unavailable") == mosh::kAiToolsMissingError);
        juce::Thread::sleep (300);
        CHECK_FALSE (marker.exists());
    }
    SECTION ("control: with python present the same setup does spawn (the marker appears)")
    {
        mosh::GenerativeJobManager mgr;
        mgr.setAiToolsProbeForTesting ([] { mosh::AiToolsStatus s; s.python = true; return s; });
        CHECK_FALSE (mgr.ensureServiceRunning());   // the fake launcher never serves /health
        CHECK_FALSE (mgr.refusedForMissingAiTools());
        CHECK (mgr.unavailableReason ("generative service unavailable") == "generative service unavailable");
        for (int i = 0; i < 50 && ! marker.exists(); ++i) juce::Thread::sleep (100);
        CHECK (marker.exists());
    }
    SECTION ("the training service is refused the same way")
    {
        mosh::TrainingJobManager mgr;
        mgr.setAiToolsProbeForTesting ([] { return mosh::AiToolsStatus {}; });
        CHECK_FALSE (mgr.ensureServiceRunning());
        CHECK (mgr.unavailableReason ("training service unavailable") == mosh::kAiToolsMissingError);
        juce::Thread::sleep (300);
        CHECK_FALSE (marker.exists());
    }
}
