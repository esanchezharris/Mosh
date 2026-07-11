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

    // AL-022 — diagnostics for a failed prepare()/loadModel(): both previously
    // swallowed any exception into a bare `false`/silent no-op with no way to
    // learn why (bad model file, tensor-shape mismatch, backend init failure,
    // etc). Additive: existing callers that never call this are unaffected.
    // Empty when the last prepare()/loadModel() succeeded (or none has run yet).
    // Always empty when built without anira (MOSH_HAVE_ANIRA off) — compiles and
    // returns a stable value in the default build so this is safe to call
    // unconditionally.
    std::string lastError() const;

    // Audio thread, RT-safe: transform `n` mono samples IN PLACE (model output is
    // latency-delayed by latencySamples()). No-op (leaves `mono` untouched) when not
    // ready — the caller handles dry passthrough.
    void process (float* mono, int n);

    // Switch anira between real-time (non-blocking; live playback) and non-real-time
    // (blocking; offline render) scheduling. In non-real-time mode process() awaits
    // every inference block, so a faster-than-real-time offline render never drops
    // samples (no "missing samples"/block-boundary gaps in the export). The reported
    // latency is UNCHANGED by the mode (anira's queue/timestamps are identical), so the
    // caller's dry/wet alignment stays valid. Cheap (sets one bool inside anira) — call
    // only on transition. No-op when not built with anira. A model loaded later inherits
    // the current mode.
    void setNonRealtime (bool nonRealtime);

    void reset();                       // message thread: clear the pipeline state

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace mosh
