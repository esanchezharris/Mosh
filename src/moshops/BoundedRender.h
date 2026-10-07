#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include "RenderWatchdog.h"

namespace mosh
{
    // Runs a Tracktion offline render to completion on the calling (message) thread,
    // bounded by RenderWatchdog, and returns its error ("" on success). The one loop
    // behind export_audio, export_stems, export_clip_consolidated and every bounce.
    // Callers keep their own render-exclusivity setup (context teardown,
    // ScopedRenderStatus, turnOffAllPlugins) around it.
    inline juce::String runBoundedRender (const tracktion::engine::Renderer::Parameters& params,
                                          const juce::String& taskName,
                                          double renderSpanSeconds,
                                          const juce::String& stallMessage)
    {
        // Tracktion hands every block it writes, tail included, to this thumbnail feed,
        // which makes it the honest progress signal RenderWatchdog needs. Declared before
        // the task so it outlives it.
        struct WrittenSamples final : juce::AudioFormatWriter::ThreadedWriter::IncomingDataReceiver
        {
            std::int64_t written = 0;
            void reset (int, double, juce::int64) override { written = 0; }
            void addBlock (juce::int64 start, const juce::AudioBuffer<float>&, int, int numSamples) override
            {
                written = std::max<std::int64_t> (written, start + numSamples);
            }
        } samples;

        tracktion::engine::Renderer::RenderTask task (taskName, params, nullptr, &samples);
        RenderWatchdog watchdog (juce::Time::getMillisecondCounter(),
                                 RenderWatchdog::preRollCallAllowance (params.sampleRateForAudio,
                                                                       params.blockSizeForAudio),
                                 RenderWatchdog::deadlineMsFor (renderSpanSeconds));

        while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
        {
            const auto verdict = watchdog.afterCall (juce::Time::getMillisecondCounter(), samples.written);

            if (verdict == RenderWatchdog::Verdict::running)
                continue;

            if (task.errorMessage.isEmpty())
                task.errorMessage = verdict == RenderWatchdog::Verdict::stalled
                                      ? stallMessage
                                      : taskName + " did not finish within "
                                          + juce::String (RenderWatchdog::deadlineMsFor (renderSpanSeconds) / 1000)
                                          + " s";
            break;
        }

        return task.errorMessage;
    }
}
