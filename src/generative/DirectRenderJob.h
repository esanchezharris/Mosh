#pragma once

#include "GenerativeJobManager.h"
#include <atomic>
#include <memory>

namespace mosh
{
// Engine-free work item. Its shared owner outlives a closing edit or application UI.
struct DirectRenderJob
{
    enum class Purpose { generation, decisionValidation };

    Purpose purpose = Purpose::generation;
    juce::File source, originalSource, directory, output, manifest;
    juce::String requestId, sourceHash, originalSourceHash, outputHash;
    juce::String expectedSourceHash, expectedOutputHash;
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

juce::Result createDirectSourceSnapshot (const juce::File& source, const juce::File& destination);
}
