#pragma once

#include "GenerativeJobManager.h"
#include <atomic>
#include <memory>

namespace mosh
{
// Engine-free work item. Its shared owner outlives a closing edit or application UI.
struct DirectRenderJob
{
    juce::File source, directory, output, manifest;
    juce::String requestId, sourceHash, outputHash;
    juce::var params;
    double sourceStart = 0, duration = 0;
    bool fixture = false;
    std::atomic<bool> cancelled { false }, finished { false };
    juce::CriticalSection lock;
    juce::String status = "queued", error, jobId;
    double progress = 0;

    void run (const std::shared_ptr<GenerativeJobManager>&);
    void publish (const juce::String& state, const juce::String& reason = {});
};
}
