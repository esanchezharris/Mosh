#pragma once

#include <memory>
#include <string>

// Torch-free interface to a RAVE model run via anira (Route C.2). The whole anira +
// LibTorch surface lives in RaveEngine.cpp ONLY — no torch headers leak into the JUCE/
// Tracktion translation units (RaveInsertPlugin includes just this header). This keeps
// the notorious LibTorch↔JUCE macro/symbol clashes contained to one TU and the audio
// engine torch-free. The whole thing is gated: with MOSH_HAVE_ANIRA undefined the
// methods are graceful no-ops (ready() stays false), so the default build is unaffected.

namespace mosh
{
class RaveEngine
{
public:
    RaveEngine();
    ~RaveEngine();

    // Message thread: set the host audio config. Cheap; safe to call repeatedly.
    void prepare (double sampleRate, int blockSize);

    // Message thread ONLY (allocates, builds the anira pipeline, runs warm-up
    // inferences). Returns true on success; on success ready() flips true and the
    // audio thread starts using the new model on its next process() (atomic swap;
    // the previous model is kept alive one swap so the audio thread never frees).
    bool loadModel (const std::string& tsPath);

    bool ready() const;
    int  latencySamples() const;        // anira's reported latency (for PDC)

    // Audio thread, RT-safe: transform `n` mono samples IN PLACE (model output is
    // latency-delayed by latencySamples()). No-op (leaves `mono` untouched) when not
    // ready — the caller handles dry passthrough.
    void process (float* mono, int n);

    void reset();                       // message thread: clear the pipeline state

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace mosh
