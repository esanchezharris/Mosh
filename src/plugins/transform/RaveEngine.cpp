#include "RaveEngine.h"

#include <atomic>
#include <vector>

#if MOSH_HAVE_ANIRA
 #include <anira/anira.h>
#endif

// RAVE's standard export: a single mono tensor, 2048-sample block, in == out shape,
// with cached convolutions (so the processor is session-exclusive). Matches anira's
// own IRCAM RAVE example config (extras/models/third-party/ircam-acids).
namespace
{
    constexpr int kRaveBlock = 2048;
    constexpr float kRaveMaxInferenceMs = 42.66f;
    constexpr unsigned int kRaveWarmUp = 5;
}

namespace mosh
{

#if MOSH_HAVE_ANIRA

// One model's full anira pipeline. config + pp must outlive the handler, so they are
// owned together and swapped as a unit.
struct RavePipeline
{
    std::unique_ptr<anira::InferenceConfig> config;
    std::unique_ptr<anira::PrePostProcessor> pp;
    std::unique_ptr<anira::InferenceHandler> handler;
};

struct RaveEngine::Impl
{
    double sr = 44100.0;
    int    block = 512;
    bool   nonRealtime = false;   // current scheduling mode (a new model inherits it)

    std::unique_ptr<RavePipeline> activeOwned;   // current (audio thread reads via activePtr)
    std::unique_ptr<RavePipeline> retiredOwned;  // previous, kept alive one swap
    std::atomic<RavePipeline*> activePtr { nullptr };
    std::atomic<int>  latency { 0 };
    std::atomic<bool> isReady { false };

    std::unique_ptr<RavePipeline> build (const std::string& path)
    {
        auto p = std::make_unique<RavePipeline>();

        std::vector<anira::ModelData> modelData {
            { path, anira::InferenceBackend::LIBTORCH }
        };
        std::vector<anira::TensorShape> tensorShape {
            anira::TensorShape ({{ 1, 1, kRaveBlock }}, {{ 1, 1, kRaveBlock }})
        };
        anira::ProcessingSpec spec (
            { 1 },              // preprocess input channels
            { 1 },              // postprocess output channels
            { (size_t) kRaveBlock },
            { (size_t) kRaveBlock },
            { (size_t) kRaveBlock });   // internal model latency

        p->config  = std::make_unique<anira::InferenceConfig> (
            modelData, tensorShape, spec, kRaveMaxInferenceMs, kRaveWarmUp,
            /*session_exclusive_processor=*/ true);
        p->pp      = std::make_unique<anira::PrePostProcessor> (*p->config);
        p->handler = std::make_unique<anira::InferenceHandler> (*p->pp, *p->config);
        p->handler->prepare (anira::HostConfig ((float) block, (float) sr));
        p->handler->set_inference_backend (anira::InferenceBackend::LIBTORCH);
        p->handler->set_non_realtime (nonRealtime);   // inherit the current scheduling mode
        return p;
    }
};

RaveEngine::RaveEngine() : impl (std::make_unique<Impl>()) {}
RaveEngine::~RaveEngine() = default;

void RaveEngine::prepare (double sampleRate, int blockSize)
{
    impl->sr = sampleRate > 0 ? sampleRate : 44100.0;
    impl->block = blockSize > 0 ? blockSize : 512;
    // If a model is already loaded, re-prepare it for the new host config.
    if (impl->activePtr.load() != nullptr && impl->activeOwned)
    {
        try
        {
            impl->activeOwned->handler->prepare (anira::HostConfig ((float) impl->block, (float) impl->sr));
            impl->latency.store ((int) impl->activeOwned->handler->get_latency());
        }
        catch (...) {}
    }
}

bool RaveEngine::loadModel (const std::string& tsPath)
{
    try
    {
        auto next = impl->build (tsPath);
        const int lat = (int) next->handler->get_latency();
        // Publish: keep the OLD active alive one swap (retired) so the audio thread,
        // which may hold activePtr mid-block, never reads freed memory.
        impl->retiredOwned = std::move (impl->activeOwned);
        impl->activeOwned  = std::move (next);
        impl->latency.store (lat, std::memory_order_relaxed);
        impl->activePtr.store (impl->activeOwned.get(), std::memory_order_release);
        impl->isReady.store (true, std::memory_order_release);
        return true;
    }
    catch (...)
    {
        return false;   // bad model / shape mismatch / backend error → stay on the old one
    }
}

bool RaveEngine::ready() const            { return impl->isReady.load (std::memory_order_acquire); }
int  RaveEngine::latencySamples() const   { return impl->latency.load (std::memory_order_relaxed); }

void RaveEngine::process (float* mono, int n)
{
    auto* p = impl->activePtr.load (std::memory_order_acquire);
    if (p == nullptr || mono == nullptr || n <= 0)
        return;
    float* chans[1] = { mono };
    p->handler->process (chans, (size_t) n);   // RT-safe (anira); in-place, latency-delayed
}

void RaveEngine::setNonRealtime (bool nonRealtime)
{
    impl->nonRealtime = nonRealtime;
    if (auto* p = impl->activePtr.load (std::memory_order_acquire))
        if (p->handler)
            p->handler->set_non_realtime (nonRealtime);   // just sets a bool inside anira
}

void RaveEngine::reset()
{
    if (impl->activeOwned && impl->activeOwned->handler)
        impl->activeOwned->handler->reset();
}

#else  // ── MOSH_HAVE_ANIRA not built: graceful no-op stub ───────────────────────

struct RaveEngine::Impl {};
RaveEngine::RaveEngine() : impl (nullptr) {}
RaveEngine::~RaveEngine() = default;
void RaveEngine::prepare (double, int) {}
bool RaveEngine::loadModel (const std::string&) { return false; }
bool RaveEngine::ready() const { return false; }
int  RaveEngine::latencySamples() const { return 0; }
void RaveEngine::process (float*, int) {}
void RaveEngine::setNonRealtime (bool) {}
void RaveEngine::reset() {}

#endif

} // namespace mosh
