#include "AiTools.h"

namespace mosh
{
using namespace juce;

namespace
{
    bool isFile (const File& f) { return f.existsAsFile(); }

    File fromEnv (const AiToolsProbeInputs& in, const char* key)
    {
        const auto v = in.env (key).trim();
        return File::isAbsolutePath (v) ? File (v) : File();
    }

    // service/server.py _venvs_root(): MOSH_VENVS_DIR wins, else ~/Library/Mosh/venvs.
    File venvsRoot (const AiToolsProbeInputs& in)
    {
        if (auto explicitRoot = fromEnv (in, "MOSH_VENVS_DIR"); explicitRoot != File())
            return explicitRoot;
        return in.home.getChildFile ("Library/Mosh/venvs");
    }

    // service/server.py _venv_py(): the feature's env pointer, else the conventional venv.
    bool venvPresent (const AiToolsProbeInputs& in, const char* pointerKey, const char* name)
    {
        if (auto pointer = fromEnv (in, pointerKey); pointer != File() && isFile (pointer))
            return true;
        return isFile (venvsRoot (in).getChildFile (name).getChildFile ("bin/python"));
    }

    // /usr/bin/python3 is a shim into the selected developer dir. It only runs a real
    // interpreter when that dir (Xcode or the Command Line Tools) ships one.
    String macDeveloperPython (const AiToolsProbeInputs& in)
    {
        if (in.xcodeSelectLink.isSymbolicLink() || in.xcodeSelectLink.exists())
        {
            const auto dev = in.xcodeSelectLink.getLinkedTarget();
            if (dev != in.xcodeSelectLink && isFile (dev.getChildFile ("usr/bin/python3")))
                return dev.getFullPathName().contains ("CommandLineTools") ? "clt" : "xcode";
        }
        return isFile (in.commandLineToolsPython) ? "clt" : String();
    }
}

var AiToolsStatus::toVar() const
{
    auto* pack = new DynamicObject();
    pack->setProperty ("python", python ? "ok" : "missing");
    pack->setProperty ("sketch", sketch ? "ok" : "missing");
    pack->setProperty ("transcribe", transcribe ? "ok" : "missing");

    auto* o = new DynamicObject();
    o->setProperty ("state", on() ? "on" : "off");
    o->setProperty ("pack", var (pack));
    o->setProperty ("sa3", sa3);
    o->setProperty ("pythonSource", pythonSource);
    return var (o);
}

AiToolsProbeInputs AiToolsProbeInputs::forThisMachine()
{
    AiToolsProbeInputs in;
    in.home = File::getSpecialLocation (File::userHomeDirectory);
    in.env = [] (const char* key) { return SystemStats::getEnvironmentVariable (key, {}); };
   #if ! JUCE_MAC
    in.macStubPython = false;
   #endif
    return in;
}

AiToolsStatus probeAiTools (const AiToolsProbeInputs& in)
{
    AiToolsStatus s;

    // service/run.sh: SA3_MLX_DIR (default ~/AI/stable-audio-3/optimized/mlx) and its
    // .venv carry the real model; MOSH_ENABLE_SA3=0 forces the fake adapter.
    auto sa3Dir = fromEnv (in, "SA3_MLX_DIR");
    if (sa3Dir == File())
        sa3Dir = in.home.getChildFile ("AI/stable-audio-3/optimized/mlx");
    const bool sa3Venv = isFile (sa3Dir.getChildFile (".venv/bin/python"));
    s.sa3 = sa3Venv && in.env ("MOSH_ENABLE_SA3").trim() != "0";

    if (auto explicitPython = fromEnv (in, "MOSH_SERVICE_PYTHON"); explicitPython != File() && isFile (explicitPython))
        s.pythonSource = "explicit";
    else if (s.sa3)
        s.pythonSource = "sa3";
    else if (! in.macStubPython)
        s.pythonSource = "system";
    else
        s.pythonSource = macDeveloperPython (in);
    s.python = s.pythonSource.isNotEmpty();

    s.sketch = venvPresent (in, "SKETCH_PY", "sketch");
    s.transcribe = venvPresent (in, "BASIC_PITCH_PY", "transcribe");
    return s;
}

AiToolsStatus probeAiTools()
{
    return probeAiTools (AiToolsProbeInputs::forThisMachine());
}
}
