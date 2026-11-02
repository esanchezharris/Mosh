#pragma once

#include <juce_core/juce_core.h>
#include <functional>

namespace mosh
{
/** Optional AI tools (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md).

    Mosh records without any of this. The generative service is Python, and on a Mac
    without the Command Line Tools /usr/bin/python3 is a stub that pops macOS's
    "install developer tools" dialog the moment anything runs it. So whether the
    tools are present is decided from FILES ONLY: this probe never runs python,
    never opens a socket, and is cheap enough to run on every snapshot.

    The probe mirrors how service/run.sh and service/server.py pick their
    interpreters, so "ok" here means the spawn would find a real Python:
      python     — MOSH_SERVICE_PYTHON, the SA3 MLX venv, or (macOS) a python3 that
                   Xcode or the Command Line Tools actually provide. Elsewhere,
                   system python is assumed (no stub exists there).
      sketch     — SKETCH_PY, else <venvs>/sketch/bin/python (Beatbox → beat).
      transcribe — BASIC_PITCH_PY, else <venvs>/transcribe/bin/python.
      sa3        — the SA3 MLX venv exists and MOSH_ENABLE_SA3 is not "0". Re-Imagine
                   and LoRA training need it; Mosh never installs it for anyone.
    state is "on" when python and sketch are both ok. */
struct AiToolsStatus
{
    bool python = false;
    bool sketch = false;
    bool transcribe = false;
    bool sa3 = false;
    juce::String pythonSource;    // "explicit" | "sa3" | "xcode" | "clt" | "system" | ""

    bool on() const noexcept { return python && sketch; }
    juce::var toVar() const;
};

/** Everything the probe reads, injectable so tests never depend on this Mac. */
struct AiToolsProbeInputs
{
    juce::File home;
    std::function<juce::String (const char*)> env;
    juce::File xcodeSelectLink { "/var/db/xcode_select_link" };
    juce::File commandLineToolsPython { "/Library/Developer/CommandLineTools/usr/bin/python3" };
    bool macStubPython = true;    // false where python3 is never a stub (Linux, Windows)

    static AiToolsProbeInputs forThisMachine();
};

AiToolsStatus probeAiTools (const AiToolsProbeInputs& in);

/** probeAiTools (AiToolsProbeInputs::forThisMachine()). */
AiToolsStatus probeAiTools();

/** The error a refused generative command carries when no usable Python exists. */
inline constexpr const char* kAiToolsMissingError =
    "AI tools aren't installed on this Mac. Recording and mixing work without them.";
}
